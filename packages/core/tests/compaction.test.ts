import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, chooseKeepBoundary, type CompletionClient } from '../src/agent.js';
import { SESSION_ROTATE_BYTES, Session, latestSessionFile, releaseSessionLock } from '../src/session.js';
import type { Observer, RuntimeTelemetryEvent } from '../src/telemetry.js';
import { estimateTokens, type AssistantMessage, type CompletionRequest, type Message, type StreamEvent, type Usage } from '@pi/ai';

function usage(input: number, output = 10): Usage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as Message;
}

test('chooseKeepBoundary picks a user message without tool results', () => {
  const messages: Message[] = [
    textMessage('user', 'a'.repeat(200_000)), // huge old turn
    textMessage('assistant', 'done'),
    textMessage('user', 'small follow-up'),
    { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }] },
    { role: 'user', content: [{ type: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] }] },
    textMessage('assistant', 'finished'),
  ];
  const boundary = chooseKeepBoundary(messages, 20_000);
  // index 2 is the earliest clean boundary whose tail fits; index 4 (tool results) must never be chosen
  assert.equal(boundary, 2);
});

test('chooseKeepBoundary falls back to the latest boundary for an oversized turn', () => {
  const messages: Message[] = [
    textMessage('user', 'old'),
    textMessage('assistant', 'old answer'),
    textMessage('user', 'x'.repeat(500_000)), // current turn alone exceeds the budget
  ];
  assert.equal(chooseKeepBoundary(messages, 20_000), 2);
});

test('chooseKeepBoundary stays linear on long transcripts', () => {
  const messages = Array.from({ length: 50_000 }, (_, index) =>
    textMessage(index % 2 === 0 ? 'user' : 'assistant', `message-${index}`),
  );
  const started = performance.now();
  const boundary = chooseKeepBoundary(messages, 20_000);
  const elapsed = performance.now() - started;
  assert.ok(boundary > 0 && boundary < messages.length);
  assert.ok(elapsed < 1_000, `boundary selection took ${elapsed.toFixed(1)}ms`);
});

test('agent auto-compacts when real usage crosses the threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-compact-'));
  const session = Session.create('/some/project', 'fake-model', dir);

  // scripted responses: turn 1 (reports huge context use), then the summarize call,
  // then turn 2's normal answer
  const responses: { text: string; usage: Usage }[] = [
    { text: 'first answer', usage: usage(90_000) },
    { text: 'SUMMARY-OF-EARLIER-WORK', usage: usage(100) },
    { text: 'second answer', usage: usage(500) },
  ];
  const requests: CompletionRequest[] = [];
  const telemetry: RuntimeTelemetryEvent[] = [];
  const observer: Observer = {
    async emit(event) {
      telemetry.push(event);
    },
    async flush() {},
    async close() {},
  };
  const fakeClient: CompletionClient = {
    // eslint-disable-next-line require-yield
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requests.push(request);
      const scripted = responses.shift();
      if (!scripted) throw new Error('no scripted response left');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: scripted.text }] };
      yield { type: 'text_delta', text: scripted.text };
      yield { type: 'done', message, stopReason: 'end_turn', usage: scripted.usage };
    },
  };

  const agent = new Agent({
    client: fakeClient,
    model: 'fake-model',
    systemPrompt: 'test',
    tools: [],
    cwd: '/some/project',
    session,
    observer,
    contextWindow: 100_000, // threshold = 100k - 16384; turn 1's 90k+10 crosses it
  });

  // a genuinely large first turn, so the keep-boundary lands after it
  for await (const _event of agent.run(`first input\n${'x'.repeat(120_000)}`)) {
    /* drain */
  }
  const events: string[] = [];
  for await (const event of agent.run('second input')) events.push(event.type);

  assert.ok(events.includes('compacted'), `expected a compacted event, got ${events.join(',')}`);
  // history was rewritten: summary message first, then the kept tail
  const first = agent.messages[0]!;
  assert.equal(first.role, 'user');
  assert.match((first.content[0] as { text: string }).text, /auto-compacted[\s\S]*SUMMARY-OF-EARLIER-WORK/);
  // The summary request sees only the dropped prefix, never the current turn that is retained verbatim.
  assert.match(JSON.stringify(requests[1]!.messages), /first input/);
  assert.doesNotMatch(JSON.stringify(requests[1]!.messages), /second input/);
  assert.match(JSON.stringify(requests[2]!.messages), /second input/);
  // the compacted state lives in a NEW session file; the original is untouched on disk
  assert.ok(agent.session);
  assert.notEqual(agent.session.file, session.file);
  const original = Session.open(session.file);
  assert.equal(original.messages[0]!.role, 'user');
  const compacted = Session.open(agent.session.file);
  assert.match((compacted.messages[0]!.content[0] as { text: string }).text, /SUMMARY-OF-EARLIER-WORK/);
  assert.equal(original.runStatus?.status, 'completed');
  assert.equal(compacted.runStatus?.status, 'completed');
  assert.ok(
    compacted.lifecycleEntries.some(
      (entry) => entry.t === 'run_status' && entry.status === 'running' && entry.reason?.includes(session.id),
    ),
  );
  assert.ok(
    compacted.lifecycleEntries.findIndex((entry) => entry.t === 'run_status' && entry.status === 'running') >= 0,
    'the child must be recoverably running before it becomes the committed continuation',
  );
  const lineageIndex = telemetry.findIndex((event) => event.kind === 'event' && event.name === 'session.lineage');
  assert.ok(lineageIndex >= 0);
  assert.ok(
    telemetry
      .slice(lineageIndex + 1)
      .some((event) => event.kind === 'span_started' && event.name === 'model.request' && event.sessionId === agent.session!.id),
    'requests after compaction must use the child session telemetry context',
  );
  const resumed = new Agent({
    client: fakeClient,
    model: 'fake-model',
    systemPrompt: 'test',
    tools: [],
    cwd: '/some/project',
    session: compacted,
    contextWindow: 100_000,
  });
  assert.deepEqual(resumed.usageTotal, agent.usageTotal, 'resume must carry provider usage across compaction lineage');
  // turn 2 was answered normally after compaction
  assert.equal(events.filter((type) => type === 'response_done').length, 1);
});

