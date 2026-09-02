import type { ToolOutput, ToolPolicyObservation } from '../tools/types.js';

/**
 * The five built-in tools whose effects the executor is allowed to run. An
 * extension tool never crosses the seam: extensions are trusted controller
 * code (ADR 0012) that runs in the parent process, and the worker only hosts
 * piko's own tool implementations.
 */
export const SANDBOXED_TOOL_NAMES: readonly string[] = ['read', 'write', 'edit', 'map', 'bash'];

/**
 * The serializable part of a ToolExecutionPolicy: what the worker needs to
 * enforce piko's own containment rules inside the sandbox. Deliberately does
 * not carry `approval` (a control-plane concern that stays in the parent) or
 * `executor` (which is not serializable and would be a recursion anyway).
 */
export interface SandboxToolPolicy {
  readonly workspaceRoot: string;
  readonly allowAbsolutePaths?: boolean;
  readonly allowProtectedPaths?: boolean;
  readonly bash?: {
    readonly allowHostExecution?: boolean;
    readonly inheritEnvironment?: readonly string[];
    readonly environment?: Readonly<Record<string, string | undefined>>;
  };
}

/** What a provider needs in order to build a sandbox for one workspace. */
export interface SandboxSpec {
  /** Canonical workspace root, bound read-write at its own path inside the sandbox. */
  readonly workspaceRoot: string;
  /** Canonical path of the node binary that runs the worker. */
  readonly nodeExecutablePath: string;
  /** Installation prefix of that node binary, made readable so it can start. */
  readonly nodeInstallPrefix: string;
  /** Package root holding piko's built worker (the directory with its package.json). */
  readonly pikoPackageRoot: string;
  /**
   * Canonical paths of the binaries the worker is known to execute: the node
   * that runs it and the shell its bash tool spawns. These are resolved through
   * `realpath` on the host the sandbox will run on, because a sandbox policy is
   * evaluated against resolved paths. A machine where `bash` is a symlink into
   * a package directory (Homebrew's `/opt/homebrew/bin/bash` pointing into
   * `Cellar/`, for instance) needs the target permitted, not the link.
   */
  readonly executableRealPaths: readonly string[];
  /**
   * The shell the worker's bash tool will reach on this PATH, resolved. Named
   * separately from the list above because a failure to start it is the one
   * self-test result worth quoting back to a human verbatim.
   */
  readonly shellExecutablePath: string | undefined;
  /** Built worker entry the sandbox executes. */
  readonly workerEntryPath: string;
  /** The sanitized allowlist environment the worker process receives. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Test-only: start the worker with ADR 0022's containment barrier bridge, so
   * an acceptance test can pause the worker at a named point of the shipped
   * implementation and perform a parent swap from outside it. Never set on the
   * CLI path, and reachable only from this spec: the worker takes it as an argv
   * flag, never from its environment. Absent, the worker registers nothing and
   * the barrier registry stays the empty map production runs with.
   */
  readonly containmentBarrierChannel?: boolean;
}

/** A live sandbox with a tool worker running inside it. */
export interface SandboxHandle {
  readonly providerName: string;
  readonly workspaceRoot: string;
  /** Writable scratch directory the sandbox owns, outside the workspace. */
  readonly privateTempDir: string;
  /** How the sandbox was launched, for the addendum and for diagnostics. */
  readonly commandLine: readonly string[];
}

export interface SandboxExecRequest {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly policy: SandboxToolPolicy;
  /** Working directory the call starts from; bash's `cd` persistence rides on this. */
  readonly cwd: string;
  /** The turn's cancellation signal. Cancelling asks the worker to abort the call. */
  readonly signal?: AbortSignal;
}

export interface SandboxExecResult {
  readonly result: ToolOutput;
  /** The worker's working directory after the call, so the parent stays in step. */
  readonly cwd: string;
  /** Policy outcomes observed inside the worker, replayed by the parent's observer. */
  readonly observations: readonly ToolPolicyObservation[];
}

/**
 * The narrow provider seam of ADR 0018: acquire a sandbox, execute in it,
 * release it. Nothing about images, mounts, or profiles leaks past this.
 */
export interface SandboxProvider {
  readonly name: string;
  /** True when this provider's binary exists on this host. Not a usability claim. */
  isAvailable(): boolean;
  acquire(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, request: SandboxExecRequest): Promise<SandboxExecResult>;
  release(handle: SandboxHandle): Promise<void>;
}

/**
 * An acquired handle bound to the provider that made it. This is what
 * `ToolExecutionPolicy.executor` carries: the agent loop holds one of these and
 * never sees a provider or a spec.
 */
export interface SandboxExecutor {
  readonly providerName: string;
  readonly workspaceRoot: string;
  readonly commandLine: readonly string[];
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  release(): Promise<void>;
}

/** Bind a handle to its provider so the agent loop can call it directly. */
export function bindSandboxExecutor(provider: SandboxProvider, handle: SandboxHandle): SandboxExecutor {
  return {
    providerName: handle.providerName,
    workspaceRoot: handle.workspaceRoot,
    commandLine: handle.commandLine,
    exec: (request) => provider.exec(handle, request),
    release: () => provider.release(handle),
  };
}

/** One acquire-time proof that the sandbox is real, run inside the sandbox. */
export interface SandboxSelfTestChecks {
  /** Reading a canary file outside the workspace must fail. */
  readonly canaryReadRefused: boolean;
  readonly canaryDetail: string;
  /** Connecting to a listener the parent opened on loopback must fail. */
  readonly networkConnectRefused: boolean;
  readonly networkDetail: string;
  /** A marker variable present in the parent environment must be absent here. */
  readonly parentMarkerAbsent: boolean;
  readonly markerDetail: string;
  /**
   * The worker must be able to start a child process: the shell at the absolute
   * path this spec resolved, run as `<shell> -c true` through the same spawn
   * path the bash tool uses, which is the same absolute path. A sandbox that
   * hosts four tools and refuses the fifth is worse than no sandbox, because it
   * looks like it works. The bare-name spelling is reported in the detail as a
   * diagnostic and does not decide this flag.
   */
  readonly childProcessStarted: boolean;
  readonly childProcessDetail: string;
}

/** True only when all three checks held. */
export function selfTestPassed(checks: SandboxSelfTestChecks): boolean {
  return (
    checks.canaryReadRefused &&
    checks.networkConnectRefused &&
    checks.parentMarkerAbsent &&
    checks.childProcessStarted
  );
}

/** One line naming the first failed check, for a refusal message. */
export function describeSelfTestFailure(checks: SandboxSelfTestChecks): string | undefined {
  if (!checks.canaryReadRefused) return `a file outside the workspace was readable inside it (${checks.canaryDetail})`;
  if (!checks.networkConnectRefused) return `a network connection succeeded inside it (${checks.networkDetail})`;
  if (!checks.parentMarkerAbsent) return `a parent environment variable was visible inside it (${checks.markerDetail})`;
  if (!checks.childProcessStarted) return `the sandbox profile does not permit starting a shell: ${checks.childProcessDetail}`;
  return undefined;
}
