/**
 * Headless smoke suite: each task runs in a scratch dir via `pi -p`, then a
 * deterministic verify() checks the resulting files. Reports pass/fail plus
 * tokens and model calls per task (the numbers the lean-harness claim rests on).
 *
 * usage: npm run eval [-- --model <name> --profile <name> --only <task> --max-turns <n>]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { tasks } from './tasks.js';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

const model = flag('--model');
const profile = flag('--profile');
const only = flag('--only');
const maxTurns = flag('--max-turns') ?? '15';
const cliEntry = resolve(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'main.js');

interface UsageSummary {
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  requests: number;
}

interface Row {
  name: string;
  pass: boolean;
  requests: number | undefined;
  inTokens: number | undefined;
  outTokens: number | undefined;
  seconds: number;
}

const rows: Row[] = [];
const selected = tasks.filter((task) => !only || task.name === only);
if (selected.length === 0) {
  console.error(`no task named "${only}"`);
  process.exit(1);
}

for (const task of selected) {
  const dir = mkdtempSync(join(tmpdir(), `pi-eval-${task.name}-`));
  for (const [path, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, 'utf8');
  }
  const started = Date.now();
  const result = spawnSync(
    'node',
    [
      cliEntry,
      '-p',
      '--usage',
      '--max-turns',
      maxTurns,
      ...(model ? ['--model', model] : []),
      ...(profile ? ['--profile', profile] : []),
      task.prompt,
    ],
    { cwd: dir, encoding: 'utf8', timeout: 300_000 },
  );
  const seconds = (Date.now() - started) / 1000;

  let summary: UsageSummary | undefined;
  for (const line of (result.stderr ?? '').trim().split('\n').reverse()) {
    if (line.startsWith('{')) {
      try {
        summary = JSON.parse(line) as UsageSummary;
        break;
      } catch {
        /* not the summary line */
      }
    }
  }

  let pass = false;
  try {
    pass = task.verify(dir);
  } catch {
    pass = false;
  }
  rows.push({
    name: task.name,
    pass,
    requests: summary?.requests,
    inTokens: summary ? summary.usage.inputTokens + summary.usage.cacheReadTokens + summary.usage.cacheWriteTokens : undefined,
    outTokens: summary?.usage.outputTokens,
    seconds,
  });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${task.name}  (${seconds.toFixed(1)}s, ${summary?.requests ?? '?'} calls)${pass ? '' : `\n  stderr: ${(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`}`);
}

const passed = rows.filter((row) => row.pass).length;
console.log(`\n${passed}/${rows.length} passed`);
console.log('task                  pass  calls  in-tokens  out-tokens  seconds');
for (const row of rows) {
  console.log(
    `${row.name.padEnd(22)}${row.pass ? 'yes' : 'NO '}   ${String(row.requests ?? '?').padStart(4)}  ${String(row.inTokens ?? '?').padStart(9)}  ${String(row.outTokens ?? '?').padStart(10)}  ${row.seconds.toFixed(1).padStart(7)}`,
  );
}
process.exit(passed === rows.length ? 0 : 1);
