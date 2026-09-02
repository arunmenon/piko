import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { Observer, RuntimeTelemetryEvent } from '../src/telemetry.js';
import { workspaceDigestFor } from '../src/tools/bash.js';
import type { Tool } from '../src/tools/types.js';

const usage: Usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

test('agent journals model and tool lifecycles around execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-journal-'));
  const session = Session.create(dir, 'model', dir);
  let requestNumber = 0;
  const client: CompletionClient = {
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requestNumber++;
      const message: AssistantMessage =
        requestNumber === 1
          ? { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'safe', arguments: {} }] }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'done', message, stopReason: requestNumber === 1 ? 'tool_use' : 'end_turn', usage };
    },
  };
  let executions = 0;
  const telemetry: RuntimeTelemetryEvent[] = [];
  const observer: Observer = {
    async emit(event) {
      telemetry.push(event);
    },
    async flush() {},
    async close() {},
  };
  const tool: Tool = {
    name: 'safe',
    description: 'safe test tool',
    parameters: { type: 'object' },
    async execute() {
      executions++;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [tool], cwd: dir, session, observer });
  for await (const _event of agent.run('go')) {
    // drain
  }

  assert.equal(executions, 1);
  const reopened = Session.open(session.file);
  assert.equal(reopened.toolExecutions.length, 1);
  assert.equal(reopened.toolExecutions[0]?.status, 'completed');
  assert.equal(reopened.lifecycleEntries.filter((entry) => entry.t === 'model_request_completed').length, 2);
  assert.equal(reopened.runStatus?.status, 'completed');
  assert.ok(telemetry.some((event) => event.kind === 'span_started' && event.name === 'agent.run'));
  assert.equal(telemetry.filter((event) => event.kind === 'span_ended' && event.name === 'model.request').length, 2);
  assert.ok(telemetry.some((event) => event.kind === 'span_ended' && event.name === 'tool.execute'));
  assert.ok(telemetry.some((event) => event.kind === 'event' && event.name === 'run.status'));
});

test('tool side effects stop when model completion cannot be durably recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-completion-persist-'));
  const session = Session.create(dir, 'model', dir);
  session.completeModelRequest = () => {
    throw new Error('injected model completion fsync failure');
  };
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'danger-1', name: 'danger', arguments: {} }],
        },
        stopReason: 'tool_use',
        usage,
      };
    },
  };
  let executions = 0;
  const tool: Tool = {
    name: 'danger',
    description: 'observable side effect',
    parameters: { type: 'object', additionalProperties: false },
    async execute() {
      executions++;
      return { content: [{ type: 'text', text: 'ran' }] };
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [tool], cwd: dir, session });
  const events: AgentEvent[] = [];
  for await (const event of agent.run('go')) events.push(event);
  const terminal = events.at(-1)!;
  assert.equal(executions, 0);
  assert.equal(terminal.type, 'turn_done');
  if (terminal.type === 'turn_done') {
    assert.equal(terminal.status, 'incomplete');
    assert.equal(terminal.reason, 'persistence');
  }
});

test('a terminal run-status persistence failure overrides every apparent outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-terminal-persist-'));
  const session = Session.create(dir, 'model', dir);
  const setRunStatus = session.setRunStatus.bind(session);
  session.setRunStatus = (status, reason) => {
    if (status !== 'running') throw new Error('injected terminal run-status fsync failure');
    setRunStatus(status, reason);
  };
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield {
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'apparently done' }] },
        stopReason: 'end_turn',
        usage,
      };
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session });
  const events: AgentEvent[] = [];
  for await (const event of agent.run('go')) events.push(event);
  const terminal = events.at(-1)!;
  assert.equal(terminal.type, 'turn_done');
  if (terminal.type === 'turn_done') {
    assert.equal(terminal.status, 'incomplete');
    assert.equal(terminal.reason, 'persistence');
  }
});