test('a billed but unusable compaction summary remains in turn and session usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-compact-usage-failure-'));
  const session = Session.create('/some/project', 'fake-model', dir);
  const responses: { message: AssistantMessage; stopReason: 'end_turn' | 'max_tokens'; usage: Usage }[] = [
    {
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      stopReason: 'end_turn',
      usage: usage(90_000),
    },
    {
      message: { role: 'assistant', content: [{ type: 'text', text: 'truncated summary' }] },
      stopReason: 'max_tokens',
      usage: usage(123, 17),
    },
  ];
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      const response = responses.shift();
      if (!response) throw new Error('unexpected request');
      yield { type: 'done', ...response };
    },
  };
  const agent = new Agent({
    client,
    model: 'fake-model',
    systemPrompt: 'test',
    tools: [],
    cwd: '/some/project',
    session,
    contextWindow: 100_000,
  });
  for await (const _event of agent.run(`first input\n${'x'.repeat(120_000)}`)) {
    /* drain */
  }
  await assert.rejects(async () => {
    for await (const _event of agent.run('second input')) {
      /* drain */
    }
  }, /summarizer stopped with max_tokens/);
  assert.deepEqual(agent.lastTurnUsage, usage(123, 17));
  assert.equal(agent.usageTotal.inputTokens, 90_123);
  assert.equal(Session.open(session.file).usage.inputTokens, 90_123);
});

test('context preflight refuses a fresh oversized turn before billing the provider', async () => {
  let requests = 0;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      requests++;
      throw new Error('provider must not be called');
    },
  };
  const agent = new Agent({ client, model: 'm', systemPrompt: 's', tools: [], cwd: '/tmp', contextWindow: 1_000 });
  const events = [];
  for await (const event of agent.run('x'.repeat(10_000))) events.push(event);
  const terminal = events.at(-1)!;
  assert.equal(terminal.type, 'turn_done');
  if (terminal.type === 'turn_done') {
    assert.equal(terminal.status, 'incomplete');
    assert.equal(terminal.reason, 'context_window');
  }
  assert.equal(requests, 0);
});

test('context preflight rechecks an oversized retained tail after compaction', async () => {
  const requests: CompletionRequest[] = [];
  const client: CompletionClient = {
    async *stream(request): AsyncGenerator<StreamEvent, void, void> {
      requests.push(request);
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'summary' }] };
      yield { type: 'done', message, stopReason: 'end_turn', usage: usage(20) };
    },
  };
  const agent = new Agent({ client, model: 'm', systemPrompt: 's', tools: [], cwd: '/tmp', contextWindow: 1_000 });
  agent.messages.push(textMessage('user', 'old'), textMessage('assistant', 'old answer'));
  const events = [];
  for await (const event of agent.run('x'.repeat(10_000))) events.push(event);
  const terminal = events.at(-1)!;
  assert.equal(terminal.type, 'turn_done');
  if (terminal.type === 'turn_done') {
    assert.equal(terminal.status, 'incomplete');
    assert.equal(terminal.reason, 'context_window');
  }
  assert.equal(requests.length, 0, 'an oversized retained tail must be rejected before a summary is billed');
});

test('summary truncation measures the final escaped request envelope', async () => {
  const requests: CompletionRequest[] = [];
  const client: CompletionClient = {
    async *stream(request): AsyncGenerator<StreamEvent, void, void> {
      requests.push(request);
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'bounded summary' }] };
      yield { type: 'done', message, stopReason: 'end_turn', usage: usage(10) };
    },
  };
  const agent = new Agent({ client, model: 'm', systemPrompt: 's', tools: [], cwd: '/tmp' });
  agent.messages.push(textMessage('user', '\\"'.repeat(350_000)));

  assert.equal(await agent.summarize(), 'bounded summary');
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  const projected = estimateTokens(
    JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }),
  );
  assert.ok(projected <= 96_000, `summary request projected ${projected} tokens`);
});

test('large journals rotate losslessly before reaching the recovery ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-session-rotation-'));
  const source = Session.create('/some/project', 'm', dir);
  source.setRunStatus('incomplete', 'padding'.repeat(Math.ceil(SESSION_ROTATE_BYTES / 7)));
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'done', message, stopReason: 'end_turn', usage: usage(5) };
    },
  };
  const agent = new Agent({ client, model: 'm', systemPrompt: 's', tools: [], cwd: '/some/project', session: source });
  const events: string[] = [];
  for await (const event of agent.run('continue')) events.push(event.type);

  assert.ok(events.includes('session_rotated'));
  assert.ok(agent.session);
  assert.notEqual(agent.session.file, source.file);
  assert.ok(statSync(agent.session.file).size < SESSION_ROTATE_BYTES);
  assert.equal(agent.session.lineage?.relation, 'continuation');
  assert.equal(agent.session.ready, true);
  const lifecycle = agent.session.lifecycleEntries;
  assert.ok(
    lifecycle.findIndex((entry) => entry.t === 'run_status' && entry.status === 'running') <
      lifecycle.findIndex((entry) => entry.t === 'session_ready'),
    'running must be durable before the continuation is published ready',
  );
  assert.equal(latestSessionFile(dir), agent.session.file);
  releaseSessionLock(agent.session.file);
});
