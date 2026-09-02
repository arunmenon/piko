import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The shell name a bash tool hands to the operating system's PATH search. */
export const WORKER_SHELL_NAME = 'bash';

/**
 * argv flag carrying the parent-resolved shell path into the worker.
 *
 * It travels on argv rather than in the environment for the same reason ADR
 * 0022's barrier flag does: an argv element can only come from the acquire
 * spec, and the worker's bash tool must spawn the binary the sandbox profile
 * was built around rather than whatever a PATH search inside the sandbox
 * happens to reach first.
 */
export const WORKER_SHELL_PATH_FLAG = '--pi-shell-path';

/** The argv fragment carrying a resolved shell path, empty when there is none. */
export function shellPathArguments(shellExecutablePath: string | undefined): string[] {
  return shellExecutablePath === undefined ? [] : [`${WORKER_SHELL_PATH_FLAG}=${shellExecutablePath}`];
}

/** The shell path the parent put on this argv, or undefined when it named none. */
export function readShellPathArgument(argv: readonly string[]): string | undefined {
  const prefix = `${WORKER_SHELL_PATH_FLAG}=`;
  const named = argv.find((argument) => argument.startsWith(prefix));
  if (named === undefined) return undefined;
  const shellExecutablePath = named.slice(prefix.length);
  return shellExecutablePath.length > 0 ? shellExecutablePath : undefined;
}

/**
 * Resolve a bare binary name the way a spawn will: first match on the given
 * PATH, followed through symlinks. Returns undefined when nothing on that PATH
 * answers to the name.
 *
 * This lives in its own module because both sides of the seam need it and
 * neither may drag in the other: the parent uses it to decide what a sandbox
 * profile has to permit, and the worker uses it inside the sandbox to report
 * which binary it would actually reach.
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
