import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type ApprovalDecisionInput, type CompletionClient } from '../src/agent.js';
import { JOURNAL_SCHEMA_VERSION } from '../src/journal.js';
import { Session, SessionCorruptionError } from '../src/session.js';
import type { Tool } from '../src/tools/types.js';

const usage: Usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };

function dir(name: string): string {
  return mkdtempSync(join(tmpdir(), `pi-${name}-`));
}

/** client driven by a decide() function so scripted behavior can react to the transcript */
function scriptedClient(decide: (request: CompletionRequest, call: number) => AssistantMessage): CompletionClient & {
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    // eslint-disable-next-line require-yield
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requests.push(request);
      const message = decide(request, requests.length);
      const stopReason = message.content.some((block) => block.type === 'toolCall') ? 'tool_use' : 'end_turn';
      yield { type: 'done', message, stopReason, usage };
    },
  };
}

const neverCalled: CompletionClient = {
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<StreamEvent, void, void> {
    throw new Error('the model must not be called while approvals are pending');
  },
};

interface RecordingTool extends Tool {
  readonly calls: Record<string, unknown>[];
}

function recordingTool(name: string): RecordingTool {
  const calls: Record<string, unknown>[] = [];
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      additionalProperties: false,
    },
    calls,
    async execute(args) {
      calls.push(args);
      return { content: [{ type: 'text', text: `${name} ran` }] };
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): AssistantMessage['content'][number] {
  return { type: 'toolCall', id, name, arguments: args };
}

async function drain(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function terminalOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'turn_done' }> {
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'turn_done');
  return terminal as Extract<AgentEvent, { type: 'turn_done' }>;
}

test('an unconfigured approval policy changes nothing: the gated-name tool just runs', async () => {
  const workspace = dir('approval-off');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient((_request, call) =>
    call === 1
      ? { role: 'assistant', content: [toolCall('c1', 'danger', { command: 'rm' })] }
      : { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  );
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [danger], cwd: workspace, session });
  const terminal = terminalOf(await drain(agent.run('go')));
  assert.equal(terminal.status, 'completed');
  assert.equal(danger.calls.length, 1);
  assert.equal(Session.open(session.file).awaitingApprovalExecutions.length, 0);
});

test('a gated call suspends the turn before dispatch and makes no further model request', async () => {
  const workspace = dir('approval-suspend');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'danger', { command: 'rm -rf /' })],
  }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
  });
  const events = await drain(agent.run('go'));
  const terminal = terminalOf(events);

  assert.equal(terminal.status, 'suspended');
  assert.equal(terminal.reason, 'awaiting_approval');
  assert.equal(danger.calls.length, 0, 'a gated call must not dispatch');
  assert.equal(client.requests.length, 1, 'no model request may follow a suspension');

  const required = events.find((event) => event.type === 'approval_required');
  assert.equal(required?.type, 'approval_required');
  if (required?.type === 'approval_required') {
    assert.equal(required.executions.length, 1);
    assert.equal(required.executions[0]?.call.name, 'danger');
  }

  const reopened = Session.open(session.file);
  assert.equal(reopened.toolExecutions[0]?.status, 'awaiting_approval');
  assert.equal(reopened.runStatus?.status, 'suspended');
  // The transcript still ends at the assistant tool_use: no fabricated results.
  assert.equal(agent.messages.at(-1)?.role, 'assistant');
});

test('ungated calls before the gate run in order; later calls stay planned', async () => {
  const workspace = dir('approval-order');
  const session = Session.create(workspace, 'model', workspace);
  const order: string[] = [];
  const before = recordingTool('before');
  const after = recordingTool('after');
  const danger = recordingTool('danger');
  for (const tool of [before, after, danger]) {
    const execute = tool.execute.bind(tool);
    tool.execute = async (args, context) => {
      order.push(tool.name);
      return execute(args, context);
    };
  }
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'before'), toolCall('c2', 'danger'), toolCall('c3', 'after')],
  }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [before, after, danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
  });
  const terminal = terminalOf(await drain(agent.run('go')));

  assert.equal(terminal.status, 'suspended');
  assert.deepEqual(order, ['before'], 'execution stops at the first gated call');
  const states = Session.open(session.file).toolExecutions;
  assert.equal(states.find((state) => state.call.id === 'c1')?.status, 'completed');
  assert.equal(states.find((state) => state.call.id === 'c2')?.status, 'awaiting_approval');
  assert.equal(states.find((state) => state.call.id === 'c3')?.status, 'planned');
});

