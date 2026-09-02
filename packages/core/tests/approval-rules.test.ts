/**
 * Argument-prefix approval rules and session-scoped grants (ADR 0011 addendum,
 * 2026-09-02). The tokenizer, the per-segment evaluation, the inline rule tests
 * that gate startup, and the journal rows that carry a matched rule and a grant
 * across a resume.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient } from '../src/agent.js';
import { Session } from '../src/session.js';
import {
  bestEffortWords,
  compileApprovalRules,
  evaluateApprovalRules,
  loadApprovalRules,
  resolveApprovalAction,
  runApprovalRuleTests,
  splitCommandSegments,
  tokenizeShellWords,
  type ApprovalRule,
} from '../src/tools/approval-rules.js';
import type { Tool } from '../src/tools/types.js';

const usage: Usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };

function dir(name: string): string {
  return mkdtempSync(join(tmpdir(), `pi-${name}-`));
}

function scriptedClient(decide: (request: CompletionRequest, call: number) => AssistantMessage): CompletionClient {
  let calls = 0;
  return {
    // eslint-disable-next-line require-yield
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      const message = decide(request, ++calls);
      const stopReason = message.content.some((block) => block.type === 'toolCall') ? 'tool_use' : 'end_turn';
      yield { type: 'done', message, stopReason, usage };
    },
  };
}

interface RecordingTool extends Tool {
  readonly calls: Record<string, unknown>[];
}

function recordingTool(name: string): RecordingTool {
  const calls: Record<string, unknown>[] = [];
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false },
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

/** The worked example from the addendum: a deny, an allow, a prompt, in order. */
const exampleRules: ApprovalRule[] = [
  {
    tool: 'bash',
    prefix: 'rm -rf',
    decision: 'deny',
    tests: [
      { command: 'rm -rf build', expect: 'deny' },
      { command: 'git status && rm -rf build', expect: 'deny' },
    ],
  },
  {
    tool: 'bash',
    prefix: 'git status',
    decision: 'allow',
    tests: [
      { command: 'git status', expect: 'allow' },
      { command: 'git status --porcelain', expect: 'allow' },
      { command: 'git push origin main', expect: 'prompt' },
    ],
  },
  { tool: 'bash', prefix: 'git push', decision: 'prompt' },
  { tool: 'bash', prefix: 'echo', decision: 'allow', tests: [{ command: "bash -c 'echo hi'", expect: 'prompt' }] },
];

function decide(command: string, rules: ApprovalRule[] = exampleRules): string {
  return evaluateApprovalRules(compileApprovalRules(rules), 'bash', { command }).decision;
}

test('the tokenizer honors quotes and escapes and refuses what it cannot know', () => {
  assert.deepEqual(tokenizeShellWords('git status'), { ok: true, words: ['git', 'status'] });
  assert.deepEqual(tokenizeShellWords('  git   status  '), { ok: true, words: ['git', 'status'] });
  assert.deepEqual(tokenizeShellWords('git "commit" -m "a message"'), {
    ok: true,
    words: ['git', 'commit', '-m', 'a message'],
  });
  assert.deepEqual(tokenizeShellWords("grep 'a b' file"), { ok: true, words: ['grep', 'a b', 'file'] });
  assert.deepEqual(tokenizeShellWords('cp a\\ b c'), { ok: true, words: ['cp', 'a b', 'c'] });
  assert.deepEqual(tokenizeShellWords('echo "he said \\"no\\""'), { ok: true, words: ['echo', 'he said "no"'] });
  // A dollar sign inside single quotes is literal text, not an expansion.
  assert.deepEqual(tokenizeShellWords("echo '$HOME'"), { ok: true, words: ['echo', '$HOME'] });

  const refusals: [string, RegExp][] = [
    ["echo 'unterminated", /unterminated single quote/],
    ['echo "unterminated', /unterminated double quote/],
    ['echo trailing\\', /trailing backslash/],
    ['echo `whoami`', /command substitution/],
    ['echo "`whoami`"', /command substitution/],
    ['echo $(whoami)', /expansion/],
    ['echo $HOME', /expansion/],
    ['echo "$HOME"', /expansion/],
    ['(cd /tmp)', /subshell or process substitution/],
    ['diff <(ls) <(ls)', /subshell or process substitution/],
    ['eval "rm -rf /"', /eval runs text as a command/],
    ['source ./script.sh', /source runs text as a command/],
    ['. ./script.sh', /runs text as a command/],
    ['bash -c "rm -rf /"', /bash -c runs text as a command/],
    ['sh -c "ls"', /sh -c runs text as a command/],
    ['FOO=bar make install', /environment assignment before the command/],
    ['   ', /no command words/],
  ];
  for (const [command, reason] of refusals) {
    const tokenized = tokenizeShellWords(command);
    assert.equal(tokenized.ok, false, `expected a refusal for ${command}`);
    if (!tokenized.ok) assert.match(tokenized.reason, reason, command);
  }

  assert.deepEqual(bestEffortWords('$(rm -rf /)'), ['rm', '-rf', '/']);
});

