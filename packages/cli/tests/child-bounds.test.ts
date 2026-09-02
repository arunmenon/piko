import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Session } from '@pi/core';
import { runCli, startFakeProvider } from './fake-provider.js';

const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');

/** A hermetic environment: no ambient credentials, no inherited nesting depth. */
function cleanEnvironment(workspace: string, providerUrl: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment['PI_DEPTH'];
  return {
    ...environment,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: providerUrl,
  };
}

test('--parent-run reaches telemetry and every headless JSON row', async () => {
  const provider = await startFakeProvider('the child answered');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-parent-run-'));
  const session = Session.create(workspace, 'fake-model', workspace);
  session.close(); // the spawned pi must be able to take the lock (0023)
  const telemetryPath = join(workspace, 'telemetry.jsonl');
  try {
    const result = await runCli(
      [
        cli,
        '--json',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        session.file,
        '--telemetry',
        telemetryPath,
        '--parent-run',
        'run_parent_1',
        'say something',
      ],
      { cwd: workspace, env: cleanEnvironment(workspace, provider.url) },
    );
    assert.equal(result.status, 0, JSON.stringify(result));

    const rows = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { v: number; parentRunId?: string; event?: { type: string } });
    assert.ok(rows.length > 0, 'the headless stream produced rows');
    for (const row of rows) assert.equal(row.parentRunId, 'run_parent_1', JSON.stringify(row));

    const telemetryRows = readFileSync(telemetryPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { parentRunId?: string; runId: string });
    assert.ok(telemetryRows.length > 0, 'telemetry was written');
    for (const row of telemetryRows) assert.equal(row.parentRunId, 'run_parent_1', JSON.stringify(row));
  } finally {
    await provider.close();
  }
});

test('a child started past the depth cap exits 1 before any provider request', async () => {
  const provider = await startFakeProvider();
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-max-depth-'));
  try {
    const environment = { ...cleanEnvironment(workspace, provider.url), PI_DEPTH: '3' };
    // --json: the refusal is a typed run_error row on stdout carrying the
    // static partial contract (0010 addendum, R2-5), not an empty stream.
    const refused = await runCli([cli, '--json', '--profile', 'openai', '--model', 'fake-model', 'go'], {
      cwd: workspace,
      env: environment,
    });
    assert.equal(refused.status, 1);
    const refusalRow = JSON.parse(refused.stdout.trim()) as {
      v: number;
      capabilities?: { journalSchemaVersion: number; exitCodes: number[]; budgetScope: string; partial?: boolean; tools?: string[] };
      event: { type: string; error: string };
    };
    assert.equal(refusalRow.v, 1);
    assert.equal(refusalRow.event.type, 'run_error');
    assert.match(refusalRow.event.error, /spawn depth 3 exceeds --max-depth 2/);
    assert.equal(refusalRow.capabilities?.partial, true, JSON.stringify(refusalRow));
    assert.deepEqual(refusalRow.capabilities?.exitCodes, [0, 1, 2, 3, 4, 5, 130, 143]);
    assert.equal(refusalRow.capabilities?.budgetScope, 'turn');
    assert.equal(refusalRow.capabilities?.tools, undefined, 'the tool set is unknown before setup');
    assert.equal(provider.requests.length, 0, 'the refusal precedes every model call');
    assert.equal(existsSync(join(workspace, '.pi')), false, 'no session is opened past the cap');

    // The human surface is unchanged: one line on stderr, nothing on stdout.
    const refusedHuman = await runCli([cli, '-p', '--profile', 'openai', '--model', 'fake-model', 'go'], {
      cwd: workspace,
      env: environment,
    });
    assert.equal(refusedHuman.status, 1);
    assert.equal(refusedHuman.stdout, '');
    assert.equal(refusedHuman.stderr.trim().split('\n').length, 1, refusedHuman.stderr);
    assert.match(refusedHuman.stderr, /spawn depth 3 exceeds --max-depth 2/);
    assert.equal(provider.requests.length, 0, 'the refusal precedes every model call');
    assert.equal(existsSync(join(workspace, '.pi')), false, 'no session is opened past the cap');

    // The same depth runs when the cap is raised to admit it.
    const admitted = await runCli(
      [cli, '-p', '--profile', 'openai', '--model', 'fake-model', '--max-depth', '3', 'go'],
      { cwd: workspace, env: environment },
    );
    assert.equal(admitted.status, 0, JSON.stringify(admitted));
    assert.equal(provider.requests.length, 1);
  } finally {
    await provider.close();
  }
});

test('a malformed inherited depth is refused rather than guessed', async () => {
  const provider = await startFakeProvider();
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-bad-depth-'));
  try {
    const result = await runCli([cli, '-p', '--profile', 'openai', '--model', 'fake-model', 'go'], {
      cwd: workspace,
      env: { ...cleanEnvironment(workspace, provider.url), PI_DEPTH: 'not-a-number' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PI_DEPTH must be a non-negative integer/);
    assert.equal(provider.requests.length, 0);
  } finally {
    await provider.close();
  }
});
