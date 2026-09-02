import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { JOURNAL_SCHEMA_VERSION, MAX_USER_INPUT_BYTES, Session, tryLockSession } from '@pi/core';
import { parseArgs } from '../src/args.js';
import { interpolate } from '../src/templates.js';

test('parseArgs handles flags, budgets, and positional prompt', () => {
  const args = parseArgs([
    '-p',
    '--model',
    'm1',
    '--max-turns',
    '5',
    '--max-tool-calls',
    '8',
    '--max-tool-output-bytes',
    '5000',
    '--max-time',
    '30',
    '--max-total-tokens',
    '9000',
    '--max-spend-usd',
    '1.25',
    '--pricing',
    'prices.json',
    '--offline-pricing',
    '--trust-project',
    '--allow-host-bash',
    '--allow-protected-paths',
    '--telemetry',
    'trace.jsonl',
    '--ext',
    'a.ts',
    'fix',
    'the',
    'bug',
  ]);
  assert.equal(args.print, true);
  assert.equal(args.model, 'm1');
  assert.equal(args.maxTurns, 5);
  assert.equal(args.maxToolCalls, 8);
  assert.equal(args.maxToolOutputBytes, 5000);
  assert.equal(args.maxTimeMs, 30_000);
  assert.equal(args.maxTotalTokens, 9000);
  assert.equal(args.maxSpendUSD, 1.25);
  assert.equal(args.pricingPath, 'prices.json');
  assert.equal(args.offlinePricing, true);
  assert.equal(args.trustProject, true);
  assert.equal(args.allowHostBash, true);
  assert.equal(args.allowProtectedPaths, true);
  assert.equal(args.telemetry, 'trace.jsonl');
  assert.deepEqual(args.extensions, ['a.ts']);
  assert.equal(args.prompt, 'fix the bug');
});

test('parseArgs rejects missing values', () => {
  assert.throws(() => parseArgs(['--model']));
  assert.throws(() => parseArgs(['--max-tool-calls', '0']));
  assert.throws(() => parseArgs(['--max-time', '1.5']));
  assert.throws(() => parseArgs(['--max-spend-usd', '0']));
  assert.throws(() => parseArgs(['--max-spend-usd', 'NaN']));
});

test('parseArgs rejects unsafe timer and tool-output budgets', () => {
  assert.throws(() => parseArgs(['--max-time', '2147484', 'go']), /too large/);
  assert.throws(() => parseArgs(['--max-tool-output-bytes', '255', 'go']), />= 256/);
});

test('parseArgs carries child-run correlation and the nesting cap', () => {
  const args = parseArgs(['-p', '--parent-run', 'run_abc', '--max-depth', '0', 'go']);
  assert.equal(args.parentRunId, 'run_abc');
  assert.equal(args.maxDepth, 0);
  assert.equal(parseArgs(['go']).maxDepth, 2, 'the default cap admits two levels of nesting');
  assert.equal(parseArgs(['go']).parentRunId, undefined);
  assert.throws(() => parseArgs(['--parent-run', '', 'go']), /non-empty run id/);
  assert.throws(() => parseArgs(['--parent-run']), /requires a value/);
  assert.throws(() => parseArgs(['--max-depth', '-1', 'go']), />= 0/);
  assert.throws(() => parseArgs(['--max-depth', '1.5', 'go']), />= 0/);
});

test('project instructions are opt-in', () => {
  assert.equal(parseArgs(['hello']).trustProject, false);
  assert.equal(parseArgs(['hello']).allowHostBash, false);
  assert.equal(parseArgs(['hello']).allowProtectedPaths, false);
});

test('--json implies headless print mode', () => {
  const args = parseArgs(['--json', 'hello']);
  assert.equal(args.json, true);
  assert.equal(args.print, true);
});

test('--json serializes argument/setup failures instead of emitting an empty stdout stream', () => {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const result = spawnSync(process.execPath, [cli, '--json', '--not-a-real-flag'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const row = JSON.parse(result.stdout.trim()) as { v: number; event: { type: string; error: string } };
  assert.equal(row.v, 1);
  assert.equal(row.event.type, 'run_error');
  assert.match(row.event.error, /unknown flag/);
});

test('a CLI spend ceiling fails closed before session/provider setup when the model is unpriced', () => {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-unpriced-'));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      '--json',
      '--profile',
      'openai',
      '--model',
      'not-in-table',
      '--offline-pricing',
      '--max-spend-usd',
      '1',
      'hello',
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, HOME: workspace, OPENAI_API_KEY: 'test-key' },
    },
  );
  assert.equal(result.status, 1);
  const row = JSON.parse(result.stdout.trim()) as { event: { type: string; error: string } };
  assert.equal(row.event.type, 'run_error');
  assert.match(row.event.error, /requires an exact price/);
});