test('resume marks a started side effect unknown and never claims it did not run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-resume-'));
  const session = Session.create(dir, 'model', dir);
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] };
  const call = { type: 'toolCall' as const, id: 'call-1', name: 'danger', arguments: {} };
  session.append({ t: 'msg', message: user });
  session.append({ t: 'msg', message: { role: 'assistant', content: [call] } });
  const executionId = session.planTool(call);
  session.startTool(executionId);

  session.close();
  const reopened = Session.openLocked(session.file)!;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      throw new Error('not called');
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session: reopened });
  assert.equal(reopened.toolExecutions[0]?.status, 'outcome_unknown');
  assert.match(JSON.stringify(agent.messages.at(-1)), /outcome is unknown/);
  assert.doesNotMatch(JSON.stringify(agent.messages.at(-1)), /never ran/);
});

test('resume records a planned but unstarted call as skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-skipped-'));
  const session = Session.create(dir, 'model', dir);
  const call = { type: 'toolCall' as const, id: 'call-1', name: 'danger', arguments: {} };
  session.append({ t: 'msg', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } });
  session.append({ t: 'msg', message: { role: 'assistant', content: [call] } });
  session.planTool(call);
  session.close();
  const reopened = Session.openLocked(session.file)!;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      throw new Error('not called');
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session: reopened });
  assert.equal(reopened.toolExecutions[0]?.status, 'skipped');
  assert.match(JSON.stringify(agent.messages.at(-1)), /did not run/);
});

test('resume marks an interrupted provider request and run outcome unknown/incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-request-resume-'));
  const session = Session.create(dir, 'model', dir);
  session.setRunStatus('running');
  const requestId = session.beginModelRequest('model', { messageCount: 1 });
  session.close();
  const reopened = Session.openLocked(session.file)!;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      throw new Error('not called');
    },
  };
  new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session: reopened });
  assert.equal(reopened.modelRequests.find((request) => request.requestId === requestId)?.status, 'outcome_unknown');
  assert.equal(reopened.runStatus?.status, 'incomplete');
  assert.match(reopened.runStatus?.reason ?? '', /prior process stopped/);

  const replayed = Session.open(session.file);
  new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session: replayed });
  assert.equal(
    replayed.lifecycleEntries.filter((entry) => entry.t === 'model_request_outcome_unknown').length,
    1,
  );
});

test('resume terminates an interrupted compaction before starting new work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-compaction-resume-'));
  const session = Session.create(dir, 'model', dir);
  const compactionId = session.beginCompaction('auto', { keepFromMessage: 2 });
  session.close();
  const reopened = Session.openLocked(session.file)!;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      throw new Error('not called');
    },
  };
  new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session: reopened });
  const terminal = reopened.lifecycleEntries.find(
    (entry) => entry.t === 'compaction_failed' && entry.compactionId === compactionId,
  );
  assert.ok(terminal?.t === 'compaction_failed');
  assert.match(terminal.error, /prior process stopped/);
});

test('returning from streamed text releases the provider and journals request outcome unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-stream-return-'));
  const session = Session.create(dir, 'model', dir);
  let released = false;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      try {
        yield { type: 'text_delta', text: 'partial' };
        await new Promise(() => {});
      } finally {
        released = true;
      }
    },
  };
  const iterator = new Agent({ client, model: 'model', systemPrompt: 's', tools: [], cwd: dir, session }).run('go');
  const first = await iterator.next();
  assert.equal(first.value?.type, 'text');
  await iterator.return();
  assert.equal(released, true);
  const reopened = Session.open(session.file);
  assert.equal(reopened.modelRequests[0]?.status, 'outcome_unknown');
  assert.equal(reopened.runStatus?.status, 'canceled');
});

