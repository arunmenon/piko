import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MAX_USER_INPUT_BYTES, Session, tryLockSession } from '@pi/core';
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

test('project instructions are opt-in', () => {
  assert.equal(parseArgs(['hello']).trustProject, false);
  assert.equal(parseArgs(['hello']).allowHostBash, false);
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
