import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Session, recoverStaleLock, type SessionView } from '@pi/core';
import { parseArgs } from '../src/args.js';
import { spawnCli, startFakeProvider, startToolCallProvider, type RunningCli } from './fake-provider.js';

const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');

/**
 * Extension tools whose settling behavior is the whole point of ADR 0027: one
 * that finishes when the test lets it, one that never reports a terminal
 * result, one that blocks the event loop so no in-process timer can fire, and
 * one that signals its own process between operations.
 */
const SHUTDOWN_EXTENSION = `import { existsSync, writeFileSync } from 'node:fs';

const announceStart = () => {
  const marker = process.env.PI_STARTED_MARKER;
  if (marker) writeFileSync(marker, 'started');
};

const emptyParameters = { type: 'object', properties: {}, additionalProperties: false };

export default [
  {
    name: 'wait_for_release',
    description: 'Runs until the test drops a release file, so a drain has real in-flight work.',
    parameters: emptyParameters,
    async execute(_input, context) {
      announceStart();
      const release = process.env.PI_RELEASE_MARKER;
      while (!existsSync(release)) {
        if (context && context.signal && context.signal.aborted) {
          throw new Error('canceled while waiting for the release file');
        }
        await new Promise((settle) => setTimeout(settle, 20));
      }
      return { content: [{ type: 'text', text: 'released' }] };
    },
  },
  {
    name: 'never_settles',
    description: 'Dispatches and never reports a terminal result, so only a deadline can end it.',
    parameters: emptyParameters,
    async execute() {
      announceStart();
      await new Promise((settle) => {
        const timer = setTimeout(settle, 3_600_000);
        timer.unref();
      });
      return { content: [{ type: 'text', text: 'unreachable' }] };
    },
  },
  {
    name: 'block_event_loop',
    description: 'Busy-loops synchronously, so no timer in this process can ever fire again.',
    parameters: emptyParameters,
    async execute() {
      announceStart();
      for (;;) {
        /* the event loop never turns again; only SIGKILL ends this */
      }
    },
  },
  {
    name: 'signal_self',
    description: 'Sends SIGTERM to its own process and returns at once.',
    parameters: emptyParameters,
    async execute() {
      announceStart();
      process.kill(process.pid, 'SIGTERM');
      return { content: [{ type: 'text', text: 'signaled' }] };
    },
  },
];
`;

interface Fixture {
  workspace: string;
  sessionFile: string;
  extensionPath: string;
  startedMarker: string;
  releaseMarker: string;
}

function fixture(name: string): Fixture {
  const workspace = mkdtempSync(join(tmpdir(), `pi-shutdown-${name}-`));
  const created = Session.create(workspace, 'fake-model', workspace);
  const sessionFile = created.file;
  created.close(); // the spawned pi must be able to take the lock (0023)
  const extensionPath = join(workspace, 'shutdown-tools.mjs');
  writeFileSync(extensionPath, SHUTDOWN_EXTENSION, 'utf8');
  return {
    workspace,
    sessionFile,
    extensionPath,
    startedMarker: join(workspace, 'tool-started'),
    releaseMarker: join(workspace, 'tool-release'),
  };
}

/** A hermetic environment: no ambient credentials, config, sessions, or nesting depth. */
function environmentFor(item: Fixture, providerUrl: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment['PI_DEPTH'];
  return {
    ...environment,
    HOME: item.workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: providerUrl,
    PI_STARTED_MARKER: item.startedMarker,
    PI_RELEASE_MARKER: item.releaseMarker,
  };
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Wait for the tool to be dispatched, then deliver the signal the test is about. */
async function signalOnceDispatched(run: RunningCli, item: Fixture, signalName: NodeJS.Signals): Promise<void> {
  await waitFor(() => existsSync(item.startedMarker), `the tool to start (${signalName})`);
  run.child.kill(signalName);
}

function reopen(sessionFile: string): SessionView {
  return Session.open(sessionFile);
}

function unknownRowTypes(sessionFile: string): string[] {
  return readFileSync(sessionFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { t: string }).t)
    .filter((type) => type === 'tool_outcome_unknown' || type === 'model_request_outcome_unknown');
}

function terminalDrainPath(stdout: string): string | undefined {
  for (const line of stdout.trim().split('\n')) {
    const row = JSON.parse(line) as { drain?: string; event?: { type: string } };
    if (row.event?.type === 'turn_done') return row.drain;
  }
  return undefined;
}