test('journal rejects invalid approval transitions before appending anything', () => {
  const workspace = dir('approval-transitions');
  const session = Session.create(workspace, 'model', workspace);
  const call = { type: 'toolCall' as const, id: 'c1', name: 'danger', arguments: {} };
  const executionId = session.planTool(call);

  assert.throws(
    () => session.decideToolApproval(executionId, 'approved'),
    /cannot be decided from planned/,
  );
  session.requestToolApproval(executionId);
  assert.equal(Session.open(session.file).toolExecutions[0]?.status, 'awaiting_approval');

  assert.throws(() => session.requestToolApproval(executionId), /cannot request approval from awaiting_approval/);
  assert.throws(() => session.startTool(executionId), /cannot start from awaiting_approval/);
  assert.throws(() => session.decideToolApproval(executionId, 'approved', { editedArguments: { a: 1 } }), /edited/);

  session.decideToolApproval(executionId, 'approved');
  assert.throws(() => session.decideToolApproval(executionId, 'rejected'), /cannot be decided from planned/);

  const reopened = Session.open(session.file);
  const state = reopened.toolExecutions[0];
  assert.equal(state?.status, 'planned', 'an approved decision leaves the call cleared for dispatch');
  assert.equal(state?.approval?.decision, 'approved');
  // Every rejected transition threw before the row reached the file.
  assert.equal(reopened.lifecycleEntries.filter((entry) => entry.t === 'tool_approval_requested').length, 1);
  assert.equal(reopened.lifecycleEntries.filter((entry) => entry.t === 'tool_approval_decided').length, 1);
});

test('a rejection is terminal on its own and carries the human reason', () => {
  const workspace = dir('approval-reject-row');
  const session = Session.create(workspace, 'model', workspace);
  const executionId = session.planTool({ type: 'toolCall', id: 'c1', name: 'danger', arguments: {} });
  session.requestToolApproval(executionId);
  session.decideToolApproval(executionId, 'rejected', { reason: 'not on production' });
  const state = Session.open(session.file).toolExecutions[0];
  assert.equal(state?.status, 'skipped');
  assert.equal(state?.reason, 'not on production');
  assert.equal(state?.approval?.decision, 'rejected');
});

test('sessions written before the schema marker still parse; a newer generation is refused', () => {
  const workspace = dir('approval-schema');
  const legacy = join(workspace, `${randomUUID()}.jsonl`);
  const created = new Date().toISOString();
  writeFileSync(
    legacy,
    `${[
      JSON.stringify({ t: 'meta', v: 1, id: randomUUID(), cwd: workspace, model: 'model', created }),
      JSON.stringify({ t: 'msg', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ t: 'run_status', v: 2, at: created, status: 'completed' }),
    ].join('\n')}\n`,
    'utf8',
  );
  const opened = Session.open(legacy);
  assert.equal(opened.schemaVersion, 1);
  assert.equal(opened.messages.length, 1);
  assert.equal(opened.runStatus?.status, 'completed');

  const current = Session.create(workspace, 'model', workspace);
  assert.equal(current.schemaVersion, JOURNAL_SCHEMA_VERSION);

  const future = join(workspace, `${randomUUID()}.jsonl`);
  writeFileSync(
    future,
    `${[
      JSON.stringify({ t: 'meta', v: 1, id: randomUUID(), cwd: workspace, model: 'model', created }),
      JSON.stringify({ t: 'journal_schema', v: 2, at: created, schema: JOURNAL_SCHEMA_VERSION + 1 }),
    ].join('\n')}\n`,
    'utf8',
  );
  assert.throws(
    () => Session.open(future),
    (error: unknown) => error instanceof SessionCorruptionError && /newer than the supported version/.test(error.message),
  );
});

