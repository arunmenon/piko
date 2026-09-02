import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { WorkspaceDigest } from '../journal.js';
import { truncateMiddle } from '../truncate.js';
import { resolveWorkspacePath, resolveWorkspaceRoot } from './filesystem.js';
import {
  requireString,
  textOutput,
  type BashExecutionPolicy,
  type Tool,
  type ToolContext,
  type ToolOutput,
} from './types.js';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const MAX_BUFFER = 10_000_000;
const CWD_SENTINEL = '\x01PI_CWD\x01';
const SAFE_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  // ADR 0004 nesting depth. Allowlisted because a child is meant to see it, but
  // the inherited value is always replaced below with this process's depth plus
  // one: passing the parent's own number through would let every generation
  // claim the same depth and defeat --max-depth.
  'PI_DEPTH',
  // Required to locate executables on Windows environments that provide bash.
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

/** Environment variable carrying how deep this piko sits in a spawn tree (ADR 0004). */
export const DEPTH_ENVIRONMENT_NAME = 'PI_DEPTH';

/**
 * This process's nesting depth: 0 when unset (a root run), the inherited number
 * when it is a non-negative safe integer, and undefined when the value is
 * malformed so a controller can refuse to guess.
 */
export function readProcessDepth(environment: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = environment[DEPTH_ENVIRONMENT_NAME];
  if (raw === undefined || raw === '') return 0;
  const depth = Number(raw);
  if (!Number.isSafeInteger(depth) || depth < 0) return undefined;
  return depth;
}

/** Names this policy permits a child to inherit from the parent environment. */
function inheritedNames(policy?: BashExecutionPolicy): Set<string> {
  return new Set<string>([...SAFE_ENVIRONMENT_NAMES, ...(policy?.inheritEnvironment ?? [])]);
}

/**
 * Parent-environment names the sanitized child does not receive. Derived from the
 * child environment that was actually built rather than by re-deriving the policy,
 * so an opt-in or an explicit override is reflected without a second rule to keep
 * in step. Names only: no value is read.
 */
function strippedNames(childEnvironment: NodeJS.ProcessEnv): string[] {
  return Object.keys(process.env)
    .filter((name) => childEnvironment[name] === undefined)
    .sort();
}