/**
 * Drives a real headless run to a dollar ceiling stop. The reservation is
 * refused before dispatch, so no provider is contacted and the assertions cover
 * the two 0010/0020 row shapes: the capabilities field on the first row and the
 * four spend numbers on the terminal row.
 */
function runToSpendCeiling(jsonStream = true): { status: number | null; rows: JsonRow[]; stderr: string } {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-spend-stop-'));
  const pricingPath = join(workspace, 'prices.json');
  writeFileSync(
    pricingPath,
    JSON.stringify({
      models: { 'fake-model': { inputUSDPerToken: 0.000001, outputUSDPerToken: 0.000002 } },
      effectiveAt: '2026-08-24T00:00:00.000Z',
    }),
    'utf8',
  );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      ...(jsonStream ? ['--json'] : ['--print']),
      '--usage',
      '--profile',
      'openai',
      '--model',
      'fake-model',
      '--pricing',
      pricingPath,
      '--max-spend-usd',
      '0.000001',
      'hello',
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, HOME: workspace, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' },
    },
  );
  const rows = jsonStream
    ? result.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonRow)
    : [];
  return { status: result.status, rows, stderr: result.stderr };
}

interface JsonRow {
  v: number;
  sessionId?: string;
  capabilities?: { journalSchemaVersion: number; tools: string[]; exitCodes: number[]; budgetScope: string };
  event: {
    type: string;
    reason?: string;
    spend?: { reservationUSD: number; actualUSD: number; reservedUSD: number; ceilingUSD: number };
  };
}

test('the first headless JSON row advertises the automation contract', () => {
  const { rows } = runToSpendCeiling();
  assert.ok(rows.length > 0);
  const capabilities = rows[0]!.capabilities;
  assert.ok(capabilities, 'the first row carries capabilities');
  assert.equal(capabilities.journalSchemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(capabilities.exitCodes, [0, 1, 2, 3, 4, 5, 130]);
  assert.equal(capabilities.budgetScope, 'turn');
  assert.ok(capabilities.tools.includes('write'));
  assert.ok(capabilities.tools.includes('read'));
  // additive and first-row only: no later row gains the field
  assert.deepEqual(rows.slice(1).map((row) => row.capabilities), rows.slice(1).map(() => undefined));
});

test('a headless spend stop carries its four numbers on the stop row and the terminal row', () => {
  const { status, rows, stderr } = runToSpendCeiling();
  assert.equal(status, 2);
  const stop = rows.find((row) => row.event.type === 'budget_exceeded');
  assert.equal(stop?.event.reason, 'spend');
  const spend = stop?.event.spend;
  assert.ok(spend);
  assert.equal(spend.ceilingUSD, 0.000001);
  assert.equal(spend.actualUSD, 0);
  assert.equal(spend.reservedUSD, 0);
  assert.ok(spend.reservationUSD > spend.ceilingUSD);
  const terminal = rows.at(-1)!;
  assert.equal(terminal.event.type, 'turn_done');
  assert.deepEqual(terminal.event.spend, spend);
  const usageRow = stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { type: string; spendCeiling?: { ceilingUSD: number; effectiveCeilingUSD: number } })
    .find((row) => row.type === 'usage_summary');
  assert.equal(usageRow?.spendCeiling?.ceilingUSD, 0.000001);
  assert.equal(usageRow?.spendCeiling?.effectiveCeilingUSD, 0.000001);
});

test('a human headless spend stop explains itself on stderr in one line', () => {
  const { status, stderr } = runToSpendCeiling(false);
  assert.equal(status, 2);
  assert.match(
    stderr,
    /spend stop: reserved \$[\d.]+ for the next request, spent \$0\.000000, ceiling \$0\.000001, effective ceiling \$0\.000001 \(ceiling less \$0\.000000 outstanding reservations\)/,
  );
  // 0009 wording: the stop is scoped to a turn, not to a whole run.
  assert.match(stderr, /turn budget_exceeded: spend/);
});

