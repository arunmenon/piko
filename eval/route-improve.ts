/** Fixed, preregistered model-routing experiment over the long coding suite. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compare, reserveTrial, settleTrial, type Acceptance, type Measurement } from './improvement.js';
import { longCodingConfirmation, longCodingDevelopment } from './long-coding-tasks.js';
import { taskDefinitionSha256 } from './task-definition.js';
import type { UsageSummary } from './result.js';

const root = resolve(import.meta.dirname, '..');
const pricing = '/home/exedev/.config/pi/exe-llm-routing-pricing.json';
const profile = 'openai';
const endpoint = 'https://llm.int.exe.xyz/v1';
const baseline = { model: 'fireworks/kimi-k2p7-code', contextWindow: 262144 };
const candidate = { model: 'fireworks/glm-5p3-flash', contextWindow: 1048576 };
const rule: Acceptance = { repeats: 5, perTrialUSD: .05, maxQualityLoss: .05, minSavings: .05 };
const timeoutSeconds = 120;

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function atomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const file = openSync(temp, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}
function option(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`${name} is required`);
  return argv[index + 1]!;
}

function main(): number {
  const output = resolve(option(process.argv.slice(2), '--output-dir'));
  const budgetUSD = Number(option(process.argv.slice(2), '--budget-usd'));
  if (!Number.isFinite(budgetUSD) || budgetUSD <= 0 || budgetUSD > .97) throw new Error('--budget-usd must be in (0, 0.97]');
  if (!existsSync(pricing)) throw new Error(`pricing file missing: ${pricing}`);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output, { mode: 0o700 });

  const taskRows = (tasks: typeof longCodingDevelopment) => tasks.map((task) => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) }));
  const fixedPlan = [] as Array<{ stage: string; task: string; repeat: number; arm: 'baseline' | 'candidate'; model: string }>;
  for (const [stage, tasks] of [['development', longCodingDevelopment], ['confirmation', longCodingConfirmation]] as const) {
    for (let repeat = 0; repeat < rule.repeats; repeat++) for (const [index, task] of tasks.entries()) {
      const arms = (repeat + index) % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
      for (const arm of arms) fixedPlan.push({ stage, task: task.name, repeat, arm, model: arm === 'baseline' ? baseline.model : candidate.model });
    }
  }
  const preregistration = {
    schemaVersion: 1, recordedAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    endpoint, profile, pricing: { path: pricing, sha256: digest(readFileSync(pricing)) }, budgetUSD,
    perTrialUSD: rule.perTrialUSD, acceptance: rule, timeoutSeconds, maxTurns: 40, sandbox: 'require',
    baseline, candidate, development: taskRows(longCodingDevelopment), confirmation: taskRows(longCodingConfirmation),
    confirmationIsolation: 'candidate and acceptance are frozen before development; confirmation starts only after development passes and cannot tune either',
    fixedPlan,
  };
  atomic(join(output, 'preregistration.json'), preregistration);

  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0) throw new Error('cannot establish source provenance');
  const fingerprint = () => digest(JSON.stringify({
    files: tracked.stdout.split('\0').filter(Boolean).sort().map((name) => [name, digest(readFileSync(join(root, name)))]),
    pricing: digest(readFileSync(pricing)),
  }));
  const frozen = fingerprint();
  const state = { schemaVersion: 1, status: 'running', budgetUSD, spentUSD: 0, reservedUSD: 0,
    fingerprint: frozen, trials: [] as Array<Measurement & { model: string; durationSeconds: number }> };
  const history: unknown[] = [];
  const record = (event: unknown) => { history.push({ at: new Date().toISOString(), event }); atomic(join(output, 'history.json'), history); atomic(join(output, 'experiment.json'), state); };
  record({ stage: 'created', preregistration: 'preregistration.json' });

  const finish = (decision: ReturnType<typeof compare>): number => {
    state.status = decision.verdict === 'supported' ? 'parked' : decision.verdict;
    record({ stage: 'finished', decision });
    atomic(join(output, 'decision.json'), decision);
    writeFileSync(join(output, 'report.md'), `# Piko model-routing experiment\n\nDecision: **${state.status}**\n\n${decision.reason}\n\nBaseline: ${baseline.model}. Candidate: ${candidate.model}.\n\nCalculated spend: $${state.spentUSD.toFixed(6)}; outstanding reservation: $${state.reservedUSD.toFixed(6)}.\n\nNo routing setting was promoted.\n`, { mode: 0o600 });
    return decision.verdict === 'supported' ? 4 : decision.verdict === 'rejected' ? 0 : 2;
  };

  try {
    for (const script of ['test', 'check-budget']) {
      const checked = spawnSync('npm', ['run', script], { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(join(output, `${script}.log`), (checked.stdout ?? '') + (checked.stderr ?? ''), { mode: 0o600 });
      record({ stage: 'static-check', script, status: checked.status });
      if (checked.status !== 0 || checked.error || checked.signal) return finish({ verdict: 'insufficient_evidence', reason: `${script} failed` });
    }
    let serial = 0;
    const runStage = (stage: 'development' | 'confirmation', tasks: typeof longCodingDevelopment) => {
      const rows: Measurement[] = [];
      for (let repeat = 0; repeat < rule.repeats; repeat++) for (const [index, task] of tasks.entries()) {
        const arms = (repeat + index) % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
        for (const arm of arms) {
          if (fingerprint() !== frozen) throw new Error('source or pricing changed during experiment');
          const selected = arm === 'baseline' ? baseline : candidate;
          const trialOutput = join(output, `trial-${serial++}`);
          reserveTrial(state, rule.perTrialUSD, budgetUSD);
          record({ stage: 'trial-reserved', phase: stage, task: task.name, repeat, arm, model: selected.model, output: trialOutput });
          const started = performance.now();
          const child = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'eval/run.ts'), '--json-events', '--suite', `long-coding-${stage}`, '--only', task.name,
            '--harness-root', root, '--model', selected.model, '--profile', profile, '--pricing', pricing,
            '--max-spend-usd', String(rule.perTrialUSD), '--timeout', String(timeoutSeconds), '--max-turns', '40', '--sandbox', 'require', '--output-dir', trialOutput], {
            cwd: root, encoding: 'utf8', timeout: (timeoutSeconds + 60) * 1000, maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, OPENAI_BASE_URL: endpoint, PI_CONTEXT_WINDOW: String(selected.contextWindow) },
          });
          const durationSeconds = (performance.now() - started) / 1000;
          writeFileSync(join(output, `trial-${serial - 1}.log`), (child.stdout ?? '') + (child.stderr ?? ''), { mode: 0o600 });
          if (child.error || child.signal || ![0, 1].includes(child.status ?? -1)) throw new Error('evaluator did not terminate normally; reservation retained');
          const result = JSON.parse(readFileSync(join(trialOutput, 'trials', task.name, 'result.json'), 'utf8')) as { outcome: { pass: boolean }; usage?: UsageSummary };
          const usd = settleTrial(state, result.usage?.cost);
          const row: Measurement = { task: task.name, repeat, arm, phase: 'measurement', pass: result.outcome.pass, usd, offloaded: 0, artifact: trialOutput };
          rows.push(row); state.trials.push({ ...row, model: selected.model, durationSeconds });
          record({ stage: 'trial-completed', phase: stage, ...row, model: selected.model, durationSeconds });
        }
      }
      return rows;
    };
    const development = compare(runStage('development', longCodingDevelopment), longCodingDevelopment.map((task) => task.name), rule, false, false);
    record({ stage: 'development-decision', decision: development });
    if (development.verdict !== 'supported') return finish(development);
    const confirmation = compare(runStage('confirmation', longCodingConfirmation), longCodingConfirmation.map((task) => task.name), rule, true, false);
    return finish(confirmation);
  } catch (error) {
    return finish({ verdict: 'insufficient_evidence', reason: error instanceof Error ? error.message : String(error) });
  }
}

try { process.exitCode = main(); }
catch (error) { console.error(`route-improve: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
