import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolContext } from './types.js';

export class ToolPolicyError extends Error {
  override readonly name = 'ToolPolicyError';
}

/**
 * Named points where the path-based implementation stops holding a checked
 * result and re-traverses it. Those are exactly the windows a parent swap
 * wins, so ADR 0022's acceptance regression drives its attacks from here.
 */
export type ContainmentBarrierName =
  | 'after-resolve'
  | 'before-open'
  | 'before-mkdir'
  | 'before-temp-create'
  | 'before-rename'
  | 'before-cleanup'
  | 'before-map-directory-open';

/**
 * Test-only seam: a barrier registered under one of the names above runs at
 * that point with the path the next step is about to act on. Empty in
 * production, where the whole cost is one Map lookup per point. Nothing in the
 * shipped code registers a barrier, and no barrier may change a result: the
 * containment tests use it to perform a swap mid-call so the attack runs
 * inside a real `Tool.execute()` instead of beside it.
 */
export const containmentBarriers = new Map<ContainmentBarrierName, (path: string) => void>();

/** Run the barrier registered at `barrierName`, if any. */
export function runContainmentBarrier(barrierName: ContainmentBarrierName, path: string): void {
  const barrier = containmentBarriers.get(barrierName);
  if (barrier === undefined) return;
  barrier(path);
}

export interface ResolveWorkspacePathOptions {
  /** Require the final path to exist (default true). */
  readonly mustExist?: boolean;
  /** Internal callers may validate an absolute path such as bash's resulting $PWD. */
  readonly allowAbsolute?: boolean;
  /**
   * The caller intends to create, replace, or delete this path, so the
   * protected-path deny list applies (ADR 0006 addendum, 2026-09-02). Reads
   * leave this unset.
   */
  readonly forMutation?: boolean;
}

/**
 * Directories the file tools never write into, at any depth below the
 * workspace root. `.git/` is refused wholesale because git changes go through
 * bash, so no file-tool workflow needs it; the others carry harness and agent
 * configuration that must not be rewritten by the model it configures.
 */
const PROTECTED_DIRECTORY_NAMES = new Set(['.git', '.pi', '.agent', '.claude']);

/** Files the file tools never write, at the workspace root only. */
const PROTECTED_WORKSPACE_ROOT_FILES = new Set([
  'AGENTS.md',
  '.mcp.json',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
]);

/** Case-folded lookups, used only on a filesystem that folds case itself. */
const PROTECTED_DIRECTORY_NAMES_FOLDED = new Map(
  [...PROTECTED_DIRECTORY_NAMES].map((name) => [name.toLowerCase(), name] as const),
);
const PROTECTED_WORKSPACE_ROOT_FILES_FOLDED = new Set(
  [...PROTECTED_WORKSPACE_ROOT_FILES].map((name) => name.toLowerCase()),
);

/** One answer per workspace root, probed once (ADR 0006 addendum, 2026-09-02). */
const workspaceCaseFoldingByRoot = new Map<string, boolean>();

/** The same name with the case of its first flippable letter inverted. */
function caseFlippedName(name: string): string | undefined {
  for (let index = 0; index < name.length; index++) {
    const character = name[index]!;
    const lowered = character.toLowerCase();
    const flipped = character === lowered ? character.toUpperCase() : lowered;
    if (flipped !== character) return `${name.slice(0, index)}${flipped}${name.slice(index + 1)}`;
  }
  return undefined;
}

/** True when `otherPath` names the very same inode as `stat`. */
function resolvesToSameFile(stat: Stats, otherPath: string): boolean {
  let other: Stats;
  try {
    other = statSync(otherPath);
  } catch {
    return false;
  }
  return other.dev === stat.dev && other.ino === stat.ino;
}

/**
 * Ask the filesystem, rather than the platform, whether it folds case: stat the
 * root under a case-flipped spelling of its own last segment and compare
 * inodes. A root whose name carries no flippable letter gets a probe file
 * instead. Any failure answers "folds", which keeps the deny list at its widest.
 */