test('JSON errors encode terminal controls while human errors sanitize them', () => {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const hostileFlag = '--bad\x1b[2J\rspoof';

  const json = spawnSync(process.execPath, [cli, '--json', hostileFlag], { encoding: 'utf8' });
  assert.equal(json.status, 1);
  assert.match(json.stdout, /\\u001b/);
  const row = JSON.parse(json.stdout.trim()) as { event: { error: string } };
  assert.match(row.event.error, /\x1b\[2J\rspoof/u);

  const human = spawnSync(process.execPath, [cli, hostileFlag], { encoding: 'utf8' });
  assert.equal(human.status, 1);
  assert.doesNotMatch(human.stderr, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
  assert.match(human.stderr, /--bad\[2Jspoof/u);
});

test('headless stdin is byte bounded before setup', () => {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const result = spawnSync(process.execPath, [cli, '--json'], {
    encoding: 'utf8',
    input: 'x'.repeat(MAX_USER_INPUT_BYTES + 1),
    maxBuffer: MAX_USER_INPUT_BYTES * 2,
  });
  assert.equal(result.status, 1);
  const row = JSON.parse(result.stdout.trim()) as { event: { type: string; error: string } };
  assert.equal(row.event.type, 'run_error');
  assert.match(row.event.error, /stdin prompt exceeds/);
});

test('an explicitly requested locked session fails instead of silently starting fresh', () => {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const dir = mkdtempSync(join(tmpdir(), 'pi-cli-session-lock-'));
  // create() itself holds the lock (0023); the spawned pi must refuse it.
  const session = Session.create(dir, 'test-model', dir);
  try {
    const result = spawnSync(process.execPath, [cli, '--json', '--model', 'test-model', '--session', session.file, 'hello'], {
      cwd: dir,
      encoding: 'utf8',
      // hermetic: the lock check under test must not depend on ambient credentials
      env: { ...process.env, OPENAI_API_KEY: 'test-key-hermetic' },
    });
    assert.equal(result.status, 1);
    const row = JSON.parse(result.stdout.trim()) as { event: { type: string; error: string } };
    assert.equal(row.event.type, 'run_error');
    assert.match(row.event.error, /requested session is already in use/);
  } finally {
    session.close();
  }
});

/** A REPL that never contacts a provider: only slash commands are typed. */
function runScriptedRepl(input: string): { stdout: string; stderr: string; status: number | null } {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-cache-'));
  const env = { ...process.env, HOME: workspace, OPENAI_API_KEY: 'test-key' };
  delete env['ANTHROPIC_API_KEY'];
  const result = spawnSync(
    process.execPath,
    [cli, '--profile', 'openai', '--model', 'gpt-test', '--offline-pricing'],
    { cwd: workspace, encoding: 'utf8', env, input },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

test('startup states cache eligibility on stderr, outside the stdout stream (0014)', () => {
  const result = runScriptedRepl('/exit\n');
  assert.equal(result.status, 0);
  assert.match(result.stderr, /cache eligibility: openai\/gpt-test/);
  assert.match(result.stderr, /minimum cacheable size/);
  // Printed once per process, and never on the typed stdout surface.
  assert.equal(result.stderr.match(/cache eligibility:/g)?.length, 1);
  assert.doesNotMatch(result.stdout, /cache eligibility:/);
});

test('a mid-session model switch warns that the cache key changes (0014)', () => {
  const switched = runScriptedRepl('/model gpt-other\n/exit\n');
  assert.equal(switched.status, 0);
  assert.match(switched.stdout, /model: openai:gpt-other/);
  assert.match(switched.stdout, /prompt cache key/);
  assert.match(switched.stdout, /re-pays the full prefix/);

  // Re-selecting the running model keeps the cache key, so it must not warn.
  const unchanged = runScriptedRepl('/model gpt-test\n/exit\n');
  assert.equal(unchanged.status, 0);
  assert.match(unchanged.stdout, /model: openai:gpt-test/);
  assert.doesNotMatch(unchanged.stdout, /prompt cache key/);
});

test('interpolate replaces every $ARGUMENTS occurrence', () => {
  const template = { name: 'review', body: 'Review $ARGUMENTS carefully. Focus: $ARGUMENTS', source: 'x' };
  assert.equal(interpolate(template, 'src/'), 'Review src/ carefully. Focus: src/');
});

test('interpolate passes $-sequences in arguments through literally', () => {
  const template = { name: 'echo', body: 'Run: $ARGUMENTS', source: 'x' };
  assert.equal(interpolate(template, "sed 's/x/[$&]/' and $$PID"), "Run: sed 's/x/[$&]/' and $$PID");
});
