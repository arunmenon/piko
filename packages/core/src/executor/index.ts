import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPathInsideWorkspace } from '../tools/filesystem.js';
import { sanitizedBashEnvironment } from '../tools/bash.js';
import { sessionsDirFor } from '../session.js';
import type { ToolExecutionPolicy } from '../tools/types.js';
import { bubblewrapProvider } from './bubblewrap.js';
import { seatbeltProvider } from './seatbelt.js';
import {
  bindSandboxExecutor,
  describeSelfTestFailure,
  selfTestPassed,
  type SandboxExecutor,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSelfTestChecks,
  type SandboxSpec,
  type SandboxToolPolicy,
} from './types.js';
import { workerHostFor } from './worker-host.js';

export * from './types.js';
export * from './protocol.js';
export {
  bubblewrapProvider,
  createBubblewrapProvider,
  bubblewrapCommandLine,
  bubblewrapStartupFailure,
  BUBBLEWRAP_BINARY,
  type BubblewrapProviderOptions,
} from './bubblewrap.js';
export {
  seatbeltProvider,
  createSeatbeltProvider,
  seatbeltProfile,
  seatbeltCommandLine,
  SEATBELT_BINARY,
  NODE_STARTUP_SYSCTL_NAMES,
  type SeatbeltProviderOptions,
} from './seatbelt.js';
export { ToolWorkerHost, WORKER_READY_TIMEOUT_MS } from './worker-host.js';

/** How the operator asked for the executor to be chosen (`--sandbox`). */
export type SandboxMode = 'auto' | 'off' | 'require';

/** Name of the parent-only variable the acquire-time self-test looks for. */
export const SELF_TEST_MARKER_NAME = 'PI_SANDBOX_SELFTEST_MARKER';

/** Wall-clock bound on the whole in-sandbox self-test. */
export const SELF_TEST_TIMEOUT_MS = 10_000;

/**
 * The built worker entry. Under `tsx` this module is the TypeScript source, but
 * the sandbox always runs built JavaScript, so a source-mode caller is pointed
 * at the dist output the ordinary build produces.
 */
export function resolveWorkerEntryPath(): string {
  const thisModulePath = fileURLToPath(import.meta.url);
  const candidates = thisModulePath.endsWith('.ts')
    ? [resolve(dirname(thisModulePath), '..', '..', 'dist', 'executor', 'worker.js')]
    : [resolve(dirname(thisModulePath), 'worker.js')];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`piko's sandbox worker is not built: expected ${candidates.join(' or ')}`);
}

/** The package root above a built file: the nearest ancestor with a package.json. */
export function resolvePikoPackageRoot(builtFilePath: string): string {
  let directory = dirname(builtFilePath);
  while (true) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`no package.json above ${builtFilePath}, so the sandbox cannot bind piko's own code`);
    }
    directory = parent;
  }
}

/** The installation prefix of a node binary, so its libraries come with it. */
export function resolveNodeInstallPrefix(nodeExecutablePath: string): string {
  const binDirectory = dirname(nodeExecutablePath);
  return basename(binDirectory) === 'bin' ? dirname(binDirectory) : binDirectory;
}

/** The shell name the bash tool hands to the operating system's PATH search. */
export const WORKER_SHELL_NAME = 'bash';

/**
 * Resolve a bare binary name the way the worker's own `spawn` will: first match
 * on the PATH the worker is given, followed through symlinks. Returns undefined
 * when nothing on that PATH answers to the name.
 */
export function resolveExecutableOnPath(binaryName: string, pathVariable: string): string | undefined {
  for (const directory of pathVariable.split(':')) {
    if (directory.length === 0) continue;
    const candidate = join(directory, binaryName);
    try {
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isFile()) return resolved;
    } catch {
      // Not on this PATH entry; keep looking.
    }
  }
  return undefined;
}

/**
 * Every binary the sandbox must be allowed to execute, canonicalised on this
 * host. The node that runs the worker, the shell the worker's bash tool spawns
 * (resolved through the same PATH the worker gets, so a Homebrew bash ahead of
 * `/bin/bash` is the one permitted), and `/bin/bash` itself as the fallback the
 * system always has.
 */
export function resolveExecutableRealPaths(pathVariable: string): string[] {
  const paths = new Set<string>();
  paths.add(realpathSync(process.execPath));
  const shell = resolveExecutableOnPath(WORKER_SHELL_NAME, pathVariable);
  if (shell !== undefined) paths.add(shell);
  try {
    paths.add(realpathSync('/bin/bash'));
  } catch {
    // No /bin/bash on this platform; the PATH lookup above is the whole answer.
  }
  return [...paths].sort();
}

