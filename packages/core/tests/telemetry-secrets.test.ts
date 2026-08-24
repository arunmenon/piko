import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  credentialDescriptor,
  resolveProfile,
  type AssistantMessage,
  type CompletionRequest,
  type CredentialDescriptor,
  type StreamEvent,
  type Usage,
} from '@pi/ai';
import { Agent, type CompletionClient } from '../src/agent.js';
import { SafeObserver, isCredentialShapedName, type EventSink, type RuntimeTelemetryEvent } from '../src/telemetry.js';
import { bashTool } from '../src/tools/bash.js';
import {
  defaultToolExecutionPolicy,
  type Tool,
  type ToolContext,
  type ToolExecutionPolicy,
  type ToolPolicyObservation,
} from '../src/tools/types.js';

const usage: Usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

const finalMessage: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };

function endTurnClient(): CompletionClient {
  return {
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', message: finalMessage, stopReason: 'end_turn', usage };
    },
  };
}

/** First response calls the named tool; the second ends the turn. */
function toolThenEndClient(toolName: string, args: Record<string, unknown>): CompletionClient {
  let call = 0;
  return {
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      if (call++ === 0) {
        yield {
          type: 'done',
          message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: toolName, arguments: args }] },
          stopReason: 'tool_use',
          usage,
        };
        return;
      }
      yield { type: 'done', message: finalMessage, stopReason: 'end_turn', usage };
    },
  };
}

function collectingObserver(redact: boolean): { observer: SafeObserver; events: RuntimeTelemetryEvent[] } {
  const events: RuntimeTelemetryEvent[] = [];
  const sink: EventSink = {
    emit(event) {
      events.push(event);
    },
  };
  // Redaction off proves the value is absent by construction rather than scrubbed.
  return { observer: new SafeObserver(redact ? { sink } : { sink, redactors: [] }), events };
}

async function drain(agent: Agent): Promise<void> {
  for await (const _event of agent.run('go')) {
    // events are irrelevant here; the telemetry sink is what is under test
  }
}

function eventsNamed(events: RuntimeTelemetryEvent[], name: string): RuntimeTelemetryEvent[] {
  return events.filter((event) => event.kind === 'event' && event.name === name);
}

/** Always awaits the body: restoring the environment early would silently defeat these tests. */
async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  body: () => T | Promise<T>,
): Promise<T> {
  const original = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('credential.attach reports the environment variable name for both providers', async () => {
  const cases = [
    { provider: 'anthropic' as const, variable: 'PI_TEST_ANTHROPIC_KEY' },
    { provider: 'openai' as const, variable: 'PI_TEST_OPENAI_KEY' },
  ];
  for (const { provider, variable } of cases) {
    const profile = await withEnvironment({ [variable]: 'sk-test-value' }, () =>
      resolveProfile({ profiles: { work: { provider, model: 'm', apiKeyEnv: variable } } }, 'work'),
    );
    const { observer, events } = collectingObserver(true);
    await drain(
      new Agent({
        client: endTurnClient(),
        credential: credentialDescriptor(profile),
        model: 'm',
        systemPrompt: 's',
        tools: [],
        cwd: '/tmp',
        observer,
      }),
    );

    const attached = eventsNamed(events, 'credential.attach');
    assert.equal(attached.length, 1, `${provider} attaches one credential per request`);
    assert.deepEqual(attached[0]?.attributes, { provider, profile: 'work', source: variable });
    // The event correlates to the request it authenticated.
    const requestSpan = events.find((event) => event.kind === 'span_started' && event.name === 'model.request');
    assert.ok(attached[0]?.requestId);
    assert.equal(attached[0]?.requestId, requestSpan?.requestId);
  }
});

test('a keyless endpoint emits no credential.attach: nothing was attached', async () => {
  const profile = await withEnvironment({ PI_TEST_ABSENT_KEY: undefined }, () =>
    resolveProfile(
      {
        profiles: {
          local: { provider: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:8000/v1', apiKeyEnv: 'PI_TEST_ABSENT_KEY' },
        },
      },
      'local',
    ),
  );
  assert.equal(profile.apiKey, '');

  const { observer, events } = collectingObserver(true);
  await drain(
    new Agent({
      client: endTurnClient(),
      credential: credentialDescriptor(profile),
      model: 'm',
      systemPrompt: 's',
      tools: [],
      cwd: '/tmp',
      observer,
    }),
  );

  assert.equal(
    eventsNamed(events, 'credential.attach').length,
    0,
    'attach evidence must not be fabricated for keyless endpoints (review finding 15)',
  );
});

test('the credential value never reaches telemetry even with redaction disabled', async () => {
  const secret = 'sk-ant-test-DO-NOT-LEAK-0011223344';
  const profile = await withEnvironment({ PI_TEST_LEAK_KEY: secret }, () =>
    resolveProfile({ profiles: { work: { provider: 'anthropic', model: 'm', apiKeyEnv: 'PI_TEST_LEAK_KEY' } } }, 'work'),
  );
  assert.equal(profile.apiKey, secret, 'the profile really does hold the key that must not be observed');

  const { observer, events } = collectingObserver(false);
  await drain(
    new Agent({
      client: endTurnClient(),
      credential: credentialDescriptor(profile),
      model: 'm',
      systemPrompt: 's',
      tools: [],
      cwd: '/tmp',
      observer,
    }),
  );

  const serialized = JSON.stringify(events);
  assert.ok(events.length > 0);
  assert.ok(!serialized.includes(secret), 'no telemetry event carries the credential value');
  assert.ok(!serialized.includes('[REDACTED]'), 'and nothing had to be scrubbed to achieve that');
  assert.ok(serialized.includes('PI_TEST_LEAK_KEY'), 'the source name is still reported');
});

function observingContext(
  cwd: string,
  policy: ToolExecutionPolicy,
): ToolContext & { observations: ToolPolicyObservation[] } {
  const observations: ToolPolicyObservation[] = [];
  let dir = cwd;
  return {
    observations,
    get cwd() {
      return dir;
    },
    setCwd(next: string) {
      dir = next;
    },
    policy,
    observePolicy(observation) {
      observations.push(observation);
    },
  };
}

test('policy.env_sanitized reports the names bash withheld from the child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-env-telemetry-'));
  const context = observingContext(root, { ...defaultToolExecutionPolicy(root), bash: { allowHostExecution: true } });
  await withEnvironment({ PI_TEST_STRIPPED_TOKEN: 'must-not-reach-tool' }, async () => {
    await bashTool.execute({ command: 'true' }, context);
  });

  assert.equal(context.observations.length, 1);
  const observation = context.observations[0]!;
  assert.equal(observation.kind, 'environment_sanitized');
  assert.ok(observation.strippedNames.includes('PI_TEST_STRIPPED_TOKEN'));
  assert.equal(observation.strippedCount, observation.strippedNames.length);
  assert.equal(observation.allowlistSource, 'default');
  assert.ok(observation.allowlist.includes('PATH'));
  assert.ok(!observation.allowlist.includes('PI_TEST_STRIPPED_TOKEN'));
  assert.ok(
    !JSON.stringify(observation).includes('must-not-reach-tool'),
    'the observation carries names, never values',
  );
});