test('crash while awaiting approval: reopen keeps awaiting_approval and does not repair the batch', async () => {
  const workspace = dir('approval-crash');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const later = recordingTool('later');
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'danger'), toolCall('c2', 'later')],
  }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger, later],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
  });
  await drain(agent.run('go'));

  // A new process opens the same file: this is the crash-repair path.
  const reopened = Session.open(session.file);
  const resumedAgent = new Agent({
    client: neverCalled,
    model: 'model',
    systemPrompt: 's',
    tools: [danger, later],
    cwd: workspace,
    session: reopened,
    toolPolicy: { approval: ['danger'] },
  });

  const states = reopened.toolExecutions;
  assert.equal(states.find((state) => state.call.id === 'c1')?.status, 'awaiting_approval');
  assert.equal(states.find((state) => state.call.id === 'c2')?.status, 'planned');
  assert.equal(
    reopened.lifecycleEntries.filter((entry) => entry.t === 'tool_outcome_unknown' || entry.t === 'tool_skipped').length,
    0,
    'crash repair must not fire for a batch waiting on a decision',
  );
  assert.equal(resumedAgent.messages.at(-1)?.role, 'assistant', 'no synthesized results were appended');
  assert.equal(resumedAgent.suspended, true);
  assert.deepEqual(
    resumedAgent.pendingApprovals.map((item) => item.call.id),
    ['c1'],
  );
});

test('decided(approved) with no started row dispatches exactly once on resume', async () => {
  const workspace = dir('approval-decided-crash');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const call = { type: 'toolCall' as const, id: 'c1', name: 'danger', arguments: { command: 'deploy' } };
  session.append({ t: 'msg', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } });
  session.append({ t: 'msg', message: { role: 'assistant', content: [call] } });
  session.setRunStatus('running');
  const executionId = session.planTool(call);
  session.requestToolApproval(executionId);
  session.decideToolApproval(executionId, 'approved');
  session.setRunStatus('suspended', 'awaiting_approval');

  const reopened = Session.open(session.file);
  const client = scriptedClient(() => ({ role: 'assistant', content: [{ type: 'text', text: 'deployed' }] }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session: reopened,
    toolPolicy: { approval: ['danger'] },
  });
  assert.equal(agent.suspended, true);
  assert.deepEqual(agent.pendingApprovals, [], 'an already-decided call needs no new decision');

  const terminal = terminalOf(await drain(agent.resume()));
  assert.equal(terminal.status, 'completed');
  assert.equal(danger.calls.length, 1);
  assert.deepEqual(danger.calls[0], { command: 'deploy' });
  const settled = Session.open(session.file).toolExecutions[0];
  assert.equal(settled?.status, 'completed');
});

test('a started call with no terminal row is still outcome_unknown beside a pending approval', () => {
  const workspace = dir('approval-started-unknown');
  const session = Session.create(workspace, 'model', workspace);
  const started = { type: 'toolCall' as const, id: 'c1', name: 'danger', arguments: {} };
  const gated = { type: 'toolCall' as const, id: 'c2', name: 'danger', arguments: {} };
  session.append({ t: 'msg', message: { role: 'assistant', content: [started, gated] } });
  const startedId = session.planTool(started);
  const gatedId = session.planTool(gated);
  session.startTool(startedId);
  session.requestToolApproval(gatedId);

  const reopened = Session.open(session.file);
  new Agent({ client: neverCalled, model: 'model', systemPrompt: 's', tools: [], cwd: workspace, session: reopened });
  const states = reopened.toolExecutions;
  assert.equal(states.find((state) => state.executionId === startedId)?.status, 'outcome_unknown');
  assert.equal(states.find((state) => state.executionId === gatedId)?.status, 'awaiting_approval');
});