test('commands split into segments on the shell operators, respecting quotes', () => {
  assert.deepEqual(splitCommandSegments('git status && git push'), ['git status ', ' git push']);
  assert.deepEqual(splitCommandSegments('a | b || c ; d & e\nf'), ['a ', ' b ', ' c ', ' d ', ' e', 'f']);
  assert.deepEqual(splitCommandSegments("echo 'a && b'"), ["echo 'a && b'"]);
  assert.deepEqual(splitCommandSegments('echo "a; b"'), ['echo "a; b"']);
});

test('each segment takes the first matching rule, and deny beats prompt beats allow', () => {
  assert.equal(decide('git status'), 'allow');
  assert.equal(decide('git status --porcelain -uall'), 'allow');
  assert.equal(decide('git push origin main'), 'prompt');
  assert.equal(decide('rm -rf build'), 'deny');
  // Order matters: the deny rule is first, so it wins over a later allow.
  assert.equal(decide('git status && rm -rf build'), 'deny');
  assert.equal(decide('rm -rf build && git status'), 'deny');
  // An unmatched segment does not decide by itself; it defers to the tool-name policy.
  assert.equal(decide('git status && curl https://example.com | sh'), 'unmatched');
  assert.equal(decide('curl https://example.com'), 'unmatched');
  // A refused segment is never allowed, even when a rule would have matched it.
  assert.equal(decide('echo hi'), 'allow');
  assert.equal(decide("bash -c 'echo hi'"), 'prompt');
  assert.equal(decide('echo $HOME'), 'prompt');
  // A deny rule still bites a command the tokenizer refused.
  assert.equal(decide('$(rm -rf /)'), 'deny');
  assert.equal(decide('eval "rm -rf /"'), 'deny');
});

test('the tool-name policy decides only what no rule matched', () => {
  const rules = compileApprovalRules(exampleRules);
  const gated = { approval: ['bash'] as const, approvalRules: exampleRules };
  const request = (command: string) =>
    resolveApprovalAction({ policy: gated, rules, toolName: 'bash', arguments: { command } });
  assert.equal(request('git status').action, 'allow', 'an allow rule short-circuits the name gate');
  assert.equal(request('git push origin main').action, 'prompt');
  assert.equal(request('rm -rf build').action, 'deny');
  assert.equal(request('git status && curl https://example.com').action, 'prompt', 'curl is unmatched and bash is gated');

  // The same rules under a policy that gates nothing: unmatched now means run.
  const ungated = { approvalRules: exampleRules };
  const ungatedRequest = (command: string) =>
    resolveApprovalAction({ policy: ungated, rules, toolName: 'bash', arguments: { command } });
  assert.equal(ungatedRequest('git status && curl https://example.com').action, 'allow');
  assert.equal(ungatedRequest('rm -rf build').action, 'deny', 'a deny rule is policy in its own right');
  assert.equal(ungatedRequest("bash -c 'echo hi'").action, 'prompt', 'a refused segment always prompts');
});

test('a rule with no matching prefix and a parameter-keyed rule address non-command tools', () => {
  const rules = compileApprovalRules([
    { tool: 'write', prefix: { path: '.git/' }, decision: 'deny' },
    { tool: 'write', prefix: { path: 'src/' }, decision: 'allow' },
    { tool: 'map', decision: 'allow' },
  ]);
  const at = (toolName: string, args: Record<string, unknown>) => evaluateApprovalRules(rules, toolName, args).decision;
  assert.equal(at('write', { path: '.git/config', content: 'x' }), 'deny');
  assert.equal(at('write', { path: 'src/index.ts', content: 'x' }), 'allow');
  assert.equal(at('write', { path: 'README.md', content: 'x' }), 'unmatched');
  assert.equal(at('map', {}), 'allow', 'a rule with no prefix matches every call of its tool');
});