/**
 * Canonicalise a path that may not exist yet by resolving its deepest existing
 * ancestor and re-attaching the rest. A session directory is created lazily, so
 * comparing it against a canonical workspace root needs this rather than a
 * plain `resolve`: on macOS the two would otherwise differ by /private alone.
 */
function canonicalizeMissingPath(path: string): string {
  const suffix: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return resolve(realpathSync(candidate), ...suffix);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/** Everything a provider needs to build a sandbox for one workspace. */
export function buildSandboxSpec(workspaceRoot: string): SandboxSpec {
  const workerEntryPath = realpathSync(resolveWorkerEntryPath());
  const nodeExecutablePath = realpathSync(process.execPath);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizedBashEnvironment())) {
    if (value !== undefined) environment[name] = value;
  }
  return {
    workspaceRoot: realpathSync(workspaceRoot),
    nodeExecutablePath,
    nodeInstallPrefix: resolveNodeInstallPrefix(nodeExecutablePath),
    pikoPackageRoot: resolvePikoPackageRoot(workerEntryPath),
    workerEntryPath,
    environment,
    // Resolved against the PATH the worker will actually search, not this
    // process's own, so the permitted shell is the one the worker will find.
    executableRealPaths: resolveExecutableRealPaths(environment['PATH'] ?? ''),
  };
}

/**
 * The serializable projection of a tool policy that crosses into the worker.
 * Approvals, telemetry, and the executor handle itself stay in the parent; the
 * worker is told only what it needs to apply piko's own containment rules.
 *
 * `bash.allowHostExecution` inside the worker is the sandboxed-execution gate:
 * the shell the worker starts is the sandbox's shell, so enabling it there does
 * not enable host bash, which keeps its own separate flag.
 */
export function sandboxToolPolicy(policy: ToolExecutionPolicy, workspaceRoot: string): SandboxToolPolicy {
  return {
    workspaceRoot: policy.workspaceRoot ?? workspaceRoot,
    ...(policy.allowAbsolutePaths === true ? { allowAbsolutePaths: true } : {}),
    ...(policy.allowProtectedPaths === true ? { allowProtectedPaths: true } : {}),
    bash: {
      allowHostExecution: policy.bash?.sandboxedExecution === true,
      ...(policy.bash?.inheritEnvironment ? { inheritEnvironment: policy.bash.inheritEnvironment } : {}),
      ...(policy.bash?.environment ? { environment: policy.bash.environment } : {}),
    },
  };
}

interface SelfTestFixture {
  readonly canaryPath: string;
  readonly canaryDirectory: string;
  readonly listener: Server;
  readonly probePort: number;
  readonly markerValue: string;
}

/**
 * Set up the three things the self-test needs from the parent side: a file
 * outside the workspace, a real listener on loopback, and a marker variable in
 * this process's own environment. The marker is set before any provider builds
 * the child environment, so the check exercises the code that builds it.
 */
async function openSelfTestFixture(workspaceRoot: string): Promise<SelfTestFixture> {
  const canaryDirectory = mkdtempSync(join(tmpdir(), 'pi-sandbox-canary-'));
  if (isPathInsideWorkspace(workspaceRoot, realpathSync(canaryDirectory))) {
    rmSync(canaryDirectory, { recursive: true, force: true });
    throw new Error('the temporary directory is inside the workspace, so the canary check cannot mean anything');
  }
  const canaryPath = join(canaryDirectory, 'canary.txt');
  writeFileSync(canaryPath, `pi-sandbox-canary-${randomBytes(16).toString('hex')}\n`, { mode: 0o600 });
  const listener = createServer((socket) => socket.destroy());
  listener.unref();
  // The port has to be real before the worker is told to dial it: a refused
  // connection to a port nobody is listening on would prove nothing.
  await new Promise<void>((resolveListening, rejectListening) => {
    listener.once('error', rejectListening);
    listener.listen(0, '127.0.0.1', () => resolveListening());
  });
  const address = listener.address();
  const probePort = typeof address === 'object' && address !== null ? address.port : 0;
  const markerValue = randomBytes(16).toString('hex');
  process.env[SELF_TEST_MARKER_NAME] = markerValue;
  return { canaryPath, canaryDirectory, listener, probePort, markerValue };
}

function closeSelfTestFixture(fixture: SelfTestFixture): void {
  delete process.env[SELF_TEST_MARKER_NAME];
  fixture.listener.close();
  rmSync(fixture.canaryDirectory, { recursive: true, force: true });
}

/**
 * Run the acquire-time self-test inside an already-acquired sandbox. The three
 * checks are the minimum that distinguishes a real boundary from a process that
 * merely started: a file outside the workspace stays unreadable, a connection
 * to a listener that genuinely exists still fails, and a variable this process
 * really has is not there.
 */