test('parseArgs carries the shutdown grace period and the supervisor flag', () => {
  const args = parseArgs(['-p', '--shutdown-grace', '3', '--supervise', 'go']);
  assert.equal(args.shutdownGraceSeconds, 3);
  assert.equal(args.supervise, true);
  assert.equal(parseArgs(['-p', 'go']).shutdownGraceSeconds, undefined, 'config decides when the flag is absent');
  assert.equal(parseArgs(['-p', 'go']).supervise, false);
  assert.equal(parseArgs(['-p', '--shutdown-grace', '0', 'go']).shutdownGraceSeconds, 0, 'zero grace is legal');
  assert.throws(() => parseArgs(['-p', '--shutdown-grace', '-1', 'go']), />= 0/);
  assert.throws(() => parseArgs(['-p', '--shutdown-grace', '2147484', 'go']), /too large/);
  assert.throws(() => parseArgs(['--supervise', 'go']), /headless runs/);
});

test('a cooperative drain lets an in-flight tool settle: canceled, no unknown rows, exit 143', async () => {
  const item = fixture('cooperative');
  const provider = await startToolCallProvider({ tool: 'wait_for_release' });
  try {
    const run = spawnCli(
      [
        cli,
        '--json',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        item.sessionFile,
        '--ext',
        item.extensionPath,
        '--shutdown-grace',
        '30',
        'call the tool',
      ],
      { cwd: item.workspace, env: environmentFor(item, provider.url) },
    );
    await signalOnceDispatched(run, item, 'SIGTERM');
    // Give the drain time to stop admission while the tool is still running,
    // then let the tool reach its own terminal result inside the grace period.
    await delay(300);
    writeFileSync(item.releaseMarker, 'go', 'utf8');
    const result = await run.result;

    assert.equal(result.status, 143, JSON.stringify(result));
    assert.equal(terminalDrainPath(result.stdout), 'cooperative', result.stdout);

    const session = reopen(item.sessionFile);
    assert.deepEqual(unknownRowTypes(item.sessionFile), [], 'a settled drain leaves nothing unknown');
    const execution = session.toolExecutions.find((state) => state.call.name === 'wait_for_release');
    assert.equal(execution?.status, 'completed', JSON.stringify(session.toolExecutions));
    assert.equal(session.runStatus?.status, 'canceled');
    const drainRow = session.drainRequests.at(-1);
    assert.equal(drainRow?.signal, 'SIGTERM');
    assert.equal(drainRow?.graceMs, 30_000);
    assert.ok(drainRow?.at, 'the drain marker carries the instant admission stopped');
  } finally {
    await provider.close();
  }
});

test('a forced drain leaves the unsettled tool outcome_unknown, the run canceled, and exits 143', async () => {
  const item = fixture('forced');
  const provider = await startToolCallProvider({ tool: 'never_settles' });
  try {
    const run = spawnCli(
      [
        cli,
        '--json',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        item.sessionFile,
        '--ext',
        item.extensionPath,
        '--shutdown-grace',
        '1',
        'call the tool',
      ],
      { cwd: item.workspace, env: environmentFor(item, provider.url) },
    );
    await signalOnceDispatched(run, item, 'SIGTERM');
    const result = await run.result;

    assert.equal(result.status, 143, JSON.stringify(result));
    assert.equal(terminalDrainPath(result.stdout), 'forced', result.stdout);

    const session = reopen(item.sessionFile);
    const execution = session.toolExecutions.find((state) => state.call.name === 'never_settles');
    assert.equal(execution?.status, 'outcome_unknown', JSON.stringify(session.toolExecutions));
    assert.equal(session.runStatus?.status, 'canceled');
    assert.equal(session.drainRequests.at(-1)?.graceMs, 1_000);
  } finally {
    await provider.close();
  }
});