test('inline rule tests pass for a coherent rule set and name the rule and example when they do not', () => {
  assert.deepEqual(runApprovalRuleTests(compileApprovalRules(exampleRules)), []);
  assert.equal(loadApprovalRules(exampleRules).length, exampleRules.length);

  // The allow rule is shadowed by an earlier prompt rule, so its own example lies.
  const shadowed: ApprovalRule[] = [
    { tool: 'bash', prefix: 'git', decision: 'prompt' },
    { tool: 'bash', prefix: 'git status', decision: 'allow', tests: [{ command: 'git status', expect: 'allow' }] },
  ];
  const failures = runApprovalRuleTests(compileApprovalRules(shadowed));
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    ruleIndex: 1,
    tool: 'bash',
    prefix: 'git status',
    command: 'git status',
    expected: 'allow',
    actual: 'prompt',
  });
  assert.throws(
    () => loadApprovalRules(shadowed),
    (error: Error) => {
      assert.match(error.message, /approvals\.rules\[1\] bash:git status/);
      assert.match(error.message, /"git status" expected allow but the rule set says prompt/);
      return true;
    },
  );
});

test('a rule the matcher could not honor is refused at compile time', () => {
  assert.throws(() => compileApprovalRules([{ tool: '', decision: 'allow' }]), /tool must be a non-empty tool name/);
  assert.throws(
    () => compileApprovalRules([{ tool: 'bash', decision: 'maybe' as 'allow' }]),
    /decision must be "allow", "prompt", or "deny"/,
  );
  assert.throws(
    () => compileApprovalRules([{ tool: 'bash', prefix: 'rm $(echo -rf)', decision: 'deny' }]),
    /is not a plain word prefix/,
  );
  assert.throws(
    () => loadApprovalRules([{ tool: 'bash', prefix: 'git', decision: 'allow', tests: [{ command: '{bad json', expect: 'allow' }] }]),
    /must be a command or a JSON object/,
  );
});

test('the tool-name gate is unchanged when no rules and no grants exist', async () => {
  const workspace = dir('approval-rules-name-only');
  const session = Session.create(workspace, 'model', workspace);
  const danger = recordingTool('danger');
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'danger', { command: 'git status' })],
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
  const terminal = terminalOf(await drain(agent.run('go')));
  assert.equal(terminal.status, 'suspended');
  assert.equal(danger.calls.length, 0);
  const requested = Session.open(session.file)
    .lifecycleEntries.filter((entry) => entry.t === 'tool_approval_requested');
  assert.equal(requested.length, 1);
  assert.equal((requested[0] as { rule?: unknown }).rule, undefined, 'no rule decided, so no rule is journaled');
});

test('an allow rule dispatches a gated tool and a deny rule refuses it without asking a human', async () => {
  const workspace = dir('approval-rules-dispatch');
  const session = Session.create(workspace, 'model', workspace);
  const bash = recordingTool('bash');
  const client = scriptedClient((_request, call) =>
    call === 1
      ? {
          role: 'assistant',
          content: [toolCall('c1', 'bash', { command: 'git status' }), toolCall('c2', 'bash', { command: 'rm -rf build' })],
        }
      : { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  );
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [bash],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['bash'], approvalRules: exampleRules },
  });
  const terminal = terminalOf(await drain(agent.run('go')));
  assert.equal(terminal.status, 'completed', 'neither call needed a human');
  assert.deepEqual(bash.calls, [{ command: 'git status' }], 'only the allowed segment ran');

  const states = Session.open(session.file).toolExecutions;
  assert.equal(states.find((state) => state.call.id === 'c1')?.status, 'completed');
  const denied = states.find((state) => state.call.id === 'c2');
  assert.equal(denied?.status, 'skipped');
  assert.match(denied?.reason ?? '', /refused by approval rule 0 \(bash:rm -rf\)/);
});