test('resume applies approve, edit, and reject and continues the turn', async () => {
  const workspace = dir('approval-decisions');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient((_request, call) =>
    call === 1
      ? {
          role: 'assistant',
          content: [
            toolCall('c1', 'danger', { command: 'one' }),
            toolCall('c2', 'danger', { command: 'two' }),
            toolCall('c3', 'danger', { command: 'three' }),
          ],
        }
      : { role: 'assistant', content: [{ type: 'text', text: 'all settled' }] },
  );
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: '*' },
  });
  await drain(agent.run('go'));
  const pending = agent.pendingApprovals;
  assert.equal(pending.length, 3, 'every gated call in the batch is requested at once');

  const decisions: ApprovalDecisionInput[] = [
    { executionId: pending[0]!.executionId, decision: 'approved' },
    { executionId: pending[1]!.executionId, decision: 'edited', editedArguments: { command: 'safer' } },
    { executionId: pending[2]!.executionId, decision: 'rejected', reason: 'too risky today' },
  ];
  const events = await drain(agent.resume(decisions));
  const terminal = terminalOf(events);

  assert.equal(terminal.status, 'completed');
  assert.deepEqual(danger.calls, [{ command: 'one' }, { command: 'safer' }]);
  assert.equal(events.filter((event) => event.type === 'approval_decided').length, 3);

  const results = agent.messages.find(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'toolResult'),
  );
  const rendered = JSON.stringify(results?.content ?? []);
  assert.match(rendered, /a human reviewer edited these arguments/);
  assert.match(rendered, /rejected this tool call: too risky today/);

  const states = Session.open(session.file).toolExecutions;
  assert.equal(states.find((state) => state.call.id === 'c1')?.status, 'completed');
  assert.equal(states.find((state) => state.call.id === 'c2')?.approval?.decision, 'edited');
  assert.deepEqual(states.find((state) => state.call.id === 'c2')?.call.arguments, { command: 'two' });
  assert.deepEqual(states.find((state) => state.call.id === 'c2')?.approval?.editedArguments, { command: 'safer' });
  assert.equal(states.find((state) => state.call.id === 'c3')?.status, 'skipped');
});

test('an edit with invalid arguments is refused before anything is journaled', async () => {
  const workspace = dir('approval-bad-edit');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({ role: 'assistant', content: [toolCall('c1', 'danger', { command: 'x' })] }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
  });
  await drain(agent.run('go'));
  const [pending] = agent.pendingApprovals;
  assert.ok(pending);

  await assert.rejects(
    () => drain(agent.resume([{ executionId: pending.executionId, decision: 'edited', editedArguments: { nope: 1 } }])),
    /additionalProperties|nope/,
  );
  await assert.rejects(
    () => drain(agent.resume([{ executionId: 'not-a-real-execution', decision: 'approved' }])),
    /no undecided approval/,
  );
  const reopened = Session.open(session.file);
  assert.equal(reopened.lifecycleEntries.filter((entry) => entry.t === 'tool_approval_decided').length, 0);
  assert.equal(reopened.toolExecutions[0]?.status, 'awaiting_approval');
  assert.equal(danger.calls.length, 0);
});

test('a partially decided batch runs in order and suspends again at the next undecided call', async () => {
  const workspace = dir('approval-partial');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'danger', { command: 'first' }), toolCall('c2', 'danger', { command: 'second' })],
  }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: '*' },
  });
  await drain(agent.run('go'));
  const pending = agent.pendingApprovals;
  assert.equal(pending.length, 2);

  // Decide only the second call: the first is still the gate, so nothing runs.
  const terminal = terminalOf(await drain(agent.resume([{ executionId: pending[1]!.executionId, decision: 'approved' }])));
  assert.equal(terminal.status, 'suspended');
  assert.equal(danger.calls.length, 0);
  assert.deepEqual(
    agent.pendingApprovals.map((item) => item.call.id),
    ['c1'],
  );
  const states = Session.open(session.file).toolExecutions;
  assert.equal(states.find((state) => state.call.id === 'c2')?.approval?.decision, 'approved');
  assert.equal(
    Session.open(session.file).lifecycleEntries.filter((entry) => entry.t === 'tool_approval_requested').length,
    2,
    'a re-suspension must not duplicate the approval request rows',
  );

  const finished = terminalOf(
    await drain(agent.resume([{ executionId: agent.pendingApprovals[0]!.executionId, decision: 'approved' }])),
  );
  assert.equal(finished.status, 'suspended');
  assert.deepEqual(danger.calls, [{ command: 'first' }, { command: 'second' }]);
});