test('--supervise kills a blocking extension at the deadline and the journal reopens outcome_unknown', async () => {
  const item = fixture('supervised');
  const provider = await startToolCallProvider({ tool: 'block_event_loop' });
  try {
    const run = spawnCli(
      [
        cli,
        '--supervise',
        '-p',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        item.sessionFile,
        '--ext',
        item.extensionPath,
        '--shutdown-grace',
        '1',
        'call the tool',
      ],
      { cwd: item.workspace, env: environmentFor(item, provider.url) },
    );
    await signalOnceDispatched(run, item, 'SIGTERM');
    const result = await run.result;

    assert.equal(result.status, 143, JSON.stringify(result));
    assert.match(result.stderr, /killing its process group/);

    // The supervisor never opens the journal (0023). The record is the child's:
    // a started tool with no terminal row, which the next open marks unknown.
    const beforeRecovery = reopen(item.sessionFile);
    const started = beforeRecovery.toolExecutions.find((state) => state.call.name === 'block_event_loop');
    assert.equal(started?.status, 'started', 'SIGKILL cannot write a terminal row');

    const recovery = recoverStaleLock(item.sessionFile);
    assert.equal(recovery.removed, true, recovery.reason);
    const reopened = Session.openLocked(item.sessionFile);
    assert.ok(reopened, 'the killed child left a recoverable journal');
    reopened.markInterruptedToolsOutcomeUnknown();
    const execution = reopened.toolExecutions.find((state) => state.call.name === 'block_event_loop');
    assert.equal(execution?.status, 'outcome_unknown', JSON.stringify(reopened.toolExecutions));
    reopened.close();
  } finally {
    await provider.close();
  }
});

test('a fleet-style SIGTERM between operations leaves no unknown rows', async () => {
  const item = fixture('fleet');
  const provider = await startToolCallProvider({ tool: 'signal_self' });
  try {
    const run = spawnCli(
      [
        cli,
        '-p',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        item.sessionFile,
        '--ext',
        item.extensionPath,
        'call the tool',
      ],
      { cwd: item.workspace, env: environmentFor(item, provider.url) },
    );
    const result = await run.result;

    // The signal lands with nothing dispatched: either between the tool result
    // and the next request, where the admission gate ends the turn canceled, or
    // after the turn has already reached its own completed status. Neither side
    // of that race may invent unknown work, and the exit code follows the row.
    assert.deepEqual(unknownRowTypes(item.sessionFile), [], 'an idle restart invents no unknown work');
    const session = reopen(item.sessionFile);
    const status = session.runStatus?.status;
    assert.ok(status === 'canceled' || status === 'completed', `unexpected terminal row ${String(status)}`);
    assert.equal(result.status, status === 'completed' ? 0 : 143, JSON.stringify(result));
    assert.equal(session.drainRequests.length, 1);
    const execution = session.toolExecutions.find((state) => state.call.name === 'signal_self');
    assert.equal(execution?.status, 'completed');
  } finally {
    await provider.close();
  }
});

test('the REPL drains under SIGTERM and exits 143', async () => {
  const item = fixture('repl');
  const provider = await startFakeProvider('the repl answered');
  try {
    const run = spawnCli(
      [cli, '--profile', 'openai', '--model', 'fake-model', '--session', item.sessionFile],
      {
        cwd: item.workspace,
        env: environmentFor(item, provider.url),
        input: 'say something\n',
        keepStdinOpen: true,
      },
    );
    // The prompt is idle again once the turn has printed its terminal line.
    await waitFor(() => run.readOutput().stdout.includes('completed:'), 'the first turn to finish');
    run.child.kill('SIGTERM');
    const result = await run.result;

    assert.equal(result.status, 143, JSON.stringify(result));
    assert.match(result.stdout, /shutdown: cooperative drain/);
    assert.deepEqual(unknownRowTypes(item.sessionFile), [], 'an idle REPL has nothing to leave unknown');
    assert.equal(reopen(item.sessionFile).drainRequests.at(-1)?.signal, 'SIGTERM');
  } finally {
    await provider.close();
  }
});

test('SIGINT still exits 130, distinct from a SIGTERM drain', async () => {
  const item = fixture('sigint');
  const provider = await startToolCallProvider({ tool: 'wait_for_release' });
  try {
    const run = spawnCli(
      [
        cli,
        '-p',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        item.sessionFile,
        '--ext',
        item.extensionPath,
        'call the tool',
      ],
      { cwd: item.workspace, env: environmentFor(item, provider.url) },
    );
    await signalOnceDispatched(run, item, 'SIGINT');
    const result = await run.result;

    assert.equal(result.status, 130, JSON.stringify(result));
    const session = reopen(item.sessionFile);
    assert.equal(session.drainRequests.length, 0, 'Ctrl+C is not a drain');
    assert.equal(session.runStatus?.status, 'canceled');
  } finally {
    await provider.close();
  }
});
