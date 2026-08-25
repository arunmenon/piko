import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { Observer, RuntimeTelemetryEvent } from '../src/telemetry.js';
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
