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
  capabilities?: {
    journalSchemaVersion: number;
    tools?: string[];
    exitCodes: number[];
    budgetScope: string;
    partial?: boolean;
  };
  event?: {
    type: string;
    reason?: string;
    error?: string;
    code?: string;
    spend?: { reservationUSD: number; actualUSD: number; reservedUSD: number; ceilingUSD: number };
  };
}

test('the first headless JSON row is the automation contract itself', () => {
  const { rows } = runToSpendCeiling();
  assert.ok(rows.length > 0);
  const contractRow = rows[0]!;
  // 0010 addendum as corrected by R2-5: a dedicated row, not a field riding an
  // event, so a run that fails before the first event still advertises itself.
  assert.equal(contractRow.event, undefined, 'the contract row carries no event');
  const capabilities = contractRow.capabilities;
  assert.ok(capabilities, 'the first row carries capabilities');
  assert.equal(capabilities.journalSchemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(capabilities.exitCodes, [0, 1, 2, 3, 4, 5, 130]);
  assert.equal(capabilities.budgetScope, 'turn');
  assert.equal(capabilities.partial, undefined, 'the post-setup row is the full form');
  assert.ok(capabilities.tools?.includes('write'));
  assert.ok(capabilities.tools?.includes('read'));
  // additive and first-row only: no later event row gains the field
  assert.deepEqual(rows.slice(1).map((row) => row.capabilities), rows.slice(1).map(() => undefined));
  assert.ok(rows.slice(1).every((row) => row.event !== undefined), 'every later row is an event row');
});

test('a headless spend stop carries its four numbers on the stop row and the terminal row', () => {
  const { status, rows, stderr } = runToSpendCeiling();
  assert.equal(status, 2);
  const stop = rows.find((row) => row.event?.type === 'budget_exceeded');
  assert.equal(stop?.event?.reason, 'spend');
  const spend = stop?.event?.spend;
  assert.ok(spend);
  assert.equal(spend.ceilingUSD, 0.000001);
  assert.equal(spend.actualUSD, 0);
  assert.equal(spend.reservedUSD, 0);
  assert.ok(spend.reservationUSD > spend.ceilingUSD);
  const terminal = rows.at(-1)!;
  assert.equal(terminal.event?.type, 'turn_done');
  assert.deepEqual(terminal.event?.spend, spend);
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
  // Seven decimals, not six: a $0.000001 ceiling needs one more place to show
  // two significant digits (R2-11 adaptive precision).
  assert.match(
    stderr,
    /spend stop: reserved \$[\d.]+ for the next request, spent \$0\.0000000, ceiling \$0\.0000010, effective ceiling \$0\.0000010 \(ceiling less \$0\.0000000 outstanding reservations\)/,
  );
  assert.doesNotMatch(stderr, /spend stop:.*e[+-]\d/i, 'no scientific notation on the human surface');
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

/**
 * R2-5: the contract used to ride the first Agent.run() event, so every run
 * that failed before that event advertised nothing. These five paths are the
 * ones the review executed. Each asserts the exit code is what it was, plus
 * whichever capabilities form the corrected 0010 addendum promises.
 */
function headlessJsonRows(
  argv: readonly string[],
  workspace: string,
  environmentOverrides: NodeJS.ProcessEnv = {},
): { status: number | null; rows: JsonRow[]; stderr: string } {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    // A closed port: the transport fails before the first agent event.
    OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    ...environmentOverrides,
  };
  delete environment['ANTHROPIC_API_KEY'];
  delete environment['PI_DEPTH'];
  const result = spawnSync(process.execPath, [cli, ...argv], { cwd: workspace, encoding: 'utf8', env: environment });
  return {
    status: result.status,
    rows: result.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JsonRow),
    stderr: result.stderr,
  };
}

function assertFullCapabilities(row: JsonRow | undefined): void {
  assert.ok(row, 'a contract row was emitted');
  assert.equal(row.event, undefined, 'the contract row carries no event');
  assert.equal(row.capabilities?.partial, undefined, 'the post-setup form is complete');
  assert.equal(row.capabilities?.journalSchemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(row.capabilities?.exitCodes, [0, 1, 2, 3, 4, 5, 130]);
  assert.equal(row.capabilities?.budgetScope, 'turn');
  assert.ok(row.capabilities?.tools?.includes('read'), JSON.stringify(row));
}

function assertPartialCapabilities(row: JsonRow | undefined): void {
  assert.ok(row, 'a run_error row was emitted');
  assert.equal(row.event?.type, 'run_error');
  assert.equal(row.capabilities?.partial, true, JSON.stringify(row));
  assert.equal(row.capabilities?.journalSchemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(row.capabilities?.exitCodes, [0, 1, 2, 3, 4, 5, 130]);
  assert.equal(row.capabilities?.budgetScope, 'turn');
  assert.equal(row.capabilities?.tools, undefined, 'the tool set is omitted, never guessed');
}

test('a provider transport failure before the first event still carries the contract', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-caps-transport-'));
  const { status, rows } = headlessJsonRows(
    ['--json', '--profile', 'openai', '--model', 'fake-model', '--offline-pricing', 'hello'],
    workspace,
  );
  assert.equal(status, 1, JSON.stringify(rows));
  assertFullCapabilities(rows[0]);
  assertPartialCapabilities(rows.find((row) => row.event?.type === 'run_error'));
});

test('an extension failure before setup completes carries the partial contract', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-caps-ext-'));
  const { status, rows } = headlessJsonRows(
    ['--json', '--profile', 'openai', '--model', 'fake-model', '--offline-pricing', '--ext', 'absent.mjs', 'hello'],
    workspace,
  );
  assert.equal(status, 1, JSON.stringify(rows));
  assert.equal(rows.length, 1, 'setup never completed, so there is no full contract row');
  assertPartialCapabilities(rows[0]);
  assert.match(String(rows[0]?.event?.error), /absent\.mjs/);
});

test('a suspended session resumed without a decision carries the contract', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-caps-suspended-'));
  const session = Session.create(workspace, 'fake-model', workspace);
  const call = { type: 'toolCall' as const, id: 'call_1', name: 'write', arguments: { path: 'gated.txt', content: 'ok' } };
  session.append({ t: 'msg', message: { role: 'assistant', content: [call] } });
  session.requestToolApproval(session.planTool(call));
  session.setRunStatus('suspended', 'awaiting_approval');
  session.close(); // the spawned pi must be able to take the lock (0023)

  const { status, rows } = headlessJsonRows(
    ['--json', '--profile', 'openai', '--model', 'fake-model', '--offline-pricing', '--session', session.file, 'anything'],
    workspace,
  );
  assert.equal(status, 1, JSON.stringify(rows));
  assertFullCapabilities(rows[0]);
  const failure = rows.find((row) => row.event?.type === 'run_error');
  assertPartialCapabilities(failure);
  assert.match(String(failure?.event?.error), /suspended awaiting tool approval/);
});