export async function runSandboxSelfTest(
  handle: SandboxHandle,
  fixture: { canaryPath: string; probePort: number },
): Promise<SandboxSelfTestChecks> {
  const host = workerHostFor(handle);
  if (!host) throw new Error('this sandbox handle has no worker to test');
  if (fixture.probePort === 0) throw new Error('the self-test listener did not get a port');
  return host.selfTest({
    canaryPath: fixture.canaryPath,
    probePort: fixture.probePort,
    markerName: SELF_TEST_MARKER_NAME,
    timeoutMs: SELF_TEST_TIMEOUT_MS,
  });
}

/**
 * Acquire one provider and prove it before using it. A provider that acquires
 * but fails any check is released and reported, never used: falling back to the
 * host silently is the one outcome ADR 0018 forbids.
 */
export async function acquireVerifiedExecutor(
  provider: SandboxProvider,
  workspaceRoot: string,
): Promise<{ executor: SandboxExecutor } | { refusal: string }> {
  let fixture: SelfTestFixture;
  try {
    fixture = await openSelfTestFixture(workspaceRoot);
  } catch (error) {
    return { refusal: `${provider.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let handle: SandboxHandle | undefined;
  try {
    const spec = buildSandboxSpec(workspaceRoot);
    handle = await provider.acquire(spec);
    const checks = await runSandboxSelfTest(handle, fixture);
    if (!selfTestPassed(checks)) {
      const failure = describeSelfTestFailure(checks) ?? 'a self-test check failed';
      await provider.release(handle);
      return { refusal: `${provider.name}: ${failure}` };
    }
    return { executor: bindSandboxExecutor(provider, handle) };
  } catch (error) {
    if (handle) await provider.release(handle).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return { refusal: `${provider.name}: ${message.replace(/\s+/gu, ' ').slice(0, 300)}` };
  } finally {
    closeSelfTestFixture(fixture);
  }
}

/** Providers in the order ADR 0018's R0-1 amendment puts them: lightweight first. */
export function defaultSandboxProviders(): readonly SandboxProvider[] {
  return [bubblewrapProvider, seatbeltProvider];
}

export interface SandboxSelection {
  /** The executor to install on the tool policy, or undefined when there is none. */
  readonly executor?: SandboxExecutor;
  /** One line for stderr naming the provider in use, or why there is none. */
  readonly summary: string;
  /** Per-provider refusals, in the order they were tried. */
  readonly refusals: readonly string[];
}

export interface SelectSandboxExecutorOptions {
  readonly workspaceRoot: string;
  readonly mode: SandboxMode;
  /** Overridable so tests can drive one specific provider. */
  readonly providers?: readonly SandboxProvider[];
}

/**
 * Choose an executor for this run. `off` never looks; `auto` and `require` try
 * each available provider in order and keep the first whose self-test passes.
 * Deciding what an empty result means is the caller's job: `require` turns it
 * into a refusal to start, `auto` into today's behaviour.
 */
export async function selectSandboxExecutor(options: SelectSandboxExecutorOptions): Promise<SandboxSelection> {
  if (options.mode === 'off') {
    return { summary: 'sandbox: off by --sandbox off; tool effects run in this process', refusals: [] };
  }
  // ADR 0018's first non-negotiable: the session store is never inside a
  // sandbox mount. A workspace that happens to contain this run's session
  // directory (a home directory opened as the workspace, say) would put the
  // journal inside the boundary, so no sandbox is offered at all rather than
  // one that hands the model its own history.
  const sessionDirectory = sessionsDirFor(options.workspaceRoot);
  if (isPathInsideWorkspace(realpathSync(options.workspaceRoot), canonicalizeMissingPath(sessionDirectory))) {
    return {
      summary: `sandbox: refused because this run's session store (${sessionDirectory}) is inside the workspace and must stay outside every mount; tool effects run in this process`,
      refusals: [],
    };
  }
  const providers = options.providers ?? defaultSandboxProviders();
  const available = providers.filter((provider) => provider.isAvailable());
  if (available.length === 0) {
    const names = providers.map((provider) => provider.name).join(', ') || 'none';
    return {
      summary: `sandbox: no provider available on this host (looked for ${names}); tool effects run in this process`,
      refusals: [],
    };
  }
  const refusals: string[] = [];
  for (const provider of available) {
    const outcome = await acquireVerifiedExecutor(provider, options.workspaceRoot);
    if ('executor' in outcome) {
      return {
        executor: outcome.executor,
        summary: `sandbox: ${provider.name} provider active; the five tools run inside it and only the workspace is writable`,
        refusals,
      };
    }
    refusals.push(outcome.refusal);
  }
  return {
    summary: `sandbox: no provider passed its self-test (${refusals.join('; ')}); tool effects run in this process`,
    refusals,
  };
}
