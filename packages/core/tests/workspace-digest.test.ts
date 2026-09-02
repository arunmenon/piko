import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, ToolCallBlock, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient, type RunBudget } from '../src/agent.js';
import { Session } from '../src/session.js';
import { bashTool } from '../src/tools/bash.js';
import type { Tool, ToolExecutionPolicy } from '../src/tools/types.js';

// R2 finding 1 (2026-09-02): the workspace digest used to run git for anything
// the model named "bash", before the harness knew the tool existed, before the
// tool-call budget, before approval, and before cancellation. `git status`
// honours repository configuration, and `core.fsmonitor` names a program git
// executes, so reading the workspace executed workspace-chosen code. These
// tests drive the real agent loop and watch for that program's marker.

const usage: Usage = { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A provider that answers the first request with `calls`, then ends the turn. */
function clientProposing(calls: readonly ToolCallBlock[]): CompletionClient {
  let requestNumber = 0;
  return {
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requestNumber++;
      const message: AssistantMessage =
        requestNumber === 1
          ? { role: 'assistant', content: [...calls] }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'done', message, stopReason: requestNumber === 1 ? 'tool_use' : 'end_turn', usage };
    },
  };
}

function bashCall(id: string, command: string): ToolCallBlock {
  return { type: 'toolCall', id, name: 'bash', arguments: { command } };
}

async function drain(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function temporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface FsmonitorWorkspace {
  /** A git checkout whose own config names an executable `core.fsmonitor` helper. */
  readonly workspace: string;
  /** Written by that helper, outside the checkout so it cannot move the digest. */
  readonly markerFile: string;
  /** Journal location, also outside the checkout. */
  readonly journalDir: string;
}

/**
 * Build the executed trigger from the review: a checkout that asks git to run a
 * program every time it reports status. Any `git status` honouring repository
 * configuration leaves the marker behind; a probe that disables `core.fsmonitor`
 * leaves nothing.
 */
function fsmonitorWorkspace(): FsmonitorWorkspace {
  const workspace = temporaryDirectory('pi-fsmonitor-');
  const outside = temporaryDirectory('pi-fsmonitor-helper-');
  const markerFile = join(outside, 'fsmonitor-ran.txt');
  const helperFile = join(outside, 'fsmonitor-helper.sh');
  writeFileSync(
    helperFile,
    `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(markerFile)}\nprintf '/\\0'\nexit 0\n`,
    'utf8',
  );
  chmodSync(helperFile, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' });
  writeFileSync(join(workspace, 'tracked.txt'), 'tracked\n', 'utf8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.fsmonitor', helperFile], { cwd: workspace, stdio: 'ignore' });
  return { workspace, markerFile, journalDir: temporaryDirectory('pi-fsmonitor-journal-') };
}

/**
 * Whether the installed git actually runs a configured fsmonitor helper on
 * `git status`. Where it does not, an absent marker would prove nothing and
 * these assertions would be vacuous, so they are skipped instead.
 */
const fsmonitorHelperRuns = (() => {
  if (!gitAvailable) return false;
  let probe: FsmonitorWorkspace;
  try {
    probe = fsmonitorWorkspace();
  } catch {
    return false;
  }
  try {
    execFileSync('git', ['status', '--porcelain=v1'], { cwd: probe.workspace, stdio: 'ignore' });
  } catch {
    // The helper's own exit status is not what is being measured.
  }
  return existsSync(probe.markerFile);
})();

interface Scenario {
  readonly tools: Tool[];
  readonly toolPolicy?: ToolExecutionPolicy;
  readonly budget?: Partial<RunBudget>;
  readonly calls: readonly ToolCallBlock[];
}

interface ScenarioResult {
  readonly fixture: FsmonitorWorkspace;
  readonly agent: Agent;
  readonly session: Session;
  readonly events: AgentEvent[];
}

/** Run one turn of the real agent loop against a fresh fsmonitor checkout. */
async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const fixture = fsmonitorWorkspace();
  const session = Session.create(fixture.workspace, 'model', fixture.journalDir);
  const agent = new Agent({
    client: clientProposing(scenario.calls),
    model: 'model',
    systemPrompt: 's',
    tools: scenario.tools,
    cwd: fixture.workspace,
    session,
    ...(scenario.toolPolicy ? { toolPolicy: scenario.toolPolicy } : {}),
    ...(scenario.budget ? { budget: scenario.budget } : {}),
  });
  const events = await drain(agent.run('go'));
  return { fixture, agent, session, events };
}