/** Construct the deliberately small environment inherited by bash tools. */
export function sanitizedBashEnvironment(policy?: BashExecutionPolicy): NodeJS.ProcessEnv {
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  const inherit = inheritedNames(policy);
  for (const name of inherit) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  // A usable deterministic fallback when a parent launches pi without PATH.
  if (!environment['PATH']) environment['PATH'] = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  // ADR 0004: a piko spawned from this shell must see one level deeper than we
  // do, so --max-depth can stop an unbounded spawn chain. Set explicitly on
  // every call; a malformed inherited value counts as the root depth.
  environment[DEPTH_ENVIRONMENT_NAME] = String((readProcessDepth() ?? 0) + 1);
  for (const [name, value] of Object.entries(policy?.environment ?? {})) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

/** Total wall-clock budget for every git probe behind one workspace digest. */
export const WORKSPACE_DIGEST_TIMEOUT_MS = 2_000;

/**
 * Run one git probe under the remaining slice of the digest budget. Resolves to
 * undefined for every failure mode (git absent, not a checkout, slow, non-zero
 * exit), because a digest is a diagnostic aid and must never fail a tool call.
 */
function runGitProbe(
  gitArguments: readonly string[],
  cwd: string,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise((resolveProbe) => {
    execFile(
      'git',
      [...gitArguments],
      { cwd, timeout: timeoutMs, env: environment, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolveProbe(error ? undefined : stdout),
    );
  });
}

/**
 * Planning-time fingerprint of a workspace, recorded on a bash call's `planned`
 * row (ADR 0007). A resumer that finds the call `outcome_unknown` can recompute
 * this and tell whether the workspace moved underneath it.
 *
 * The digest is SHA-256 over `git rev-parse HEAD` plus `git status --porcelain=v1 -z`.
 * It is best-effort under a total 2 second budget: when git is absent, slow, or
 * the directory is not a checkout, the result is undefined and the planned row
 * simply carries no digest. An absent digest never means "unchanged".
 */
export async function workspaceDigestFor(
  workspace: string,
  policy?: BashExecutionPolicy,
): Promise<WorkspaceDigest | undefined> {
  const environment = sanitizedBashEnvironment(policy);
  const deadline = Date.now() + WORKSPACE_DIGEST_TIMEOUT_MS;
  const remaining = (): number => deadline - Date.now();
  let insideWorkTree: string | undefined;
  try {
    insideWorkTree = await runGitProbe(['rev-parse', '--is-inside-work-tree'], workspace, remaining(), environment);
  } catch {
    return undefined;
  }
  if (insideWorkTree?.trim() !== 'true') return undefined;
  // An unborn branch is still a checkout: HEAD contributes an empty string and
  // the porcelain status carries the whole state.
  const head = (await runGitProbe(['rev-parse', 'HEAD'], workspace, remaining(), environment)) ?? '';
  const status = await runGitProbe(['status', '--porcelain=v1', '-z'], workspace, remaining(), environment);
  if (status === undefined) return undefined;
  const digest = createHash('sha256').update(head.trim()).update('\0').update(status).digest('hex');
  return { kind: 'git', algorithm: 'sha256', digest, workspace };
}

interface BashResult {
  stdout: string;
  stderr: string;
  /** always holds the last ~1KB of stderr even past MAX_BUFFER, so the cwd sentinel survives noisy commands */
  stderrTail: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<BashResult> {
  // The sentinel (on stderr, control-char delimited) carries the final $PWD back so
  // `cd` persists across tool calls without any shell state living in this process.
  // Inherent limit: a command ending in `exit`/`exec` skips the sentinel — cwd just
  // doesn't update for that call.
  const script = `${command}\n__pi_exit=$?; printf '\\n${CWD_SENTINEL}%s' "$PWD" >&2; exit $__pi_exit`;
  return new Promise((resolvePromise) => {
    // detached => own process group, so timeout/abort can kill the whole tree
    const child = spawn('bash', ['-c', script], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      escalationTimer ??= setTimeout(() => killGroup('SIGKILL'), 2000);
      escalationTimer.unref();
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (stderr.length < MAX_BUFFER) stderr += text;
      stderrTail = (stderrTail + text).slice(-1024);
    });

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr, stderrTail, exitCode, timedOut, aborted: signal?.aborted ?? false });
    };
    child.on('error', (error) => {
      stderr += `${stderr.length > 0 ? '\n' : ''}${String(error)}`;
      settle(null);
    });
    // resolve on 'exit', not 'close': a surviving grandchild holding the pipes must not
    // stall the agent forever. The short delay collects already-buffered output and must
    // stay ref'd — it is the promise's resolution path.
    child.on('exit', (code, sig) => {
      // The direct shell may exit successfully after launching background jobs. Those
      // jobs are still part of this tool invocation and must not outlive its reported
      // terminal state. The shell owns a detached process group, so an unconditional
      // group kill here is harmless when it is empty and closes the common `cmd &`
      // deadline escape. An explicitly daemonized/setsid process is one reason this
      // capability remains documented as unsandboxed host execution.
      killGroup('SIGKILL');
      setTimeout(() => settle(code ?? (sig ? null : 0)), 25);
    });
  });
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run unsandboxed host bash from the project (search, git, tests, any CLI). It can access host files and network. Working directory persists across calls. Non-interactive commands only.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_seconds: { type: 'number', description: `default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}` },
    },
    required: ['command'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const command = requireString(args, 'command');
    if (context.policy?.bash?.allowHostExecution !== true) {
      return textOutput(
        'host bash execution is disabled by tool policy; run inside an isolated executor or explicitly allow host bash',
        true,
      );
    }
    const timeoutS = Math.min(
      typeof args['timeout_seconds'] === 'number' && args['timeout_seconds'] > 0
        ? args['timeout_seconds']
        : DEFAULT_TIMEOUT_S,
      MAX_TIMEOUT_S,
    );
    // Validate the configured root and current directory before starting a host
    // process. This does not replace an OS sandbox, but prevents persisted cwd
    // state from escaping the workspace boundary.
    resolveWorkspaceRoot(context);
    const executionCwd = resolveWorkspacePath(context, context.cwd, { allowAbsolute: true });
    if (!statSync(executionCwd).isDirectory()) throw new Error(`bash cwd is not a directory: ${executionCwd}`);
    const bashPolicy = context.policy?.bash;
    const environment = sanitizedBashEnvironment(bashPolicy);
    if (context.observePolicy) {
      const stripped = strippedNames(environment);
      if (stripped.length > 0) {
        await context.observePolicy({
          kind: 'environment_sanitized',
          strippedCount: stripped.length,
          strippedNames: stripped,
          allowlist: [...inheritedNames(bashPolicy)].sort(),
          allowlistSource:
            (bashPolicy?.inheritEnvironment?.length ?? 0) > 0 ||
            Object.keys(bashPolicy?.environment ?? {}).length > 0
              ? 'policy'
              : 'default',
        });
      }
    }
    const result = await runBash(command, executionCwd, timeoutS * 1000, environment, context.signal);

    let stderr = result.stderr;
    let cwdPolicyError: string | undefined;
    const tailIndex = result.stderrTail.lastIndexOf(CWD_SENTINEL);
    if (tailIndex !== -1) {
      const newCwd = result.stderrTail.slice(tailIndex + CWD_SENTINEL.length).trim();
      const inStderr = stderr.lastIndexOf(CWD_SENTINEL);
      if (inStderr !== -1) stderr = stderr.slice(0, inStderr).replace(/\n$/, '');
      if (newCwd && newCwd !== context.cwd) {
        try {
          const resolvedCwd = resolveWorkspacePath(context, newCwd, { allowAbsolute: true });
          if (!statSync(resolvedCwd).isDirectory()) throw new Error(`not a directory: ${resolvedCwd}`);
          context.setCwd(resolvedCwd);
        } catch (error) {
          cwdPolicyError = String(error);
        }
      }
    }

    let text = result.stdout;
    if (stderr.trim().length > 0) text += `${text.length > 0 ? '\n' : ''}[stderr]\n${stderr}`;
    text = truncateMiddle(text);
    // exitCode null (spawn failure or signal kill) is a failure, not a success
    const failed = result.timedOut || result.aborted || result.exitCode !== 0 || cwdPolicyError !== undefined;
    if (result.aborted) text += '\n[interrupted by user]';
    else if (result.timedOut) text += `\n[timed out after ${timeoutS}s]`;
    else if (result.exitCode !== 0) text += `\n[exit code ${result.exitCode ?? 'killed'}]`;
    if (cwdPolicyError) text += `\n[working directory rejected: ${cwdPolicyError}]`;
    return textOutput(text.trim().length > 0 ? text : '(no output)', failed);
  },
};
