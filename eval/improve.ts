/** External policy experiment controller. Never edits core, gates, or user config. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configPath, loadConfig } from '@pi/ai';
import { baselinePolicy, diagnose, runCycle, reserveTrial, settleTrial, type Acceptance, type Measurement, type OffloadPolicy } from './improvement.js';
import { longCodingDevelopment, longCodingConfirmation } from './long-coding-tasks.js';
import { taskDefinitionSha256 } from './task-definition.js';
import type { UsageSummary } from './result.js';

const HELP = `Usage: npm run improve -- --target offload --model MODEL --profile PROFILE
  --pricing FILE --budget-usd USD [--output-dir NEW_DIRECTORY]
  [--repeats 5] [--per-trial-usd 1] [--timeout-seconds 120]
  [--max-quality-loss 0.05] [--min-savings 0.05]

Scouts every development task once, then runs one trace-derived policy proposal through paired development
and separate confirmation trials. Uses sandbox require and complete USD evidence.
Small pilot runs normally return insufficient_evidence. No automatic promotion.
Exit 0: rejected; 2: insufficient evidence/budget; 4: supported, parked for review.
`;
const root = resolve(import.meta.dirname, '..');
const suiteNames = { development: 'long-coding-development', confirmation: 'long-coding-confirmation' } as const;
function plannedTrials(repeats: number) {
  const rows: Array<{ phase: 'scout' | 'measurement'; suite: string; task: string; repeat: number; arm: 'baseline' | 'candidate' }> = [];
  for (const task of longCodingDevelopment) rows.push({ phase: 'scout', suite: suiteNames.development, task: task.name, repeat: 0, arm: 'baseline' });
  for (const [suite, tasks] of [[suiteNames.development, longCodingDevelopment], [suiteNames.confirmation, longCodingConfirmation]] as const) {
    for (let repeat = 0; repeat < repeats; repeat++) for (const [index, task] of tasks.entries()) {
      const arms = (repeat + index) % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
      for (const arm of arms) rows.push({ phase: 'measurement', suite, task: task.name, repeat, arm });
    }
  }
  return rows;
}
function digest(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function atomic(path: string, value: unknown) {
  const temp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const fd = openSync(temp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function options(argv: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set(['--target', '--model', '--profile', '--pricing', '--budget-usd', '--output-dir', '--repeats', '--per-trial-usd', '--timeout-seconds', '--max-quality-loss', '--min-savings']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || values.has(key)) throw new Error(`invalid or duplicate option ${key}`);
    values.set(key, value);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`${key} is required`); return value; };
  const number = (key: string, fallback?: number, allowZero = false) => {
    const n = Number(values.get(key) ?? fallback ?? required(key));
    if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) throw new Error(`${key} must be ${allowZero ? 'nonnegative' : 'positive'} and finite`);
    return n;
  };
  if ((values.get('--target') ?? 'offload') !== 'offload') throw new Error('only offload is supported');
  const repeats = number('--repeats', 5), timeout = number('--timeout-seconds', 120);
  if (!Number.isSafeInteger(repeats) || repeats > 10000 || !Number.isSafeInteger(timeout) || timeout > 3600) throw new Error('invalid repeat count or timeout');
  const maxQualityLoss = number('--max-quality-loss', .05, true), minSavings = number('--min-savings', .05);
  if (maxQualityLoss >= 1 || minSavings >= 1) throw new Error('quality loss and savings must be less than 1');
  return {
    model: required('--model'), profile: required('--profile'), pricing: resolve(required('--pricing')),
    budgetUSD: number('--budget-usd'), timeout,
    rule: { repeats, perTrialUSD: number('--per-trial-usd', 1), maxQualityLoss, minSavings } satisfies Acceptance,
    output: resolve(values.get('--output-dir') ?? join(root, 'artifacts/improve', randomUUID())),
  };
}

function main(): number {
  if (process.argv.includes('--help')) { console.log(HELP); return 0; }
  const opts = options(process.argv.slice(2));
  if (opts.rule.perTrialUSD > opts.budgetUSD) throw new Error('per-trial ceiling exceeds total budget');
  const config = loadConfig();
  if (config.extensions?.length) throw new Error('improvement experiments require a profile environment without trusted extensions');
  // Preserve user approvals; a suspension cannot become a solve or a promoted policy.
  const sourcePaths = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (sourcePaths.status !== 0) throw new Error('cannot establish source provenance');
  const files = [...sourcePaths.stdout.split('\0').filter(Boolean),
    'eval/improve.ts', 'eval/improvement.ts', 'eval/long-coding-tasks.ts', 'eval/representative-tasks.ts', 'eval/task-definition.ts'];
  const fingerprint = () => digest(JSON.stringify({
    files: [...new Set(files)].sort().map(path => [path, existsSync(join(root, path)) ? digest(readFileSync(join(root, path))) : null]),
    pricing: digest(readFileSync(opts.pricing)),
    config: existsSync(configPath()) ? digest(readFileSync(configPath())) : null,
  }));
  const frozen = fingerprint();
  mkdirSync(dirname(opts.output), { recursive: true });
  mkdirSync(opts.output, { mode: 0o700 }); // existing runs are never overwritten or silently resumed
  const pricingSha256 = digest(readFileSync(opts.pricing));
  const plan = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    model: opts.model,
    profile: opts.profile,
    pricing: { path: opts.pricing, sha256: pricingSha256 },
    contextWindow: Number(process.env['PI_CONTEXT_WINDOW']) || null,
    budget: { runUSD: opts.budgetUSD, perTrialUSD: opts.rule.perTrialUSD },
    acceptance: { maxQualityLoss: opts.rule.maxQualityLoss, minSavings: opts.rule.minSavings,
      costPerSolveMustImprove: true, confidence: 'two one-sided Hoeffding bounds at alpha 0.025 each' },
    repeats: opts.rule.repeats,
    timeoutSeconds: opts.timeout,
    maxTurns: 40,
    sandbox: 'require',
    baseline: baselinePolicy,
    proposalRule: { noRecall: { thresholdChars: 2000, keepRecentMessages: 4 },
      recallObserved: { thresholdChars: 8000, keepRecentMessages: 12 } },
    development: longCodingDevelopment.map(task => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) })),
    confirmation: longCodingConfirmation.map(task => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) })),
    confirmationIsolation: 'proposal uses development scouts only; confirmation begins only after the frozen development screen passes',
    trials: plannedTrials(opts.rule.repeats),
    maximumTrialCount: 3 + 12 * opts.rule.repeats,
  };
  atomic(join(opts.output, 'preregistration.json'), plan);
  const state = {
    schemaVersion: 1, status: 'running', scope: 'offload policy; representative coding-fixture milestone',
    options: opts, fingerprint: frozen, preregistrationSha256: digest(readFileSync(join(opts.output, 'preregistration.json'))), baseline: baselinePolicy,
    spentUSD: 0, reservedUSD: 0, trials: [] as Measurement[],
  };
  const record = (event: unknown) => {
    // Single writer; atomic whole-ledger replacement preserves prior records.
    history.push({ at: new Date().toISOString(), event });
    atomic(join(opts.output, 'history.json'), history);
    atomic(join(opts.output, 'experiment.json'), state);
  };
  const history: unknown[] = [];
  record({ stage: 'created', scoutTasks: longCodingDevelopment.map(task => task.name),
    scoutPolicy: 'one baseline attempt per development task; aggregate all; no retries or early stop on evidence',
    confirmationTasks: longCodingConfirmation.map(task => task.name),
    preregistration: 'preregistration.json', taskHashes: {
      development: plan.development, confirmation: plan.confirmation,
    }, acceptance: plan.acceptance, maximumTrialCount: plan.maximumTrialCount });
  let candidateForReport: OffloadPolicy | undefined;
  const finish = (decision: { verdict: string; reason: string; metrics?: unknown }) => {
    state.status = decision.verdict === 'supported' ? 'parked' : decision.verdict;
    record({ stage: 'finished', ...decision });
    atomic(join(opts.output, 'decision.json'), decision);
    const metrics = decision.metrics as Record<string, number | string> | undefined;
    const measurements = metrics ? `
| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Verified successes | ${metrics.baselinePass} | ${metrics.candidatePass} |
| Total USD (failures included) | ${metrics.baselineCost} | ${metrics.candidateCost} |
| USD per verified success | ${metrics.baselineCostPerSolve} | ${metrics.candidateCostPerSolve} |

Quality difference lower bound: ${metrics.qualityLower}. Cost-improvement lower bound per pair: $${metrics.savingLowerUSD}.
` : '';
    const policy = candidateForReport ? `Baseline: ${baselinePolicy.thresholdChars} characters / ${baselinePolicy.keepRecentMessages} recent messages. Candidate: ${candidateForReport.thresholdChars} characters / ${candidateForReport.keepRecentMessages} recent messages.` : 'No candidate was frozen.';
    writeFileSync(join(opts.output, 'report.md'), `# Piko offload improvement\n\nDecision: **${state.status}**\n\n${decision.reason}\n\n${policy}\n${measurements}\nConfirmed research spend: $${state.spentUSD.toFixed(6)}; unreconciled reservation: $${state.reservedUSD.toFixed(6)}.\n\nSee preregistration.json for the frozen execution plan, proposal.json (when created) for the hypothesis and source event references, decision.json for measurements, and history.json for all stages. No settings were promoted. A supported result requires human review. This bounded representative-fixture run remains a pipeline pilot unless its predeclared confidence bounds pass.\n`, { mode: 0o600 });
    console.log(`${state.status}: ${decision.reason}\nReport: ${join(opts.output, 'report.md')}`);
    return decision.verdict === 'supported' ? 4 : decision.verdict === 'rejected' ? 0 : 2;
  };
  try {
    // Fixed controller gates, not commands supplied by a proposer.
    for (const script of ['test', 'check-budget']) {
      const result = spawnSync('npm', ['run', script], { cwd: root, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(join(opts.output, `${script}.log`), (result.stdout ?? '') + (result.stderr ?? ''), { mode: 0o600 });
      record({ stage: 'static-check', script, status: result.status });
      if (result.status !== 0 || result.error || result.signal) return finish({ verdict: 'insufficient_evidence', reason: `${script} failed` });
    }
    const runtimeFingerprint = (): string => {
      const files: Array<[string, string]> = [];
      const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.isFile()) files.push([path, digest(readFileSync(path))]);
          else throw new Error('unexpected runtime file type');
        }
      };
      for (const pkg of ['ai', 'core', 'cli']) visit(join(root, 'packages', pkg, 'dist'));
      return digest(JSON.stringify(files));
    };
    const frozenRuntime = runtimeFingerprint();
    record({ stage: 'runtime-frozen', hash: frozenRuntime });
    let serial = 0;
    const trial = (suite: string, task: string, repeat: number, arm: Measurement['arm'], policy: OffloadPolicy, phase: 'scout' | 'measurement') => {
      if (fingerprint() !== frozen || runtimeFingerprint() !== frozenRuntime) throw new Error('source, evaluator, pricing, or config changed during experiment');
      const output = join(opts.output, `trial-${serial++}`);
      reserveTrial(state, opts.rule.perTrialUSD, opts.budgetUSD);
      record({ stage: 'trial-reserved', suite, task, repeat, arm, output, policy, phase });
      const args = ['--import', 'tsx', join(root, 'eval/run.ts'), '--json-events', '--suite', suite, '--only', task,
        '--harness-root', root, '--model', opts.model, '--profile', opts.profile,
        '--pricing', opts.pricing, '--max-spend-usd', String(opts.rule.perTrialUSD),
        '--timeout', String(opts.timeout), '--max-turns', '40', '--sandbox', 'require',
        '--offload-threshold', String(policy.thresholdChars), '--offload-keep-recent', String(policy.keepRecentMessages),
        '--output-dir', output];
      const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: (opts.timeout + 60) * 1000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(join(opts.output, `trial-${serial - 1}.log`), (child.stdout ?? '') + (child.stderr ?? ''), { mode: 0o600 });
      if (child.error || child.signal || ![0, 1].includes(child.status ?? -1)) throw new Error('evaluator did not terminate normally; reservation retained');
      const result = JSON.parse(readFileSync(join(output, 'trials', task, 'result.json'), 'utf8')) as {
        outcome: { pass: boolean }; usage?: UsageSummary;
      };
      const usd = settleTrial(state, result.usage?.cost);
      const stream = readFileSync(join(output, 'trials', task, 'stdout.txt'), 'utf8');
      const evidence = diagnose(stream);
      const row: Measurement = { task, repeat, arm, phase, pass: result.outcome.pass, usd, offloaded: evidence.offloaded, artifact: output };
      state.trials.push(row);
      record({ stage: 'trial-completed', ...row, evidence });
      if (fingerprint() !== frozen || runtimeFingerprint() !== frozenRuntime) throw new Error('experiment inputs changed during trial');
      return { row, evidence };
    };
    return finish(runCycle({
      development: longCodingDevelopment.map(task => task.name),
      confirmation: longCodingConfirmation.map(task => task.name), rule: opts.rule, suiteNames, trial,
      onProposal(proposal, scouts) {
        candidateForReport = proposal.policy;
        atomic(join(opts.output, 'proposal.json'), { ...proposal, evidence: scouts.evidence,
          sources: scouts.sources.map(scout => ({ task: scout.row.task, artifact: scout.row.artifact, evidence: scout.evidence })), baseline: baselinePolicy,
          candidateArgs: ['--offload-threshold', String(proposal.policy.thresholdChars), '--offload-keep-recent', String(proposal.policy.keepRecentMessages)] });
        record({ stage: 'candidate-frozen', proposal });
      },
      onStage(suite, decision) { record({ stage: suite, decision }); },
    }));
  } catch (error) {
    return finish({ verdict: 'insufficient_evidence', reason: error instanceof Error ? error.message : String(error) });
  }
}
try { process.exitCode = main(); }
catch (error) { console.error(`improve: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