function startedRows(session: Session): { workspaceDigest?: unknown }[] {
  return Session.open(session.file)
    .lifecycleEntries.filter((entry) => entry.t === 'tool_started')
    .map((entry) => entry as unknown as { workspaceDigest?: unknown });
}

const hostBashPolicy: ToolExecutionPolicy = { bash: { allowHostExecution: true } };

test(
  'R2-1: a bash call the harness does not have never probes the workspace',
  { skip: !fsmonitorHelperRuns },
  async () => {
    const result = await runScenario({ tools: [], calls: [bashCall('call-1', 'echo hi')] });
    assert.equal(
      existsSync(result.fixture.markerFile),
      false,
      'a call naming an absent tool must start no git process',
    );
    assert.equal(startedRows(result.session).length, 0, 'an unknown tool never reaches a started row');
  },
);

test(
  'R2-1: a bash call refused by tool policy never probes the workspace',
  { skip: !fsmonitorHelperRuns },
  async () => {
    // The default policy is fail-closed: bash is present but host execution is off.
    const result = await runScenario({ tools: [bashTool], calls: [bashCall('call-1', 'touch must-not-run')] });
    assert.equal(existsSync(result.fixture.markerFile), false, 'a disabled shell must start no git process');
    assert.equal(existsSync(join(result.fixture.workspace, 'must-not-run')), false);
    const started = startedRows(result.session);
    assert.equal(started.length, 1, 'the call is still dispatched so the tool can refuse it');
    assert.equal(started[0]?.workspaceDigest, undefined, 'a disabled shell records no digest');
  },
);

test(
  'R2-1: a bash call rejected by argument validation never probes the workspace',
  { skip: !fsmonitorHelperRuns },
  async () => {
    const result = await runScenario({
      tools: [bashTool],
      toolPolicy: hostBashPolicy,
      // `command` is required, so this is refused before dispatch.
      calls: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
    });
    assert.equal(existsSync(result.fixture.markerFile), false, 'a rejected call must start no git process');
    assert.equal(startedRows(result.session).length, 0, 'a rejected call never reaches a started row');
  },
);

test(
  'R2-1: a gated bash call awaiting a decision never probes the workspace',
  { skip: !fsmonitorHelperRuns },
  async () => {
    const result = await runScenario({
      tools: [bashTool],
      toolPolicy: { bash: { allowHostExecution: true }, approval: ['bash'] },
      calls: [bashCall('call-1', 'printf gated')],
    });
    assert.ok(
      result.events.some((event) => event.type === 'approval_required'),
      'the turn suspends for a decision',
    );
    assert.equal(
      existsSync(result.fixture.markerFile),
      false,
      'an undecided call must start no git process while a human is still deciding',
    );
    assert.equal(startedRows(result.session).length, 0, 'an undecided call has no started row to carry a digest');
  },
);