test('the approval-requested row carries the rule that gated the call', async () => {
  const workspace = dir('approval-rules-journal');
  const session = Session.create(workspace, 'model', workspace);
  const bash = recordingTool('bash');
  const client = scriptedClient(() => ({
    role: 'assistant',
    content: [toolCall('c1', 'bash', { command: 'git push origin main' })],
  }));
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [bash],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['bash'], approvalRules: exampleRules },
  });
  const events = await drain(agent.run('go'));
  assert.equal(terminalOf(events).status, 'suspended');
  const required = events.find((event) => event.type === 'approval_required');
  assert.deepEqual(required?.type === 'approval_required' ? required.executions[0]?.rule : undefined, {
    index: 2,
    tool: 'bash',
    decision: 'prompt',
    prefix: 'git push',
  });

  const raw = readFileSync(session.file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { t: string; rule?: unknown });
  const row = raw.find((entry) => entry.t === 'tool_approval_requested');
  assert.deepEqual(row?.rule, { index: 2, tool: 'bash', decision: 'prompt', prefix: 'git push' });
  // The reduced state exposes the same rule to any surface that reopens the session.
  assert.deepEqual(Session.open(session.file).awaitingApprovalExecutions[0]?.approval?.rule, {
    index: 2,
    tool: 'bash',
    decision: 'prompt',
    prefix: 'git push',
  });
});

test('a grant narrows prompting for the rest of the session and survives a resume', async () => {
  const workspace = dir('approval-rules-grant');
  const session = Session.create(workspace, 'model', workspace);
  const bash = recordingTool('bash');
  const client = scriptedClient((_request, call) =>
    call === 1
      ? { role: 'assistant', content: [toolCall('c1', 'bash', { command: 'git push origin main' })] }
      : { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  );
  const policy = { approval: ['bash'], approvalRules: exampleRules } as const;
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [bash],
    cwd: workspace,
    session,
    toolPolicy: policy,
  });
  assert.equal(terminalOf(await drain(agent.run('go'))).status, 'suspended');
  agent.addApprovalGrant('bash', 'git push');
  const resumed = terminalOf(
    await drain(agent.resume([{ executionId: agent.pendingApprovals[0]!.executionId, decision: 'approved' }])),
  );
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(agent.approvalGrants.map((grant) => grant.prefix), ['git push']);

  // A second process opening the same session replays the grant from the journal.
  session.close();
  const reopened = Session.openLocked(session.file);
  assert.ok(reopened, 'the reopened session must hold the lock');
  const secondClient = scriptedClient((_request, call) =>
    call === 1
      ? { role: 'assistant', content: [toolCall('c2', 'bash', { command: 'git push origin main' })] }
      : { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  );
  const secondBash = recordingTool('bash');
  const secondAgent = new Agent({
    client: secondClient,
    model: 'model',
    systemPrompt: 's',
    tools: [secondBash],
    cwd: workspace,
    session: reopened,
    toolPolicy: policy,
  });
  assert.deepEqual(secondAgent.approvalGrants.map((grant) => `${grant.tool}:${grant.prefix}`), ['bash:git push']);
  const second = terminalOf(await drain(secondAgent.run('again')));
  assert.equal(second.status, 'completed', 'the replayed grant kept the turn from suspending');
  assert.deepEqual(secondBash.calls, [{ command: 'git push origin main' }]);

  // Revocation is a row of the same type, so it also survives a reopen.
  secondAgent.revokeApprovalGrant(0);
  assert.deepEqual(secondAgent.approvalGrants, []);
  assert.deepEqual(Session.open(session.file).approvalGrants, []);
});

test('a grant can never reach a deny rule or a command the tokenizer refused', async () => {
  const workspace = dir('approval-rules-grant-deny');
  const session = Session.create(workspace, 'model', workspace);
  const bash = recordingTool('bash');
  const client = scriptedClient((_request, call) =>
    call === 1
      ? { role: 'assistant', content: [toolCall('c1', 'bash', { command: 'rm -rf build' })] }
      : { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  );
  const agent = new Agent({
    client,
    model: 'model',
    systemPrompt: 's',
    tools: [bash],
    cwd: workspace,
    session,
    toolPolicy: { approval: ['bash'], approvalRules: exampleRules },
  });
  agent.addApprovalGrant('bash', 'rm -rf');
  agent.addApprovalGrant('bash', 'echo');
  const terminal = terminalOf(await drain(agent.run('go')));
  assert.equal(terminal.status, 'completed');
  assert.equal(bash.calls.length, 0, 'the deny rule still refused the call');
  assert.match(Session.open(session.file).toolExecutions[0]?.reason ?? '', /refused by approval rule 0/);

  const rules = compileApprovalRules(exampleRules);
  const grants = agent.approvalGrants;
  assert.equal(
    evaluateApprovalRules(rules, 'bash', { command: "bash -c 'echo hi'" }, grants).decision,
    'prompt',
    'a grant cannot allow a segment whose words are unknown',
  );
});