test('returning at tool_start means dispatch occurred and is durably outcome-unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-agent-tool-return-'));
  const session = Session.create(dir, 'model', dir);
  let ran = 0;
  const tool: Tool = {
    name: 'side-effect',
    description: 'test dispatch',
    parameters: { type: 'object', additionalProperties: false },
    execute() {
      ran++;
      return new Promise(() => {});
    },
  };
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'side-1', name: tool.name, arguments: {} }],
        },
        stopReason: 'tool_use',
        usage,
      };
    },
  };
  const iterator = new Agent({ client, model: 'model', systemPrompt: 's', tools: [tool], cwd: dir, session }).run('go');
  let event = await iterator.next();
  while (!event.done && event.value.type !== 'tool_start') event = await iterator.next();
  assert.equal(event.value?.type, 'tool_start');
  assert.equal(ran, 1);
  await iterator.return();
  const reopened = Session.open(session.file);
  assert.equal(reopened.toolExecutions[0]?.status, 'outcome_unknown');
  assert.equal(reopened.runStatus?.status, 'canceled');
});

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('0007: the workspace digest fingerprints a checkout and is omitted elsewhere', { skip: !gitAvailable }, async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-workspace-digest-')));
  // Not a checkout: the digest is absent rather than fabricated.
  assert.equal(await workspaceDigestFor(workspace), undefined);

  execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' });
  const initial = await workspaceDigestFor(workspace);
  assert.ok(initial, 'a checkout produces a digest');
  assert.equal(initial.kind, 'git');
  assert.equal(initial.algorithm, 'sha256');
  assert.equal(initial.workspace, workspace);
  assert.match(initial.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await workspaceDigestFor(workspace), initial, 'an unchanged workspace digests identically');

  writeFileSync(join(workspace, 'appeared-after-planning.txt'), 'the workspace moved\n', 'utf8');
  const afterChange = await workspaceDigestFor(workspace);
  assert.ok(afterChange);
  assert.notEqual(afterChange.digest, initial.digest, 'a moved workspace digests differently');
});

test('0007: a bash call planned under an unknown outcome carries its workspace digest', { skip: !gitAvailable }, async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-bash-digest-')));
  execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' });
  writeFileSync(join(workspace, 'tracked.txt'), 'before\n', 'utf8');
  // The journal lives outside the checkout so writing it cannot itself move the
  // workspace the digest describes.
  const session = Session.create(workspace, 'model', mkdtempSync(join(tmpdir(), 'pi-bash-digest-journal-')));
  // Named 'bash' so the planner treats it as the side-effecting shell, without
  // running a host command inside the test.
  const tool: Tool = {
    name: 'bash',
    description: 'stand-in for host bash',
    parameters: { type: 'object' },
    execute() {
      return new Promise(() => {});
    },
  };
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: './deploy.sh' } }],
        },
        stopReason: 'tool_use',
        usage,
      };
    },
  };
  const expectedDigest = await workspaceDigestFor(workspace);
  assert.ok(expectedDigest);

  const iterator = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [tool],
    cwd: workspace,
    session,
  }).run('deploy');
  let event = await iterator.next();
  while (!event.done && event.value.type !== 'tool_start') event = await iterator.next();
  await iterator.return();

  const reopened = Session.open(session.file);
  const execution = reopened.toolExecutions[0];
  assert.equal(execution?.status, 'outcome_unknown');
  assert.deepEqual(execution?.workspaceDigest, expectedDigest, 'the planned row fingerprints the workspace as planned');

  // A resumer compares the recorded digest against what it sees now: a workspace
  // that moved while the outcome was unknown no longer matches what was planned.
  writeFileSync(join(workspace, 'written-while-the-outcome-was-unknown.txt'), 'moved\n', 'utf8');
  const currentDigest = await workspaceDigestFor(workspace);
  assert.notEqual(currentDigest?.digest, execution?.workspaceDigest?.digest);
});

test('0007: a non-bash call records no workspace digest', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-nonbash-digest-')));
  const session = Session.create(workspace, 'model', workspace);
  const tool: Tool = {
    name: 'safe',
    description: 'safe test tool',
    parameters: { type: 'object' },
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  let requestNumber = 0;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      requestNumber++;
      const message: AssistantMessage =
        requestNumber === 1
          ? { role: 'assistant', content: [{ type: 'toolCall', id: 'safe-1', name: 'safe', arguments: {} }] }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'done', message, stopReason: requestNumber === 1 ? 'tool_use' : 'end_turn', usage };
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [tool], cwd: workspace, session });
  for await (const _event of agent.run('go')) {
    // drain
  }
  assert.equal(Session.open(session.file).toolExecutions[0]?.workspaceDigest, undefined);
});