test(
  'R2-1: bash calls beyond the tool-call budget never probe the workspace',
  { skip: !fsmonitorHelperRuns },
  async () => {
    const harmless: Tool = {
      name: 'harmless',
      description: 'consumes the tool-call budget without touching the workspace',
      parameters: { type: 'object' },
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const result = await runScenario({
      tools: [harmless, bashTool],
      toolPolicy: hostBashPolicy,
      budget: { maxToolCalls: 1 },
      calls: [
        { type: 'toolCall', id: 'call-1', name: 'harmless', arguments: {} },
        bashCall('call-2', 'printf over-budget'),
      ],
    });
    assert.equal(
      existsSync(result.fixture.markerFile),
      false,
      'a call the budget refuses must start no git process',
    );
    const started = startedRows(result.session);
    assert.equal(started.length, 1, 'only the in-budget call starts');
    assert.equal(started[0]?.workspaceDigest, undefined, 'the non-bash call records no digest');
  },
);

test(
  'R2-1: an approved dispatch fingerprints the workspace without running its fsmonitor helper',
  { skip: !fsmonitorHelperRuns },
  async () => {
    const fixture = fsmonitorWorkspace();
    const session = Session.create(fixture.workspace, 'model', fixture.journalDir);
    const agent = new Agent({
      client: clientProposing([bashCall('call-1', 'printf dispatched > dispatched.txt')]),
      model: 'model',
      systemPrompt: 's',
      tools: [bashTool],
      cwd: fixture.workspace,
      session,
      toolPolicy: { bash: { allowHostExecution: true }, approval: ['bash'] },
    });
    await drain(agent.run('go'));
    const [pending] = agent.pendingApprovals;
    assert.ok(pending, 'the gated call is waiting for a decision');
    await drain(agent.resume([{ executionId: pending.executionId, decision: 'approved' }]));

    assert.equal(
      readFileSync(join(fixture.workspace, 'dispatched.txt'), 'utf8'),
      'dispatched',
      'the approved command really ran',
    );
    const started = startedRows(session);
    assert.equal(started.length, 1);
    assert.ok(started[0]?.workspaceDigest, 'the approved dispatch did fingerprint the workspace');
    // The probe ran, and still nothing executed the helper: the digest disables
    // core.fsmonitor, core.hooksPath, and the system and global config sources.
    assert.equal(
      existsSync(fixture.markerFile),
      false,
      'the digest probe must not execute a program the workspace configured',
    );
  },
);

test(
  'R2-1: the marker is written when a dispatched command reads the workspace itself',
  { skip: !fsmonitorHelperRuns },
  async () => {
    // The control for every assertion above: the fixture really is a checkout
    // whose configuration executes a program on `git status`, so an absent
    // marker elsewhere means the probe did not read it, not that it could not.
    const result = await runScenario({
      tools: [bashTool],
      toolPolicy: hostBashPolicy,
      calls: [bashCall('call-1', 'git status --porcelain=v1 >/dev/null 2>&1; exit 0')],
    });
    assert.equal(
      existsSync(result.fixture.markerFile),
      true,
      'an approved command that runs git itself does execute the configured helper',
    );
  },
);

interface GitShim {
  readonly directory: string;
  readonly logFile: string;
}

/** Put a recording `git` ahead of the real one for both the probe and the shell. */
function recordingGitShim(): GitShim {
  const directory = temporaryDirectory('pi-git-shim-');
  const logFile = join(directory, 'git-invocations.log');
  const shim = join(directory, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexit 0\n`, 'utf8');
  chmodSync(shim, 0o755);
  return { directory, logFile };
}

function shimPolicy(shim: GitShim): ToolExecutionPolicy {
  return {
    bash: {
      allowHostExecution: true,
      environment: { PATH: `${shim.directory}:${process.env['PATH'] ?? ''}` },
    },
  };
}

function invocationsOf(shim: GitShim): string[] {
  if (!existsSync(shim.logFile)) return [];
  return readFileSync(shim.logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

test('R2-1: a batch of ten bash calls under a budget of two probes at most twice', async () => {
  const shim = recordingGitShim();
  const workspace = temporaryDirectory('pi-digest-budget-');
  const session = Session.create(workspace, 'model', temporaryDirectory('pi-digest-budget-journal-'));
  const calls = Array.from({ length: 10 }, (_unused, index) => bashCall(`call-${index}`, `printf ok-${index}`));
  const agent = new Agent({
    client: clientProposing(calls),
    model: 'model',
    systemPrompt: 's',
    tools: [bashTool],
    cwd: workspace,
    session,
    toolPolicy: shimPolicy(shim),
    budget: { maxToolCalls: 2 },
  });
  await drain(agent.run('go'));

  const statusProbes = invocationsOf(shim).filter((line) => line.includes(' status '));
  assert.equal(statusProbes.length, 2, 'one probe per dispatched call, not one per proposed call');
  assert.equal(startedRows(session).length, 2, 'the tool-call budget still bounds dispatch');
});

/** A `git` that hangs and leaves a background descendant behind. */
function hangingGitShim(): { directory: string; pidFile: string } {
  const directory = temporaryDirectory('pi-git-slow-');
  const pidFile = join(directory, 'git-pids.txt');
  const shim = join(directory, 'git');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$$" >> ${JSON.stringify(pidFile)}`,
      'sleep 30 &',
      `printf '%s\\n' "$!" >> ${JSON.stringify(pidFile)}`,
      'sleep 30',
    ].join('\n') + '\n',
    'utf8',
  );
  chmodSync(shim, 0o755);
  return { directory, pidFile };
}

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(processIds: readonly number[], withinMs: number): Promise<number[]> {
  const giveUpAt = Date.now() + withinMs;
  let alive = processIds.filter(processAlive);
  while (alive.length > 0 && Date.now() < giveUpAt) {
    await new Promise((wake) => setTimeout(wake, 25));
    alive = alive.filter(processAlive);
  }
  return alive;
}

