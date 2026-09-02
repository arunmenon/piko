import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { forgetWorkerHost, registerWorkerHost, ToolWorkerHost, workerHostFor } from './worker-host.js';
import type {
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';

/** Seatbelt's driver. Present on every supported macOS; absent everywhere else. */
export const SEATBELT_BINARY = '/usr/bin/sandbox-exec';

/** System trees the worker may read. None of them is the user's home. */
const SYSTEM_READ_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/opt/homebrew',
  '/opt/local',
  '/private/etc',
  '/dev',
] as const;

/**
 * Directories a command inside the sandbox may execute out of. The package
 * prefixes are named whole rather than by their `bin` directory because the
 * entries in `bin` are usually symlinks into the package tree, and Seatbelt
 * judges the resolved target: `/opt/homebrew/bin` alone permits the link and
 * denies the binary it points at, which is how a hosted macOS runner produced
 * `spawn EPERM` for a Homebrew bash while `/bin/bash` would have been fine.
 */
const SYSTEM_EXECUTABLE_PATHS = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/libexec',
  '/usr/local',
  '/opt/homebrew',
  '/opt/local',
] as const;

/** Character devices a normal process writes to. Everything else under /dev is read-only. */
const WRITABLE_DEVICE_PATHS = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/dtracehelper',
] as const;

/**
 * The sysctl names node reads while starting, determined empirically on this
 * macOS host by tightening a blanket `(allow sysctl-read)` until node aborted
 * in `node::os::GetOSInformation` and then re-adding names until it started
 * again. Everything not named here is denied.
 */
export const NODE_STARTUP_SYSCTL_NAMES = [
  'kern.ostype',
  'kern.osrelease',
  'kern.osversion',
  'kern.osproductversion',
  'kern.version',
  'kern.hostname',
  'kern.boottime',
  'kern.argmax',
  'kern.maxfilesperproc',
  'kern.osvariant_status',
  'hw.machine',
  'hw.model',
  'hw.ncpu',
  'hw.activecpu',
  'hw.logicalcpu',
  'hw.physicalcpu',
  'hw.memsize',
  'hw.pagesize',
  'hw.pagesize_compat',
  'hw.byteorder',
  'hw.cpufrequency',
  'hw.cputype',
  'hw.cpusubtype',
  'hw.cpu64bit_capable',
  'machdep.cpu.brand_string',
] as const;

/** Quote one path as an SBPL string. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/** Every directory between the filesystem root and `path`, root included. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) return ancestors.reverse();
    current = parent;
  }
}

/**
 * Generate the Seatbelt profile for one workspace: deny by default, then the
 * smallest set of allowances that lets a node process start, run the five
 * tools, and shell out, with writes confined to the workspace and a private
 * temporary directory and with the network denied outright.
 *
 * The metadata allowances exist because node canonicalises the path of its
 * entry script: `realpath` lstats every component, so the ancestors of each
 * allowed tree need metadata even though their contents stay unreadable.
 */