test('opting a variable in through policy removes it from the stripped names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-env-optin-'));
  const context = observingContext(root, {
    ...defaultToolExecutionPolicy(root),
    bash: { allowHostExecution: true, inheritEnvironment: ['PI_TEST_OPTED_IN'] },
  });
  await withEnvironment({ PI_TEST_OPTED_IN: 'granted', PI_TEST_STILL_STRIPPED: 'withheld' }, async () => {
    await bashTool.execute({ command: 'true' }, context);
  });

  const observation = context.observations[0]!;
  assert.ok(!observation.strippedNames.includes('PI_TEST_OPTED_IN'));
  assert.ok(observation.strippedNames.includes('PI_TEST_STILL_STRIPPED'));
  assert.equal(observation.allowlistSource, 'policy');
  assert.ok(observation.allowlist.includes('PI_TEST_OPTED_IN'));
});

test('policy.env_sanitized reaches the sink with the tool execution correlation ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-env-agent-'));
  const { observer, events } = collectingObserver(true);
  const agent = new Agent({
    client: toolThenEndClient('bash', { command: 'true' }),
    model: 'm',
    systemPrompt: 's',
    tools: [bashTool],
    cwd: root,
    toolPolicy: { workspaceRoot: root, bash: { allowHostExecution: true } },
    observer,
  });
  await withEnvironment(
    { PI_TEST_AGENT_SECRET: 'must-not-reach-tool', PI_TEST_PLAIN_VALUE: 'not-credential-shaped' },
    () => drain(agent),
  );

  const sanitized = eventsNamed(events, 'policy.env_sanitized');
  assert.equal(sanitized.length, 1);
  const attributes = sanitized[0]?.attributes as { credentialNames: string[]; strippedCount: number };
  // Names are scoped to credential-shaped variables; other stripped variables
  // are counted but never named (a full name list fingerprints the machine).
  assert.ok(attributes.credentialNames.includes('PI_TEST_AGENT_SECRET'));
  assert.ok(!attributes.credentialNames.includes('PI_TEST_PLAIN_VALUE'));
  assert.ok(attributes.strippedCount > attributes.credentialNames.length);
  assert.equal(sanitized[0]?.toolCallId, 'call-1');
  assert.ok(sanitized[0]?.toolExecutionId, 'the stripped environment is tied to one tool execution');
});