test('R2-1: a hanging git cannot outlast the turn deadline or leave descendants behind', async () => {
  const shim = hangingGitShim();
  const workspace = temporaryDirectory('pi-digest-deadline-');
  const session = Session.create(workspace, 'model', temporaryDirectory('pi-digest-deadline-journal-'));
  // The first process this test process ever spawns pays a one-off loader cost
  // that has nothing to do with the deadline under test. Pay it up front so the
  // measured window contains only the probe.
  execFileSync('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  const maxWallTimeMs = 1_000;
  const agent = new Agent({
    client: clientProposing([bashCall('call-1', 'printf ok')]),
    model: 'model',
    systemPrompt: 's',
    tools: [bashTool],
    cwd: workspace,
    session,
    toolPolicy: {
      bash: {
        allowHostExecution: true,
        environment: { PATH: `${shim.directory}:${process.env['PATH'] ?? ''}` },
      },
    },
    budget: { maxWallTimeMs },
  });

  const startedAt = Date.now();
  await drain(agent.run('go'));
  const elapsedMs = Date.now() - startedAt;

  const probePids = existsSync(shim.pidFile)
    ? readFileSync(shim.pidFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => Number(line.trim()))
        .filter((processId) => Number.isSafeInteger(processId) && processId > 0)
    : [];
  const survivors = await waitForExit(probePids, 2_000);
  for (const processId of survivors) {
    try {
      process.kill(processId, 'SIGKILL');
    } catch {
      // best effort cleanup for a failing assertion below
    }
  }

  assert.ok(probePids.length >= 2, 'the hanging git and its background child both announced themselves');
  assert.deepEqual(survivors, [], 'the probe kills its whole process group, leaving no descendant');
  // Before the fix this took about 2,006ms against a 20ms budget, because the
  // probe owned its own 2 second deadline and ignored the turn's. The margin
  // stays below WORKSPACE_DIGEST_TIMEOUT_MS so a probe that reverted to its own
  // budget fails here.
  assert.ok(
    elapsedMs < maxWallTimeMs + 700,
    `the turn ended in ${elapsedMs}ms, outside its ${maxWallTimeMs}ms wall budget plus margin`,
  );
  assert.equal(startedRows(session)[0]?.workspaceDigest, undefined, 'an abandoned probe records no digest');
});