export function seatbeltProfile(spec: SandboxSpec, privateTempDir: string): string {
  // Each executable's own directory, so a binary resolved outside the system
  // trees (a node under a hosted runner's tool cache, a shell inside a package
  // prefix) is readable and executable at the path Seatbelt will see.
  const executableDirectories = [...new Set(spec.executableRealPaths.map((path) => dirname(path)))].sort();
  const readPaths = [
    ...SYSTEM_READ_PATHS.filter((path) => existsSync(path)),
    spec.nodeInstallPrefix,
    spec.pikoPackageRoot,
    ...executableDirectories,
    spec.workspaceRoot,
    privateTempDir,
  ];
  const writePaths = [spec.workspaceRoot, privateTempDir];
  const metadataPaths = new Set<string>(['/', '/etc', '/tmp', '/var', '/private', '/private/var', '/private/tmp']);
  for (const path of [...readPaths, ...writePaths, ...spec.executableRealPaths]) {
    for (const ancestor of ancestorsOf(path)) metadataPaths.add(ancestor);
  }
  const executablePaths = [
    ...new Set([join(spec.nodeInstallPrefix, 'bin'), ...executableDirectories]),
    ...SYSTEM_EXECUTABLE_PATHS.filter((path) => existsSync(path)),
  ];
  const lines = [
    '(version 1)',
    '(deny default)',
    '; Networking is denied outright: the sandbox never talks to a model',
    '; provider, so there is no allowlist to get wrong (ADR 0018).',
    '(deny network*)',
    '(allow process-fork)',
    // Directories, then the exact resolved binaries. The literals are what make
    // this profile correct on a machine whose node or shell lives somewhere the
    // directory list does not name.
    `(allow process-exec ${executablePaths.map(sbplString).map((path) => `(subpath ${path})`).join(' ')} ${spec.executableRealPaths.map(sbplString).map((path) => `(literal ${path})`).join(' ')})`,
    `(allow file-read-metadata ${[...metadataPaths].sort().map(sbplString).map((path) => `(literal ${path})`).join(' ')})`,
    // The root directory node itself: node reads it while starting, and
    // granting the literal does not grant anything below it.
    `(allow file-read* (literal "/") ${readPaths.map(sbplString).map((path) => `(subpath ${path})`).join(' ')} ${spec.executableRealPaths.map(sbplString).map((path) => `(literal ${path})`).join(' ')})`,
    `(allow file-write* ${writePaths.map(sbplString).map((path) => `(subpath ${path})`).join(' ')} ${WRITABLE_DEVICE_PATHS.filter((path) => existsSync(path)).map(sbplString).map((path) => `(literal ${path})`).join(' ')} (regex #"^/dev/tty"))`,
    `(allow sysctl-read ${NODE_STARTUP_SYSCTL_NAMES.map((name) => `(sysctl-name ${sbplString(name)})`).join(' ')})`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Build the `sandbox-exec` argv that starts the worker under a profile. */
export function seatbeltCommandLine(spec: SandboxSpec, profile: string): string[] {
  return [SEATBELT_BINARY, '-p', profile, spec.nodeExecutablePath, spec.workerEntryPath];
}

export interface SeatbeltProviderOptions {
  /**
   * Profile generator. Overridable so a test can acquire under a deliberately
   * weakened profile and prove the self-test refuses it.
   */
  readonly profileFor?: (spec: SandboxSpec, privateTempDir: string) => string;
}

export function createSeatbeltProvider(options: SeatbeltProviderOptions = {}): SandboxProvider {
  const buildProfile = options.profileFor ?? seatbeltProfile;
  return {
    name: 'seatbelt',

    isAvailable(): boolean {
      return process.platform === 'darwin' && existsSync(SEATBELT_BINARY);
    },

    async acquire(spec: SandboxSpec): Promise<SandboxHandle> {
      // Canonical, because the sandbox policy is evaluated against resolved paths
      // and the platform temporary directory is commonly a symlink.
      const privateTempDir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-sandbox-')));
      const commandLine = seatbeltCommandLine(spec, buildProfile(spec, privateTempDir));
      const environment = {
        ...spec.environment,
        TMPDIR: privateTempDir,
        TEMP: privateTempDir,
        TMP: privateTempDir,
      };
      const host = new ToolWorkerHost(commandLine, {
        cwd: spec.workspaceRoot,
        environment,
        providerName: 'seatbelt',
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
        providerName: 'seatbelt',
        workspaceRoot: spec.workspaceRoot,
        privateTempDir,
        commandLine,
      };
      registerWorkerHost(handle, host);
      return handle;
    },

    exec(handle: SandboxHandle, request: SandboxExecRequest): Promise<SandboxExecResult> {
      const host = workerHostFor(handle);
      if (!host) return Promise.reject(new Error('this handle was not acquired from the Seatbelt provider'));
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

/** macOS provider using Seatbelt through `sandbox-exec` with a generated profile. */
export const seatbeltProvider: SandboxProvider = createSeatbeltProvider();