test('tool-call budget accounting spans suspension and still wins on resume', async () => {
  const workspace = dir('approval-budget');
  const session = Session.create(workspace, 'model', workspace);
  const safe = recordingTool('safe');
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'safe'), toolCall('c2', 'danger'), toolCall('c3', 'safe')],
  }));
  const options = {
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [safe, danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
    budget: { maxToolCalls: 2 },
  };
  const agent = new Agent(options);
  assert.equal(terminalOf(await drain(agent.run('go'))).status, 'suspended');
  assert.equal(safe.calls.length, 1, 'one tool call was spent before the gate');

  const events = await drain(agent.resume([{ executionId: agent.pendingApprovals[0]!.executionId, decision: 'approved' }]));
  const terminal = terminalOf(events);
  assert.equal(danger.calls.length, 1, 'the approved call spends the second budgeted call');
  assert.equal(safe.calls.length, 1, 'the third call must not run: the budget was already spent');
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'tool_calls');
  assert.equal(terminal.toolCalls, 2, 'accounting continues from the suspended run rather than restarting');
});

test('token accounting carries across a suspension so a resumed run cannot exceed its ceiling', async () => {
  const workspace = dir('approval-token-budget');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({ role: 'assistant', content: [toolCall('c1', 'danger')] }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
    // The suspended request already reported 14 total tokens.
    budget: { maxTotalTokens: 20 },
  });
  assert.equal(terminalOf(await drain(agent.run('go'))).status, 'suspended');

  const terminal = terminalOf(
    await drain(agent.resume([{ executionId: agent.pendingApprovals[0]!.executionId, decision: 'approved' }])),
  );
  assert.equal(danger.calls.length, 1);
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'total_tokens');
});

