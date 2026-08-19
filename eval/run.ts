/**
 * Headless smoke suite. Each task runs in a fresh scratch directory and passes
 * only when the pi process completes cleanly, emits structured usage, and the
 * deterministic verifier succeeds.
 *
 * Usage:
 *   npm run eval -- [--model <name>] [--profile <name>] [--only <task>]
 *     [--max-turns <n>] [--timeout <seconds>] [--output-dir <new-directory>]
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { classifyEvalOutcome, parseUsageSummary, type EvalOutcome, type UsageSummary } from './result.js';
import { tasks } from './tasks.js';

interface Options {
  model?: string;
  profile?: string;
  only?: string;
  maxTurns: number;
  timeoutMs: number;
  outputDir?: string;
}

interface FileEvidence {
  path: string;
  type: 'file' | 'symlink';
  size?: number;
  sha256?: string;
  target?: string;
}

interface TrialRecord {
  schemaVersion: 1;
  task: string;
  taskDefinitionSha256: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  process: {
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: { name: string; message: string; code?: string };
  };
  verification: { passed: boolean; error?: string };
  outcome: EvalOutcome;
  usage?: UsageSummary;
  workspaceBefore: FileEvidence[];
  workspaceAfter: FileEvidence[];
  evidenceError?: string;
  sessionArtifact?: string;
}

function positiveInteger(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} requires an integer >= 1`);
  return value;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { maxTurns: 15, timeoutMs: 300_000 };
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--model':
        options.model = take(i++, arg);
        break;
      case '--profile':
        options.profile = take(i++, arg);
        break;
      case '--only':
        options.only = take(i++, arg);
        break;
      case '--max-turns':
        options.maxTurns = positiveInteger(arg, take(i++, arg));
        break;
      case '--timeout':
        options.timeoutMs = positiveInteger(arg, take(i++, arg)) * 1_000;
        break;
      case '--output-dir':
        options.outputDir = take(i++, arg);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function snapshotWorkspace(root: string): FileEvidence[] {
  const evidence: FileEvidence[] = [];
  let entriesSeen = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > 10_000) throw new Error('workspace contains more than 10,000 entries');
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isSymbolicLink()) {
        const stat = lstatSync(path);
        evidence.push({ path: name, type: 'symlink', size: stat.size, target: readlinkSync(path) });
      } else if (entry.isFile()) {
        const stat = lstatSync(path);
        const item: FileEvidence = { path: name, type: 'file', size: stat.size };
        // Avoid reading an unexpectedly large model-created file into the eval process.
        if (stat.size <= 16 * 1024 * 1024) item.sha256 = sha256(readFileSync(path));
        evidence.push(item);
      }
    }
  };
  visit(root);
  return evidence.sort((a, b) => a.path.localeCompare(b.path));
}

function gitValue(args: string[]): string | undefined {
  const result = spawnSync('git', args, {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function sourceTreeSha256(repository: string): string | undefined {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  const hash = createHash('sha256');
  for (const name of result.stdout.split('\0').filter(Boolean).sort()) {
    const path = join(repository, name);
    hash.update(name).update('\0');
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) hash.update('symlink\0').update(readlinkSync(path));
      else if (stat.isFile()) hash.update('file\0').update(readFileSync(path));
      else hash.update('other\0');
    } catch {
      hash.update('deleted\0');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function harnessEvidence(repository: string): {
  distSha256: string;
  files: Array<{ path: string; size: number; sha256: string }>;
} {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const content = readFileSync(path);
        files.push({ path: relative(repository, path), size: content.length, sha256: sha256(content) });
      }
    }
  };
  for (const name of ['ai', 'core', 'cli']) visit(join(repository, 'packages', name, 'dist'));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    distSha256: sha256(files.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join('')),
    files,
  };
}

function taskDefinitionSha256(task: (typeof tasks)[number]): string {
  return sha256(
    JSON.stringify({
      name: task.name,
      files: task.files,
      prompt: task.prompt,
      verifySource: task.verify.toString(),
    }),
  );
}

function serializeError(error: Error | undefined): TrialRecord['process']['error'] {
  if (!error) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return { name: error.name, message: error.message, ...(typeof code === 'string' ? { code } : {}) };
}

function copySessionArtifact(summary: UsageSummary | undefined, trialDir: string): string | undefined {
  if (!summary?.session || !summary.session.endsWith('.jsonl')) return undefined;
  try {
    const stat = lstatSync(summary.session);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return undefined;
    const target = join(trialDir, 'session.jsonl');
    copyFileSync(summary.session, target);
    chmodSync(target, 0o600);
    return basename(target);
  } catch {
    return undefined;
  }
}

function tail(value: string, lines = 4): string {
  return value.trim().split('\n').slice(-lines).join(' | ');
}

function main(): number {
  const options = parseOptions(process.argv.slice(2));
  const selected = tasks.filter((task) => !options.only || task.name === options.only);
  if (selected.length === 0) throw new Error(`no task named "${options.only}"`);

  const repository = resolve(import.meta.dirname, '..');
  const cliEntry = resolve(repository, 'packages', 'cli', 'dist', 'main.js');
  if (!existsSync(cliEntry)) throw new Error('CLI build is missing; run npm run build first');

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = resolve(options.outputDir ?? join('artifacts', 'eval', runId));
  mkdirSync(dirname(outputDir), { recursive: true });
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const trialsDir = join(outputDir, 'trials');
  mkdirSync(trialsDir, { mode: 0o700 });

  const commit = gitValue(['rev-parse', 'HEAD']);
  const dirty = Boolean(gitValue(['status', '--porcelain']));
  const sourceTree = sourceTreeSha256(repository);
  const harness = harnessEvidence(repository);
  const startedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    runId,
    status: 'running',
    startedAt,
    repository: { commit: commit ?? null, dirty, sourceTreeSha256: sourceTree ?? null },
    harness,
    evaluation: { tasksSourceSha256: sha256(readFileSync(resolve(repository, 'eval', 'tasks.ts'))) },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    configuration: {
      model: options.model ?? process.env['PI_MODEL'] ?? null,
      profile: options.profile ?? null,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs,
    },
    tasks: selected.map((task) => ({
      name: task.name,
      definitionSha256: taskDefinitionSha256(task),
    })),
    trials: [] as Array<{ task: string; pass: boolean; reason: string; artifact: string }>,
  };
  atomicJson(join(outputDir, 'manifest.json'), manifest);

  for (const task of selected) {
    const scratch = mkdtempSync(join(tmpdir(), `pi-eval-${task.name}-`));
    for (const [path, content] of Object.entries(task.files)) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      writeFileSync(join(scratch, path), content, 'utf8');
    }
    const workspaceBefore = snapshotWorkspace(scratch);
    const args = [
      cliEntry,
      '-p',
      '--usage',
      '--allow-host-bash',
      '--max-turns',
      String(options.maxTurns),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.profile ? ['--profile', options.profile] : []),
      task.prompt,
    ];
    const taskStartedAt = new Date().toISOString();
    const start = performance.now();
    const result: SpawnSyncReturns<string> = spawnSync('node', args, {
      cwd: scratch,
      encoding: 'utf8',
      timeout: options.timeoutMs,
    });
    const durationSeconds = (performance.now() - start) / 1_000;
    const taskFinishedAt = new Date().toISOString();
    const usage = parseUsageSummary(result.stderr ?? '');

    let verification: { passed: boolean; error?: string };
    try {
      verification = { passed: task.verify(scratch) };
    } catch (error) {
      verification = { passed: false, error: error instanceof Error ? error.message : String(error) };
    }
    let outcome = classifyEvalOutcome(result, verification, usage);
    const trialDir = join(trialsDir, task.name);
    mkdirSync(trialDir, { mode: 0o700 });
    writeFileSync(join(trialDir, 'stdout.txt'), result.stdout ?? '', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(join(trialDir, 'stderr.txt'), result.stderr ?? '', { encoding: 'utf8', mode: 0o600 });
    const sessionArtifact = copySessionArtifact(usage, trialDir);
    const definitionSha256 = taskDefinitionSha256(task);
    const serializedError = serializeError(result.error);
    let workspaceAfter: FileEvidence[] = [];
    let evidenceError: string | undefined;
    try {
      workspaceAfter = snapshotWorkspace(scratch);
    } catch (error) {
      evidenceError = error instanceof Error ? error.message : String(error);
      if (outcome.pass) outcome = { pass: false, reason: 'evidence_error', detail: evidenceError };
    }
    const record: TrialRecord = {
      schemaVersion: 1,
      task: task.name,
      taskDefinitionSha256: definitionSha256,
      startedAt: taskStartedAt,
      finishedAt: taskFinishedAt,
      durationSeconds,
      process: {
        status: result.status,
        signal: result.signal,
        ...(serializedError ? { error: serializedError } : {}),
      },
      verification,
      outcome,
      ...(usage ? { usage } : {}),
      workspaceBefore,
      workspaceAfter,
      ...(evidenceError ? { evidenceError } : {}),
      ...(sessionArtifact ? { sessionArtifact } : {}),
    };
    atomicJson(join(trialDir, 'result.json'), record);
    manifest.trials.push({
      task: task.name,
      pass: outcome.pass,
      reason: outcome.reason,
      artifact: relative(outputDir, join(trialDir, 'result.json')),
    });
    atomicJson(join(outputDir, 'manifest.json'), manifest);

    const calls = usage?.requests ?? '?';
    console.log(
      `${outcome.pass ? 'PASS' : 'FAIL'}  ${task.name}  (${durationSeconds.toFixed(1)}s, ${calls} calls, ${outcome.reason})`,
    );
    if (!outcome.pass) {
      const detail = outcome.detail ? `  ${outcome.detail}\n` : '';
      const diagnostic = tail(result.stderr ?? '');
      process.stdout.write(`${detail}${diagnostic ? `  stderr: ${diagnostic}\n` : ''}`);
    }
  }

  const passed = manifest.trials.filter((trial) => trial.pass).length;
  const finished = {
    ...manifest,
    status: passed === manifest.trials.length ? 'completed' : 'failed',
    finishedAt: new Date().toISOString(),
    summary: { passed, failed: manifest.trials.length - passed, total: manifest.trials.length },
  };
  atomicJson(join(outputDir, 'manifest.json'), finished);
  console.log(`\n${passed}/${manifest.trials.length} passed`);
  console.log(`artifacts: ${outputDir}`);
  return passed === manifest.trials.length ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
