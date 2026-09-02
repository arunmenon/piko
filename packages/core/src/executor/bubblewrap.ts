import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // their real paths so the worker resolves imports exactly as it would outside.
  for (const path of [spec.nodeInstallPrefix, spec.pikoPackageRoot]) {
    // A path already inside the workspace arrives through the read-write bind
    // below; binding it again read-only would take away writes piko expects.
    if (!isPathInsideWorkspace(spec.workspaceRoot, path)) readOnlyPaths.add(path);
  }
  for (const path of [...readOnlyPaths].sort()) argv.push('--ro-bind', path, path);
  argv.push('--bind', spec.workspaceRoot, spec.workspaceRoot);
  argv.push('--bind', privateTempDir, privateTempDir);
  argv.push('--chdir', spec.workspaceRoot);
  argv.push('--', spec.nodeExecutablePath, spec.workerEntryPath);
  return argv;
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
        onKilled: () => rmSync(privateTempDir, { recursive: true, force: true }),
      });
      try {
        await host.awaitReady();
      } catch (error) {
        host.kill();
        rmSync(privateTempDir, { recursive: true, force: true });
        throw error;
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