test('a resumed run inherits the suspended ceilings and journals an explicit raise', async () => {
  const workspace = dir('approval-budget-raise');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  // Several agents and sessions share this client, so decide from the transcript
  // rather than a global request counter.
  const client = scriptedClient((request) =>
    JSON.stringify(request.messages).includes('toolResult')
      ? { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
      : { role: 'assistant', content: [toolCall('c1', 'danger')] },
  );
  const base = {
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    toolPolicy: { approval: ['danger'] },
  };
  const agent = new Agent({ ...base, session, budget: { maxToolCalls: 3 } });
  await drain(agent.run('go'));
  const suspendedRow = Session.open(session.file)
    .lifecycleEntries.filter((entry) => entry.t === 'run_status')
    .at(-1);
  assert.equal(suspendedRow?.t === 'run_status' && suspendedRow.status, 'suspended');
  assert.equal(suspendedRow?.t === 'run_status' && suspendedRow.budget?.maxToolCalls, 3);

  // A new process with no budget flags must not silently widen the ceiling.
  const reopened = Session.open(session.file);
  const inherited = new Agent({ ...base, session: reopened });
  await drain(inherited.resume([{ executionId: inherited.pendingApprovals[0]!.executionId, decision: 'approved' }]));
  const inheritedRow = Session.open(session.file)
    .lifecycleEntries.filter((entry) => entry.t === 'run_status')
    .find((entry) => entry.t === 'run_status' && entry.status === 'running' && entry.reason !== undefined);
  assert.equal(inheritedRow, undefined, 'no raise is journaled when no flag widened a ceiling');

  const raisedWorkspace = dir('approval-budget-raise-2');
  const raisedSession = Session.create(raisedWorkspace, 'model', raisedWorkspace);
  const raisedAgent = new Agent({ ...base, cwd: raisedWorkspace, session: raisedSession, budget: { maxToolCalls: 3 } });
  await drain(raisedAgent.run('go'));
  const widened = new Agent({
    ...base,
    cwd: raisedWorkspace,
    session: Session.open(raisedSession.file),
    budget: { maxToolCalls: 9 },
  });
  await drain(widened.resume([{ executionId: widened.pendingApprovals[0]!.executionId, decision: 'approved' }]));
  const raiseNote = Session.open(raisedSession.file)
    .lifecycleEntries.find((entry) => entry.t === 'run_status' && entry.reason?.startsWith('budget raised'));
  assert.ok(raiseNote?.t === 'run_status');
  assert.match(raiseNote.reason ?? '', /maxToolCalls 3->9/);
});

test('a cross-process resume reports honestly on results whose payload was never recorded', async () => {
  const workspace = dir('approval-cross-process');
  const session = Session.create(workspace, 'model', workspace);
  const safe = recordingTool('safe');
  const danger = recordingTool('danger');
  const client = scriptedClient((_request, call) =>
    call === 1
      ? { role: 'assistant', content: [toolCall('c1', 'safe'), toolCall('c2', 'danger')] }
      : { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  );
  const base = {
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [safe, danger],
    cwd: workspace,
    toolPolicy: { approval: ['danger'] },
  };
  await drain(new Agent({ ...base, session }).run('go'));
  assert.equal(safe.calls.length, 1);

  const resumed = new Agent({ ...base, session: Session.open(session.file) });
  const terminal = terminalOf(
    await drain(resumed.resume([{ executionId: resumed.pendingApprovals[0]!.executionId, decision: 'approved' }])),
  );
  assert.equal(terminal.status, 'completed');
  assert.equal(safe.calls.length, 1, 'a call that already ran is never dispatched twice');
  assert.equal(danger.calls.length, 1);
  const results = resumed.messages.find(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'toolResult'),
  );
  const blocks = (results?.content ?? []).filter((block) => block.type === 'toolResult');
  assert.equal(blocks.length, 2, 'every tool_use id gets exactly one result');
  assert.match(JSON.stringify(blocks[0]), /result payload was not recorded/);
});

test('an approval request that cannot be journaled fails closed instead of suspending', async () => {
  const workspace = dir('approval-persistence');
  const session = Session.create(workspace, 'model', workspace);
  session.requestToolApproval = () => {
    throw new Error('injected approval fsync failure');
  };
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({ role: 'assistant', content: [toolCall('c1', 'danger')] }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
  });
  const terminal = terminalOf(await drain(agent.run('go')));
  assert.equal(terminal.status, 'incomplete');
  assert.equal(terminal.reason, 'persistence');
  assert.equal(danger.calls.length, 0);
});

test('a suspended session refuses a second concurrent turn and reports its pending work', async () => {
  const workspace = dir('approval-appended');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({ role: 'assistant', content: [toolCall('c1', 'danger')] }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['danger'] },
  });
  await drain(agent.run('go'));
  assert.equal(agent.suspended, true);
  await assert.rejects(() => drain(agent.run('something else')), /tool approvals are pending/);

  const fresh = new Agent({
    client: neverCalled,
    model: 'model',
    systemPrompt: 's',
    tools: [danger],
    cwd: workspace,
    session: Session.open(session.file),
  });
  await assert.rejects(() => drain(fresh.resume([{ executionId: 'nope', decision: 'approved' }])), /no undecided approval/);

  // Journal integrity survives every rejected attempt above.
  const raw = readFileSync(session.file, 'utf8').trimEnd().split('\n');
  assert.ok(raw.every((line) => line.trim().length > 0));
  appendFileSync(session.file, '', 'utf8');
  assert.equal(Session.open(session.file).toolExecutions[0]?.status, 'awaiting_approval');
});