test('neither event is constructed when telemetry is disabled', async () => {
  // Field reads stand in for construction: the event builder cannot run without them.
  let descriptorFieldReads = 0;
  const descriptor: CredentialDescriptor = {
    get provider() {
      descriptorFieldReads++;
      return 'openai';
    },
    get profile() {
      descriptorFieldReads++;
      return 'work';
    },
    get source() {
      descriptorFieldReads++;
      return 'PI_TEST_OPENAI_KEY';
    },
  };

  const seenContexts: ToolContext[] = [];
  const probe: Tool = {
    name: 'probe',
    description: 'captures the context it was given',
    parameters: { type: 'object' },
    async execute(_args, context) {
      seenContexts.push(context);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const options = {
    client: toolThenEndClient('probe', {}),
    credential: descriptor,
    model: 'm',
    systemPrompt: 's',
    tools: [probe],
    cwd: '/tmp',
  };

  await drain(new Agent(options));
  assert.equal(descriptorFieldReads, 0, 'no credential.attach event was built');
  assert.equal(seenContexts[0]?.observePolicy, undefined, 'the tool has nowhere to report a stripped environment');

  const { observer, events } = collectingObserver(true);
  await drain(new Agent({ ...options, client: toolThenEndClient('probe', {}), observer }));
  assert.ok(descriptorFieldReads > 0, 'the same options do emit once an observer is attached');
  assert.equal(typeof seenContexts[1]?.observePolicy, 'function');
  assert.equal(eventsNamed(events, 'credential.attach').length, 2, 'one per provider request in the turn');
});

test('a timed-out observer operation disables telemetry only while wedged', async () => {
  const events: RuntimeTelemetryEvent[] = [];
  let releaseFirstEmit: (() => void) | undefined;
  let emits = 0;
  const sink: EventSink = {
    emit(event) {
      emits++;
      events.push(event);
      if (emits === 1) {
        // wedge the first operation past the (shortened) timeout
        return new Promise<void>((resolve) => {
          releaseFirstEmit = resolve;
        }) as unknown as void;
      }
    },
  };
  const observer = new SafeObserver({ sink });
  const agent = new Agent({
    client: endTurnClient(),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    observer,
    observerOperationTimeoutMs: 25,
  });
  await drain(agent); // first emit wedges; breaker trips; later events dropped
  const droppedCount = events.length;
  releaseFirstEmit?.(); // the slow operation finally settles: not wedged, re-enable
  await new Promise((resolve) => setTimeout(resolve, 10));
  await drain(agent);
  assert.ok(events.length > droppedCount, 'telemetry must resume once the slow operation settles');
});

test('credential-shaped matching requires delimited components, not bare substrings', () => {
  for (const benign of ['MONKEY', 'HOTKEY', 'DONKEY', 'TURNKEY_MODE', 'BROKERAGE']) {
    assert.equal(isCredentialShapedName(benign), false, `${benign} is a benign name and must not enter telemetry`);
  }
  for (const shaped of [
    'AWS_SECRET_ACCESS_KEY',
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'FOO_SECRET',
    'DB_PASSWORD',
    'X_KEY',
    'MY_CREDENTIALS',
  ]) {
    assert.equal(isCredentialShapedName(shaped), true, `${shaped} must be classified credential-shaped`);
  }
});

test('policy.env_sanitized carries exactly its contract attributes, redaction disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-env-exact-'));
  const { observer, events } = collectingObserver(false);
  const agent = new Agent({
    client: toolThenEndClient('bash', { command: 'true' }),
    model: 'm',
    systemPrompt: 's',
    tools: [bashTool],
    cwd: root,
    toolPolicy: { workspaceRoot: root, bash: { allowHostExecution: true } },
    observer,
  });
  await withEnvironment({ PI_TEST_EXACT_TOKEN: 'v1', PI_TEST_EXACT_PLAIN: 'v2' }, () => drain(agent));
  const sanitized = eventsNamed(events, 'policy.env_sanitized');
  assert.equal(sanitized.length, 1);
  const attributes = sanitized[0]?.attributes as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(attributes).sort(),
    ['allowlistCount', 'allowlistSource', 'credentialNames', 'strippedCount'],
    'the event may carry only its contract attributes; a full allowlist fingerprints the machine',
  );
  assert.equal(typeof attributes['allowlistCount'], 'number');
  assert.ok(!JSON.stringify(attributes).includes('PATH='), 'no environment values anywhere in the event');
});

test('apiKeyEnv rejects strings that are not environment variable names', () => {
  // '' is excluded: an empty value is falsy, falls back to the provider
  // default variable, and never reaches telemetry as a name.
  for (const hostile of ['not an env name: Bearer TOP_SECRET', 'lower_case', 'A'.repeat(200), 'X Y']) {
    assert.throws(
      () => resolveProfile({ profiles: { p: { provider: 'openai', model: 'm', apiKeyEnv: hostile } } }, 'p'),
      /apiKeyEnv/,
      `apiKeyEnv must reject: ${JSON.stringify(hostile)}`,
    );
  }
});
