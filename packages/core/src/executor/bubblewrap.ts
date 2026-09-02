import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isPathInsideWorkspace } from '../tools/filesystem.js';
import { forgetWorkerHost, registerWorkerHost, ToolWorkerHost, workerHostFor } from './worker-host.js';
import type {
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';

/** The bubblewrap binary, looked up on PATH the way any other tool would be. */
export const BUBBLEWRAP_BINARY = 'bwrap';

/**
 * System paths bound read-only when they exist. This is the set a dynamically
 * linked node needs to start plus the shell and the standard tool directories
 * bash reaches for. Nothing here is writable and nothing here is the user's
 * home, so the session store, the configuration, and the credentials stay
 * outside every mount (ADR 0018).
 */
const SYSTEM_READ_ONLY_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/passwd',
  '/etc/group',
  '/etc/localtime',
  '/nix/store',
] as const;

/** True when a binary named `bwrap` is resolvable on this host. */
function bubblewrapAvailable(): boolean {
  const pathVariable = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  return pathVariable
    .split(':')
    .filter((directory) => directory.length > 0)
    .some((directory) => existsSync(join(directory, BUBBLEWRAP_BINARY)));
}

/**
 * Build the bwrap argv for one workspace. Networking is absent by construction:
 * `--unshare-all` includes the network namespace, so there is no egress policy
 * to get wrong and nothing to allowlist.
 *
 * Why `--unshare-all` stays, even though it is what fails on a restricted
 * runner. bubblewrap configures the loopback interface itself whenever it
 * creates a network namespace (`loopback_setup()` runs unconditionally under
 * `opt_unshare_net` and calls `die()` on failure), and it exposes no option to
 * skip that step. Ubuntu 24.04 hosts with
 * `kernel.apparmor_restrict_unprivileged_userns=1` create the namespace but
 * withhold the capability the loopback configuration needs, which is the
 * `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` seen on GitHub
 * runners. The alternatives are all worse: `--share-net` would keep the host
 * network, which is the one thing ADR 0018 forbids; dropping `--unshare-user`
 * only works when bwrap is installed setuid, which the Ubuntu package is not;
 * and `--disable-userns` restricts what the sandbox may create afterwards and
 * does not touch this. So the invocation stays correct and the provider fails
 * closed instead: `acquire` reports the bwrap message and the run falls back to
 * the contained in-process path rather than to an unsandboxed network. Fixing
 * the host (that sysctl, or a setuid bwrap) is what makes the provider usable.
 * Not verified on a Linux host by the author of this comment; the reasoning is
 * from bubblewrap's source and the CI failure text.
 */
export function bubblewrapCommandLine(spec: SandboxSpec, privateTempDir: string): string[] {
  const argv: string[] = [
    BUBBLEWRAP_BINARY,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  const readOnlyPaths = new Set<string>();
  for (const path of SYSTEM_READ_ONLY_PATHS) if (existsSync(path)) readOnlyPaths.add(path);
  // The node installation and piko's own built code are what the worker is; a
  // sandbox that cannot see them cannot start. Both are bound read-only at
  // their real paths so the worker resolves imports exactly as it would
  // outside. The resolved binaries' own directories come with them, for a node
  // or a shell that sits outside the system trees above (a hosted runner's tool
  // cache, a package prefix).
  const executableDirectories = spec.executableRealPaths.map((path) => dirname(path));
  for (const path of [spec.nodeInstallPrefix, spec.pikoPackageRoot, ...executableDirectories]) {
    // A path already inside the workspace arrives through the read-write bind
    // below; binding it again read-only would take away writes piko expects.
    // Existence is checked because a bind of a missing source aborts bwrap.
    if (!isPathInsideWorkspace(spec.workspaceRoot, path) && existsSync(path)) readOnlyPaths.add(path);
  }
  for (const path of [...readOnlyPaths].sort()) argv.push('--ro-bind', path, path);
  argv.push('--bind', spec.workspaceRoot, spec.workspaceRoot);
  argv.push('--bind', privateTempDir, privateTempDir);
  argv.push('--chdir', spec.workspaceRoot);
  argv.push('--', spec.nodeExecutablePath, spec.workerEntryPath);
  return argv;
}

/**
 * Say what a failed `bwrap` start means, where the message alone would not.
 * The loopback failure in particular reads like a bug in piko and is not one:
 * it is a host whose unprivileged user namespaces are capability-restricted.
 */
export function bubblewrapStartupFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/RTM_NEWADDR|loopback/u.test(message)) return message;
  return (
    `${message}. This host creates the network namespace but withholds the capability bubblewrap ` +
    'needs to bring up loopback inside it, which is what Ubuntu 24.04 does with ' +
    'kernel.apparmor_restrict_unprivileged_userns=1. piko will not drop --unshare-all to work ' +
    'around it, because sharing the host network is the one thing this sandbox exists to prevent.'
  );
}

export interface BubblewrapProviderOptions {
  /**
   * Command-line generator. Overridable so a test can acquire under a
   * deliberately weakened sandbox and prove the self-test refuses it.
   */
  readonly commandLineFor?: (spec: SandboxSpec, privateTempDir: string) => string[];
}

/**
 * Linux provider. Seccomp filtering is deliberately not attempted here: bwrap
 * takes a compiled BPF program on a file descriptor, and shipping one would
 * mean either a native dependency or a hand-assembled filter that nothing in
 * this repository can test. It is recorded as deferred rather than faked.
 */
export function createBubblewrapProvider(options: BubblewrapProviderOptions = {}): SandboxProvider {
  const buildCommandLine = options.commandLineFor ?? bubblewrapCommandLine;
  return {
    name: 'bubblewrap',

    isAvailable(): boolean {
      return process.platform === 'linux' && bubblewrapAvailable();
    },

    async acquire(spec: SandboxSpec): Promise<SandboxHandle> {
      // Canonical, because the platform temporary directory is commonly a
      // symlink and a bind source has to be the real path.
      const privateTempDir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-sandbox-')));
      const commandLine = buildCommandLine(spec, privateTempDir);
      const environment = {
        ...spec.environment,
        TMPDIR: privateTempDir,
        TEMP: privateTempDir,
        TMP: privateTempDir,
      };
      const host = new ToolWorkerHost(commandLine, {
        cwd: spec.workspaceRoot,
        environment,
        providerName: 'bubblewrap',
        onKilled: () => rmSync(privateTempDir, { recursive: true, force: true }),
      });
      try {
        await host.awaitReady();
      } catch (error) {
        host.kill();
        rmSync(privateTempDir, { recursive: true, force: true });
        throw new Error(bubblewrapStartupFailure(error));
      }
      const handle: SandboxHandle = {
        providerName: 'bubblewrap',
        workspaceRoot: spec.workspaceRoot,
        privateTempDir,
        commandLine,
      };
      registerWorkerHost(handle, host);
      return handle;
    },

    exec(handle: SandboxHandle, request: SandboxExecRequest): Promise<SandboxExecResult> {
      const host = workerHostFor(handle);
      if (!host) return Promise.reject(new Error('this handle was not acquired from the bubblewrap provider'));
      return host.execute(request);
    },

    async release(handle: SandboxHandle): Promise<void> {
      // kill() removes the private temporary directory through onKilled, so a
      // released sandbox and a killed process leave the same nothing behind.
      workerHostFor(handle)?.kill();
      forgetWorkerHost(handle);
      rmSync(handle.privateTempDir, { recursive: true, force: true });
    },
  };
}

/** Linux provider using bubblewrap with the namespaces ADR 0018 requires. */
export const bubblewrapProvider: SandboxProvider = createBubblewrapProvider();