function probeCaseFolding(workspaceRoot: string): boolean {
  try {
    const flippedRootName = caseFlippedName(basename(workspaceRoot));
    if (flippedRootName !== undefined) {
      return resolvesToSameFile(statSync(workspaceRoot), resolve(dirname(workspaceRoot), flippedRootName));
    }
    const probeName = `.pi-case-probe-${process.pid}-${randomUUID()}a`;
    const probePath = resolve(workspaceRoot, probeName);
    closeSync(openSync(probePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    try {
      return resolvesToSameFile(statSync(probePath), resolve(workspaceRoot, caseFlippedName(probeName)!));
    } finally {
      unlinkSync(probePath);
    }
  } catch {
    return true;
  }
}

/**
 * Whether this workspace's filesystem folds path case, probed once per root and
 * cached. Exported so tests can state which half of the deny-list contract
 * applies on the filesystem they are running on.
 */
export function workspaceFoldsPathCase(workspaceRoot: string): boolean {
  const cached = workspaceCaseFoldingByRoot.get(workspaceRoot);
  if (cached !== undefined) return cached;
  const foldsCase = probeCaseFolding(workspaceRoot);
  workspaceCaseFoldingByRoot.set(workspaceRoot, foldsCase);
  return foldsCase;
}

/**
 * Name the deny-list rule a canonical path breaks, or undefined when it breaks
 * none. Segment comparison follows the workspace filesystem: on one that folds
 * case, `.GIT/hooks/pre-commit` is the same file as `.git/hooks/pre-commit` and
 * is refused with it; on a case-sensitive one, `.Git/` is a different directory
 * that git never reads, so refusing it would be a false refusal.
 */
export function protectedPathRule(workspaceRoot: string, canonicalPath: string): string | undefined {
  const relativePath = relative(workspaceRoot, canonicalPath);
  if (relativePath === '' || relativePath.length === 0) return undefined;
  const foldsCase = workspaceFoldsPathCase(workspaceRoot);
  const segments = relativePath.split(sep);
  for (const segment of segments) {
    const protectedDirectory = foldsCase
      ? PROTECTED_DIRECTORY_NAMES_FOLDED.get(segment.toLowerCase())
      : PROTECTED_DIRECTORY_NAMES.has(segment)
        ? segment
        : undefined;
    if (protectedDirectory !== undefined) {
      return `${protectedDirectory}/ is protected at any depth in the workspace`;
    }
  }
  const firstSegment = segments[0]!;
  const protectedFile = foldsCase
    ? PROTECTED_WORKSPACE_ROOT_FILES_FOLDED.has(firstSegment.toLowerCase())
    : PROTECTED_WORKSPACE_ROOT_FILES.has(firstSegment);
  if (segments.length === 1 && protectedFile) {
    return `${firstSegment} is protected at the workspace root`;
  }
  return undefined;
}

/** Refuse a mutating path that lands on the protected-path deny list. */
export function assertPathNotProtected(
  context: ToolContext,
  workspaceRoot: string,
  canonicalPath: string,
  requestedPath: string,
): void {
  if (context.policy?.allowProtectedPaths === true) return;
  const brokenRule = protectedPathRule(workspaceRoot, canonicalPath);
  if (brokenRule === undefined) return;
  throw new ToolPolicyError(
    `protected path refused: ${requestedPath} resolves to ${canonicalPath}, and ${brokenRule} ` +
      `(ADR 0006). Reads are still allowed; change it with bash, or start pi with --allow-protected-paths.`,
  );
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** True only when candidate is root itself or a descendant of root. */
export function isPathInsideWorkspace(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertInside(root: string, candidate: string): void {
  if (!isPathInsideWorkspace(root, candidate)) {
    throw new ToolPolicyError(`path escapes workspace: ${candidate} (workspace: ${root})`);
  }
}

/** Resolve and validate the stable workspace boundary configured on a context. */
export function resolveWorkspaceRoot(context: ToolContext): string {
  const configured = context.policy?.workspaceRoot ?? context.cwd;
  let root: string;
  try {
    root = realpathSync(resolve(context.cwd, configured));
  } catch (error) {
    throw new ToolPolicyError(`workspace root is not accessible: ${configured} (${String(error)})`);
  }
  if (!statSync(root).isDirectory()) throw new ToolPolicyError(`workspace root is not a directory: ${root}`);
  return root;
}

function canonicalizeCandidate(candidate: string, mustExist: boolean): string {
  try {
    // realpath resolves every symlink in an existing path.
    return realpathSync(candidate);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    if (mustExist) throw error;
  }

  // For a new file, resolve the nearest existing ancestor. Re-attaching the
  // missing suffix to that canonical ancestor catches symlinked parent escapes.
  const suffix: string[] = [];
  let ancestor = candidate;
  while (true) {
    try {
      lstatSync(ancestor);
      const canonicalAncestor = realpathSync(ancestor);
      return resolve(canonicalAncestor, ...suffix);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Resolve a model-supplied path while enforcing lexical and symlink-aware
 * workspace containment. Parent traversal is rejected even if normalization
 * would happen to land back inside the workspace.
 */
export function resolveWorkspacePath(
  context: ToolContext,
  requestedPath: string,
  options: ResolveWorkspacePathOptions = {},
): string {
  if (requestedPath.includes('\0')) throw new ToolPolicyError('paths may not contain NUL bytes');
  if (requestedPath.split(/[\\/]+/u).includes('..')) {
    throw new ToolPolicyError(`parent path traversal is not allowed: ${requestedPath}`);
  }
  const absoluteAllowed = options.allowAbsolute === true || context.policy?.allowAbsolutePaths === true;
  if (isAbsolute(requestedPath) && !absoluteAllowed) {
    throw new ToolPolicyError(`absolute paths are not allowed: ${requestedPath}`);
  }

  const root = resolveWorkspaceRoot(context);
  let cwd: string;
  try {
    cwd = realpathSync(context.cwd);
  } catch (error) {
    throw new ToolPolicyError(`working directory is not accessible: ${context.cwd} (${String(error)})`);
  }
  assertInside(root, cwd);

  const lexicalCandidate = resolve(cwd, requestedPath);
  // Relative candidates are already based on canonical cwd. An allowed absolute
  // candidate may use an OS alias for the same tree (/var -> /private/var on
  // macOS), so defer that case to the canonical check below.
  if (!isAbsolute(requestedPath)) assertInside(root, lexicalCandidate);
  let canonicalCandidate: string;
  try {
    canonicalCandidate = canonicalizeCandidate(lexicalCandidate, options.mustExist !== false);
  } catch (error) {
    if (error instanceof ToolPolicyError) throw error;
    throw new ToolPolicyError(`path is not accessible: ${requestedPath} (${String(error)})`);
  }
  assertInside(root, canonicalCandidate);
  if (options.forMutation === true) assertPathNotProtected(context, root, canonicalCandidate, requestedPath);
  // The checked result leaves this function as a string, which every caller
  // re-traverses. ADR 0022's tests open that window here on purpose.
  runContainmentBarrier('after-resolve', canonicalCandidate);
  return canonicalCandidate;
}

export function assertRegularFile(path: string, operation: string, allowMissing = false): Stats | undefined {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (error) {
    if (allowMissing && isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!stat.isFile()) throw new ToolPolicyError(`${operation} requires a regular file: ${path}`);
  return stat;
}

/**
 * Replace a text file atomically within its directory. The temporary file is
 * fsynced before rename and removed if any pre-commit step fails.
 */
export function atomicWriteTextFile(path: string, content: string, options: { mode?: number } = {}): void {
  const existing = assertRegularFile(path, 'write', true);
  const mode = existing ? existing.mode & 0o777 : (options.mode ?? 0o666);
  const tempPath = resolve(dirname(path), `.${basename(path)}.pi-tmp-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  let committed = false;
  try {
    runContainmentBarrier('before-temp-create', tempPath);
    descriptor = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    if (existing) fchmodSync(descriptor, mode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    runContainmentBarrier('before-rename', path);
    renameSync(tempPath, path);
    // The rename is now visible and cannot be safely retried as though it never
    // happened. Directory fsync is a best-effort power-loss hardening step;
    // failure after commit must not report the write itself as failed.
    committed = true;
    try {
      const directoryFd = openSync(dirname(path), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
      // Some filesystems/platforms do not support directory fsync. The target
      // already contains the requested bytes, so a retry would be more harmful.
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    if (!committed) {
      try {
        runContainmentBarrier('before-cleanup', tempPath);
        unlinkSync(tempPath);
      } catch {
        // The temp file may not have been created.
      }
    }
  }
}