/** A REPL that never contacts a provider: only slash commands are typed. */
function runScriptedRepl(
  input: string,
  profile: { provider: 'openai' | 'anthropic'; model: string } = { provider: 'openai', model: 'gpt-test' },
): { stdout: string; stderr: string; status: number | null } {
  const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-cache-'));
  const env = { ...process.env, HOME: workspace, OPENAI_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key' };
  if (profile.provider === 'openai') delete env['ANTHROPIC_API_KEY'];
  else delete env['OPENAI_API_KEY'];
  const result = spawnSync(
    process.execPath,
    [cli, '--profile', profile.provider, '--model', profile.model, '--offline-pricing'],
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

test('a known Anthropic model states its published minimum as an expectation, not a certainty (0014)', () => {
  const result = runScriptedRepl('/exit\n', { provider: 'anthropic', model: 'claude-opus-4-5' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /cache eligibility: anthropic\/claude-opus-4-5/);
  assert.match(result.stderr, /4096-token minimum cacheable size/);
  assert.match(result.stderr, /below the published minimum and is not expected to cache/);
  assert.doesNotMatch(result.stderr, /will not cache/);
});

test('an Anthropic model with no published row draws no conclusion at startup (0014)', () => {
  const result = runScriptedRepl('/exit\n', { provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /cache eligibility: anthropic\/claude-sonnet-5/);
  assert.match(result.stderr, /minimum cacheable size for this model is unknown to piko/);
  assert.match(result.stderr, /no conclusion is drawn/);
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
