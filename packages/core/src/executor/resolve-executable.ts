import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The shell name the bash tool hands to the operating system's PATH search. */
export const WORKER_SHELL_NAME = 'bash';

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
