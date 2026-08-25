import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { addUsage, emptyUsage, type Message, type ToolCallBlock, type Usage } from '@pi/ai';
import {
  JOURNAL_SCHEMA_VERSION,
  journalSchemaVersion,
  parseSessionEntry,
  reduceModelRequests,
  reduceOpenRun,
  reduceToolExecutions,
  summarizeCosts,
  validateLifecycle,
  type ApprovalDecision,
  type LifecycleEntry,
  type ModelRequestState,
  type OpenRunState,
  type RunBudgetSnapshot,
  type RunStatus,
  type SessionEntry,
  type SessionLineage,
  type ToolExecutionState,
} from './journal.js';
import {
  addCostSummary,
  costComplete,
  emptyCostSummary,
  type CostSummary,
  type RequestCost,
  type SpendReservation,
} from './pricing.js';

export type {
  ApprovalDecision,
  CompactionEntry,
  LegacySessionEntry,
  LifecycleEntry,
  ModelRequestEntry,
  ModelRequestState,
  ModelRequestStatus,
  OpenRunState,
  RunBudgetSnapshot,
  RunStatus,
  SessionEntry,
  SessionLineage,
  SessionLineageRelation,
  ToolApprovalState,
  ToolExecutionState,
  ToolExecutionStatus,
  ToolLifecycleEntry,
} from './journal.js';

export interface SessionCreateOptions {
  /** Optional caller-owned UUID. Creation still uses O_EXCL and never overwrites. */
  id?: string;
  lineage?: SessionLineage;
}

export interface LockedSession {
  session: Session;
  /** Releases the advisory lock; it is also released automatically on process exit. */
  release: () => void;
}

export interface UsageLedgerEntry {
  usage: Usage;
  requestId?: string;
  model?: string;
  cost?: RequestCost;
}

export class SessionCorruptionError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly lineNumber?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionCorruptionError';
  }
}

/** The in-memory journal can no longer prove which bytes reached durable storage.
 * Reopen and reconcile the file under its lock before attempting another append. */
/** Every method that writes the journal; SessionView omits them at the type level (0023). */
type SessionMutator =
  | 'append'
  | 'appendMany'
  | 'beginCompaction'
  | 'beginModelRequest'
  | 'branch'
  | 'branchLocked'
  | 'completeCompaction'
  | 'completeModelRequest'
  | 'completeTool'
  | 'decideToolApproval'
  | 'failCompaction'
  | 'failModelRequest'
  | 'failTool'
  | 'markInterruptedCompactionsFailed'
  | 'markInterruptedModelRequestsOutcomeUnknown'
  | 'markInterruptedToolsOutcomeUnknown'
  | 'markModelRequestOutcomeUnknown'
  | 'markReady'
  | 'markToolOutcomeUnknown'
  | 'planTool'
  | 'requestToolApproval'
  | 'setRunStatus'
  | 'skipTool'
  | 'startTool';

/**
 * Read-only session: what Session.open() returns (0023). Compile-time absence
 * of mutators is the first line; the module-private lock capability checked in
 * appendMany is the second, so casting back to Session still cannot write.
 */
export type SessionView = Omit<Session, SessionMutator>;

/** A mutation was attempted on a session instance that does not hold the live lock (0023). */
export class SessionLockError extends Error {
  constructor(file: string) {
    super(
      `session mutation requires the lock: open this journal with Session.openLocked() or create it with Session.create(); a read-only Session.open() view cannot write (${file})`,
    );
    this.name = 'SessionLockError';
  }
}

export class SessionPersistenceError extends Error {
  constructor(
    message: string,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionPersistenceError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATE_ATTEMPTS = 8;
export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_DATA_BYTES = 56 * 1024 * 1024;
export const SESSION_ROTATE_BYTES = 32 * 1024 * 1024;
const MAX_DISCOVERY_FILES = 256;
const MAX_DISCOVERY_BYTES = 128 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 4_096;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function now(): string {
  return new Date().toISOString();
}

function durableCreate(file: string, content: string): void {
  let fd: number | undefined;
  let complete = false;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    // Do not let an unusual umask make future appends unreadable to the owner.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    const directoryFd = openSync(dirname(file), constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    complete = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (fd !== undefined && !complete) {
      try {
        unlinkSync(file);
      } catch {
        /* the incomplete file was already removed */
      }
    }
  }
}

function durableAppend(file: string, content: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new TypeError(`session is not a regular file: ${file}`);
    // Locks are keyed by pathname; a hard link gives one inode two names and
    // therefore two locks, bypassing single-writer (owner review). Checked on
    // the descriptor actually written, not the path, so it cannot be raced.
    if (stats.nlink !== 1) {
      throw new SessionPersistenceError(
        `session journal has ${stats.nlink} links; journals must be single-link files`, file);
    }
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function serializeEntry(entry: SessionEntry): { entry: SessionEntry; line: string } {
  // Round-trip first so the in-memory audit snapshot is exactly what reached disk
  // and cannot later be changed through a caller-owned object reference.
  const line = JSON.stringify(entry);
  const normalized = parseSessionEntry(JSON.parse(line) as unknown);
  return { entry: normalized, line: `${line}\n` };
}

export function sessionsDirFor(cwd: string): string {
  // hash suffix disambiguates slug collisions ("/a/b-c" vs "/a/b/c" both slug to "-a-b-c")
  const slug = cwd.replace(/[/\\:]/g, '-');
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return join(homedir(), '.pi', 'sessions', `${slug}-${hash}`);
}

export function latestSessionFile(
  dir: string,
  options: { excludeActivelyLocked?: boolean } = {},
): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files: { file: string; mtime: number }[] = [];
  const directory = opendirSync(dir);
  let entries = 0;
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      entries++;
      if (entries > MAX_DISCOVERY_ENTRIES) {
        throw new Error(
          `session discovery exceeds ${MAX_DISCOVERY_ENTRIES} directory entries; resume an explicit session path`,
        );
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const file = join(dir, entry.name);
      try {
        files.push({ file, mtime: statSync(file).mtimeMs });
      } catch {
        /* deleted concurrently */
      }
    }
  } finally {
    directory.closeSync();
  }
  files.sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return undefined;

  // mtime alone points at the parent after a committed compaction because the
  // parent receives the final commit row. Resolve the lineage graph and choose
  // its newest leaf instead. Preserve fail-closed behavior for a corrupt newest
  // file; older unrelated corruption must not make every project unresumable.
  const sessions: { session: SessionView; file: string; mtime: number; created: number }[] = [];
  let discoveryBytes = 0;
  const boundedFiles = files.slice(0, MAX_DISCOVERY_FILES);
  for (let index = 0; index < boundedFiles.length; index++) {
    const candidate = boundedFiles[index]!;
    try {
      const size = statSync(candidate.file).size;
      if (discoveryBytes + size > MAX_DISCOVERY_BYTES) {
        if (sessions.length === 0) {
          throw new Error(`latest-session discovery exceeds ${MAX_DISCOVERY_BYTES} bytes`);
        }
        break;
      }
      discoveryBytes += size;
      const session = Session.open(candidate.file);
      sessions.push({
        session,
        file: candidate.file,
        mtime: candidate.mtime,
        created: Date.parse(session.meta?.created ?? '') || 0,
      });
    } catch (error) {
      if (index === 0) throw error;
    }
  }
  if (sessions.length === 0) return undefined;

  const byId = new Map(sessions.map((item) => [item.session.id, item]));
  const parentCache = new Map<string, SessionView>();
  const committedCompactionParent = (item: (typeof sessions)[number], parentFile: string): boolean => {
    const known = byId.get(item.session.lineage!.parentSessionId)?.session;
    let parent = known ?? parentCache.get(parentFile);
    if (!parent) {
      let size: number;
      try {
        size = statSync(parentFile).size;
      } catch (error) {
        throw new Error(`cannot validate compaction parent ${parentFile}: ${String(error)}`);
      }
      if (discoveryBytes + size > MAX_DISCOVERY_BYTES) {
        throw new Error(
          `cannot validate committed compaction within the ${MAX_DISCOVERY_BYTES}-byte discovery limit; resume an explicit session path`,
        );
      }
      discoveryBytes += size;
      parent = Session.open(parentFile);
      parentCache.set(parentFile, parent);
    }
    return parent.lifecycleEntries.some(
      (entry) => entry.t === 'compaction_completed' && entry.targetSessionId === item.session.id,
    );
  };
  const valid = sessions.filter((item) => {
    const lineage = item.session.lineage;
    if ((lineage?.relation === 'branch' || lineage?.relation === 'continuation') && !item.session.ready) return false;
    if (lineage?.relation !== 'compaction') return true;
    const parentFile = lineage.parentFile
      ? isAbsolute(lineage.parentFile)
        ? lineage.parentFile
        : join(dirname(item.file), lineage.parentFile)
      : undefined;
    if (!parentFile || !existsSync(parentFile)) {
      // A moved child is self-contained. If its declared parent is still present
      // but outside the bounded discovery set, fail closed rather than guessing
      // that an uncommitted child superseded it.
      return lineage.parentFile === undefined;
    }
    return committedCompactionParent(item, parentFile);
  });
  // Compaction/continuation replace a parent as the resumable head. A branch is
  // a fork: both it and its parent remain live candidates, ranked by activity.
  const supersededParents = new Set(
    valid
      .filter((item) => {
        const relation = item.session.lineage?.relation;
        return relation === 'compaction' || relation === 'continuation';
      })
      .map((item) => item.session.lineage?.parentSessionId)
      .filter((id): id is string => id !== undefined && byId.has(id)),
  );
  const leaves = valid.filter((item) => !supersededParents.has(item.session.id));
  const candidates = leaves.length > 0 ? leaves : valid;
  candidates.sort((a, b) => b.mtime - a.mtime || b.created - a.created || b.file.localeCompare(a.file));
  const newest = candidates[0];
  if (!newest) return undefined;
  // Rank BEFORE filtering locks (0024): silently skipping a locked newer
  // session resumes an older conversation or fabricates a blank one, hiding
  // the newest history behind its stale lock. Fail loudly instead.
  if (options.excludeActivelyLocked && sessionLockExists(newest.file)) {
    throw new LockedSessionHeadError(newest.file);
  }
  return newest.file;
}

/**
 * The newest resumable session is locked. Selection never silently falls back
 * to an older session (0024); callers surface the owner and the recovery path.
 */
export class LockedSessionHeadError extends Error {
  readonly file: string;
  readonly lockPath: string;
  readonly owner: PublicLockOwner | undefined;
  readonly lockAgeMs: number | undefined;
  constructor(file: string) {
    const lockPath = `${file}.lock`;
    let owner: PublicLockOwner | undefined;
    let lockAgeMs: number | undefined;
    try {
      const parsed = parseLockOwner(readFileSync(lockPath, 'utf8'));
      owner = parsed ? publicOwner(parsed) : undefined;
      lockAgeMs = Date.now() - lstatSync(lockPath).mtimeMs;
    } catch {
      // A vanished or unreadable lock stays reported without owner detail.
    }
    const ownerText = owner
      ? `pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ''}${owner.created ? `, started ${owner.created}` : ''}${owner.legacy ? ' (legacy record)' : ''}`
      : 'unreadable owner record';
    super(
      `newest session is locked: ${file}\n  lock: ${lockPath} (${ownerText}${
        lockAgeMs !== undefined ? `, age ${Math.round(lockAgeMs / 1000)}s` : ''
      })\n  run "pi doctor sessions" to inspect and recover; nothing was resumed or created`,
    );
    this.name = 'LockedSessionHeadError';
    this.file = file;
    this.lockPath = lockPath;
    this.owner = owner;
    this.lockAgeMs = lockAgeMs;
  }
}

/** Owner facts safe to publish; the lock token stays module-private (owner review). */
export interface PublicLockOwner {
  pid: number;
  host?: string;
  created?: string;
  legacy?: boolean;
}

function publicOwner(owner: LockOwner): PublicLockOwner {
  return {
    pid: owner.pid,
    ...(owner.host !== undefined ? { host: owner.host } : {}),
    ...(owner.created !== undefined ? { created: owner.created } : {}),
    ...(owner.legacy !== undefined ? { legacy: owner.legacy } : {}),
  };
}

export interface SessionLockReport {
  file: string;
  locked: boolean;
  owner?: PublicLockOwner;
  /** 'removable' only for a parsable local record whose pid is dead. */
  classification?: 'live' | 'removable' | 'remote' | 'malformed' | 'legacy';
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another user: alive for our purposes.
    return isErrno(error, 'EPERM');
  }
}

function classifyLock(owner: LockOwner | undefined): NonNullable<SessionLockReport['classification']> {
  if (!owner) return 'malformed';
  if (owner.legacy) return 'legacy';
  if (owner.host !== undefined && owner.host !== hostname()) return 'remote';
  if (owner.host === undefined) return 'legacy'; // v1: no host, not safely attributable
  return pidAlive(owner.pid) ? 'live' : 'removable';
}

/** Read-only survey for `pi doctor sessions` (0024). */
export function listSessionsWithLockState(dir: string): SessionLockReport[] {
  if (!existsSync(dir)) return [];
  const reports: SessionLockReport[] = [];
  const directory = opendirSync(dir);
  let entries = 0;
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (++entries > MAX_DISCOVERY_ENTRIES) break;
      if (!entry.name.endsWith('.jsonl')) continue;
      const file = join(dir, entry.name);
      if (!sessionLockExists(file)) {
        reports.push({ file, locked: false });
        continue;
      }
      let owner: LockOwner | undefined;
      try {
        owner = parseLockOwner(readFileSync(`${file}.lock`, 'utf8'));
      } catch {
        owner = undefined;
      }
      reports.push({ file, locked: true, ...(owner ? { owner: publicOwner(owner) } : {}), classification: classifyLock(owner) });
    }
  } finally {
    directory.closeSync();
  }
  return reports.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Remove one verifiably dead lock (0024). Serialized through an exclusive
 * recovery lock, with the target's owner re-read immediately before unlink:
 * POSIX has no path-based compare-and-delete, so safety comes from
 * serialization plus the re-check, never from a claimed atomic primitive.
 * Refuses live, remote-host, malformed, legacy, and unverifiable owners.
 */
const MAX_LOCK_RECORD_BYTES = 4_096;

/**
 * The recovery target must be a real session journal (owner review): doctor
 * must never become a generic file deleter for anything ending in .lock.
 */
function validateRecoveryTarget(file: string): string | undefined {
  const name = file.split('/').at(-1) ?? '';
  if (!name.endsWith('.jsonl') || !UUID_PATTERN.test(name.slice(0, -'.jsonl'.length))) {
    return 'target is not a UUID-named .jsonl session file';
  }
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    return 'target session file does not exist';
  }
  if (!stats.isFile() || stats.nlink !== 1) return 'target session is not a single-link regular file';
  try {
    const view = Session.open(file);
    if (`${view.id}.jsonl` !== name) return 'session meta id does not match its filename';
  } catch (error) {
    return `target does not parse as a session journal: ${String(error instanceof Error ? error.message : error)}`;
  }
  let lockStats;
  try {
    lockStats = lstatSync(`${file}.lock`);
  } catch {
    return undefined; // no lock is handled by the caller as already-gone
  }
  if (!lockStats.isFile() || lockStats.size > MAX_LOCK_RECORD_BYTES) {
    return 'lock file is not a small regular file';
  }
  return undefined;
}

function takeRecoveryLock(recoveryLockPath: string): boolean {
  try {
    writeFileSync(
      recoveryLockPath,
      `${JSON.stringify({ v: 2, pid: process.pid, host: hostname(), token: randomUUID(), created: now() })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

export function recoverStaleLock(file: string): { removed: boolean; reason: string } {
  const invalid = validateRecoveryTarget(file);
  if (invalid) return { removed: false, reason: `refusing recovery: ${invalid}` };
  const lockPath = `${file}.lock`;
  const recoveryLockPath = join(dirname(file), '.recovery.lock');
  let recoveryTaken = false;
  try {
    if (!takeRecoveryLock(recoveryLockPath)) {
      // A crashed doctor must not disable recovery forever (owner review):
      // when the held recovery lock itself has a verifiably dead local owner,
      // clear it and take over once; anything else stays refused with detail.
      let holder: LockOwner | undefined;
      try {
        holder = parseLockOwner(readFileSync(recoveryLockPath, 'utf8'));
      } catch {
        holder = undefined;
      }
      if (holder && !holder.legacy && classifyLock(holder) === 'removable') {
        try {
          unlinkSync(recoveryLockPath);
        } catch {
          /* raced with the other recovery finishing; fall through to refusal */
        }
      }
      if (!takeRecoveryLock(recoveryLockPath)) {
        const detail = holder ? `held by pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'held by an unreadable owner';
        return { removed: false, reason: `another recovery is in progress (${detail}); retry after it finishes` };
      }
    }
    recoveryTaken = true;
    let owner: LockOwner | undefined;
    try {
      owner = parseLockOwner(readFileSync(lockPath, 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { removed: false, reason: 'lock is already gone' };
      return { removed: false, reason: `lock is unreadable: ${String(error)}` };
    }
    const classification = classifyLock(owner);
    if (classification !== 'removable') {
      return {
        removed: false,
        reason: `refusing cleanup: owner is ${classification} (only a parsable local record with a dead pid is removable)`,
      };
    }
    // Re-read immediately before unlink: the owner could have exited and a new
    // process could have re-locked between the survey and this call.
    let recheck: LockOwner | undefined;
    try {
      recheck = parseLockOwner(readFileSync(lockPath, 'utf8'));
    } catch {
      return { removed: false, reason: 'lock changed during recovery; not removed' };
    }
    if (!recheck || recheck.token !== owner?.token || classifyLock(recheck) !== 'removable') {
      return { removed: false, reason: 'lock changed during recovery; not removed' };
    }
    unlinkSync(lockPath);
    return { removed: true, reason: `removed lock of dead pid ${recheck.pid}` };
  } finally {
    if (recoveryTaken) {
      try {
        unlinkSync(recoveryLockPath);
      } catch {
        // Leaving a stale recovery lock blocks future recoveries loudly, which is the safe direction.
      }
    }
  }
}

export interface LockOwner {
  pid: number;
  token?: string;
  created?: string;
  /** v2 records carry the owning host; cleanup is refused when it differs (0024). */
  host?: string;
  /** true for bare-pid records predating versioned lock payloads; diagnosable, never auto-removable. */
  legacy?: boolean;
}

function parseLockOwner(text: string): LockOwner | undefined {
  const legacyPid = Number(text.trim());
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) return { pid: legacyPid, legacy: true };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const version = record['v'];
    if (version !== 1 && version !== 2) return undefined;
    if (!Number.isSafeInteger(record['pid']) || (record['pid'] as number) <= 0) return undefined;
    if (typeof record['token'] !== 'string' || record['token'].length === 0) return undefined;
    if (typeof record['created'] !== 'string' || Number.isNaN(Date.parse(record['created']))) return undefined;
    if (version === 2 && (typeof record['host'] !== 'string' || record['host'].length === 0)) return undefined;
    return {
      pid: record['pid'] as number,
      token: record['token'],
      created: record['created'],
      ...(version === 2 ? { host: record['host'] as string } : {}),
    };
  } catch {
    return undefined;
  }
}

function sessionLockExists(file: string): boolean {
  try {
    lstatSync(`${file}.lock`);
    return true;
  } catch (error) {
    // An unreadable or otherwise indeterminate lock path must remain fail-closed.
    return !isErrno(error, 'ENOENT');
  }
}

const ownedSessionLocks = new Map<string, string>();
let sessionLockExitHookInstalled = false;

function releaseOwnedLock(lockPath: string, token: string): boolean {
  if (ownedSessionLocks.get(lockPath) !== token) return false;
  ownedSessionLocks.delete(lockPath);
  try {
    const owner = parseLockOwner(readFileSync(lockPath, 'utf8'));
    if (owner?.token === token) unlinkSync(lockPath);
  } catch {
    /* lock already gone or no longer ours */
  }
  return true;
}

function installSessionLockExitHook(): void {
  if (sessionLockExitHookInstalled) return;
  sessionLockExitHookInstalled = true;
  process.once('exit', () => {
    for (const [lockPath, token] of [...ownedSessionLocks]) releaseOwnedLock(lockPath, token);
  });
}

/** Release a lock owned by this process without retaining per-lock exit listeners. */
export function releaseSessionLock(file: string): boolean {
  const lockPath = `${file}.lock`;
  const token = ownedSessionLocks.get(lockPath);
  return token ? releaseOwnedLock(lockPath, token) : false;
}

/**
 * Best-effort advisory lock so two processes do not interleave JSONL writes.
 * Lock ownership is tokenized: an old release callback can never delete a lock
 * that was subsequently acquired by a different process. Existing locks are
 * never removed automatically: PID liveness is racy and PID reuse can make a
 * stale-lock decision delete a live owner's lock. Cleanup must be deliberate.
 */
export function tryLockSession(file: string): (() => void) | undefined {
  return acquireSessionLock(file)?.release;
}

/** Module-internal acquisition that also exposes the token for capability adoption (0023). */
function acquireSessionLock(file: string): { token: string; release: () => void } | undefined {
  const lockPath = `${file}.lock`;
  const token = randomUUID();
  const payload = `${JSON.stringify({ v: 2, pid: process.pid, host: hostname(), token, created: now() })}\n`;

  const take = (): boolean => {
    try {
      writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      chmodSync(lockPath, 0o600);
      return true;
    } catch {
      return false;
    }
  };

  if (!take()) return undefined;

  ownedSessionLocks.set(lockPath, token);
  installSessionLockExitHook();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseOwnedLock(lockPath, token);
  };
  return { token, release };
}

/**
 * Capability registry (0023): a session instance may mutate only while it
 * holds the token of the live lock on its own file. The WeakMap is module
 * private, so the token cannot be read or forged from outside; a cast to a
 * mutable type still fails at append time.
 */
const mutationTokens = new WeakMap<Session, string>();

function adoptSessionLock(session: Session, token: string): void {
  mutationTokens.set(session, token);
}

type TailRepair = { kind: 'truncate'; size: number } | { kind: 'newline' };

function parseFile(file: string): { entries: SessionEntry[]; tailRepair?: TailRepair } {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new TypeError(`session is not a regular file: ${file}`);
    if (stats.nlink !== 1) {
      throw new SessionCorruptionError(
        `session journal has ${stats.nlink} links; journals must be single-link files`, file);
    }
    if (stats.size > MAX_SESSION_FILE_BYTES) {
      throw new SessionCorruptionError(
        `session exceeds the ${MAX_SESSION_FILE_BYTES}-byte recovery limit; compact or archive it explicitly`,
        file,
      );
    }
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const lines = raw.split('\n');
  const hasPartialTail = !raw.endsWith('\n');
  let lastNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.trim().length > 0) {
      lastNonEmpty = index;
      break;
    }
  }

  const entries: SessionEntry[] = [];
  let skippedTail = false;
  for (let index = 0; index <= lastNonEmpty; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      if (index === lastNonEmpty && hasPartialTail) {
        skippedTail = true;
        continue;
      }
      throw new SessionCorruptionError(`invalid JSON in session at line ${index + 1}`, file, index + 1, {
        cause: error,
      });
    }
    try {
      entries.push(parseSessionEntry(value));
    } catch (error) {
      throw new SessionCorruptionError(`invalid session entry at line ${index + 1}: ${String(error)}`, file, index + 1, {
        cause: error,
      });
    }
  }
  if (skippedTail) process.stderr.write(`warning: ignored a corrupt trailing line in ${file}\n`);
  if (entries.length === 0 || entries[0]?.t !== 'meta') {
    throw new SessionCorruptionError('session must begin with a meta entry', file, 1);
  }
  if (entries.slice(1).some((entry) => entry.t === 'meta')) {
    throw new SessionCorruptionError('session contains more than one meta entry', file);
  }
  try {
    validateLifecycle(entries);
  } catch (error) {
    throw new SessionCorruptionError(`invalid lifecycle journal: ${String(error)}`, file, undefined, { cause: error });
  }
  let tailRepair: TailRepair | undefined;
  if (hasPartialTail) {
    const finalSegment = lines.at(-1) ?? '';
    if (skippedTail || finalSegment.trim().length === 0) {
      const lastNewline = Buffer.from(raw).lastIndexOf(0x0a);
      tailRepair = { kind: 'truncate', size: lastNewline + 1 };
    } else {
      // A valid final row is retained, but it must be delimited before O_APPEND.
      tailRepair = { kind: 'newline' };
    }
  }
  return { entries, ...(tailRepair ? { tailRepair } : {}) };
}

/** Append-only transcript plus a versioned write-ahead lifecycle journal. */
export class Session {
  private writeFailure?: unknown;

  private constructor(
    readonly file: string,
    readonly id: string,
    private readonly entries: SessionEntry[],
    private tailRepair?: TailRepair,
  ) {}

  /** Journal creation without a lock: internal only; every public factory locks (0023). */
  private static createCore(cwd: string, model: string, dir: string, options: SessionCreateOptions): Session {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.id && !UUID_PATTERN.test(options.id)) throw new TypeError('session id must be a UUID');
    const attempts = options.id ? 1 : CREATE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const id = options.id ?? randomUUID();
      const file = join(dir, `${id}.jsonl`);
      const created = now();
      const entries: SessionEntry[] = [
        { t: 'meta', v: 1, id, cwd, model, created },
        { t: 'journal_schema', v: 2, at: created, schema: JOURNAL_SCHEMA_VERSION },
      ];
      if (options.lineage) {
        entries.push({ t: 'session_lineage', v: 2, at: created, ...options.lineage });
      }
      for (const entry of entries) parseSessionEntry(entry);
      validateLifecycle(entries);
      const content = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      try {
        durableCreate(file, content);
        return new Session(file, id, entries);
      } catch (error) {
        if (!isErrno(error, 'EEXIST') || options.id) throw error;
      }
    }
    throw new Error(`could not allocate a unique session id after ${CREATE_ATTEMPTS} attempts`);
  }

  /**
   * Create a new journal and return it holding its own lock (0023): no public
   * API yields an unlocked mutable session. Callers release with close().
   */
  static create(cwd: string, model: string, dir = sessionsDirFor(cwd), options: SessionCreateOptions = {}): Session {
    return Session.createLocked(cwd, model, dir, options).session;
  }

  /** Reserve the advisory lock before publishing a new session file. */
  static createLocked(
    cwd: string,
    model: string,
    dir = sessionsDirFor(cwd),
    options: SessionCreateOptions = {},
  ): LockedSession {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.id && !UUID_PATTERN.test(options.id)) throw new TypeError('session id must be a UUID');
    const attempts = options.id ? 1 : CREATE_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const id = options.id ?? randomUUID();
      const file = join(dir, `${id}.jsonl`);
      const acquired = acquireSessionLock(file);
      if (!acquired) {
        if (options.id) throw new Error(`could not reserve session lock ${file}`);
        continue;
      }
      try {
        const session = Session.createCore(cwd, model, dir, { ...options, id });
        adoptSessionLock(session, acquired.token);
        return { session, release: acquired.release };
      } catch (error) {
        acquired.release();
        if (!options.id && isErrno(error, 'EEXIST')) continue;
        throw error;
      }
    }
    throw new Error(`could not allocate and lock a unique session after ${CREATE_ATTEMPTS} attempts`);
  }

  private static openInternal(file: string): Session {
    const { entries, tailRepair } = parseFile(file);
    const meta = entries[0]!;
    if (meta.t !== 'meta') throw new SessionCorruptionError('session must begin with a meta entry', file, 1);
    return new Session(file, meta.id, entries, tailRepair);
  }

  /**
   * Read-only view (0023): reading never needs the lock. The declared type has
   * no mutators, and the runtime capability check backs the type up, so a cast
   * still fails at append time.
   */
  static open(file: string): SessionView {
    return Session.openInternal(file);
  }

  /**
   * Acquire the lock FIRST, then parse (0023): repair-on-append and every
   * later mutation happen under the same capability. Returns undefined when
   * another owner holds the lock.
   */
  static openLocked(file: string): Session | undefined {
    const acquired = acquireSessionLock(file);
    if (!acquired) return undefined;
    try {
      const session = Session.openInternal(file);
      adoptSessionLock(session, acquired.token);
      return session;
    } catch (error) {
      acquired.release();
      throw error;
    }
  }

  /** Idempotently release this instance's lock; the mutation capability dies with it. */
  close(): void {
    const token = mutationTokens.get(this);
    if (token === undefined) return;
    mutationTokens.delete(this);
    releaseOwnedLock(`${this.file}.lock`, token);
  }

  /**
   * New session containing legacy messages/usage up to message `atMessage`
   * (0-based). The child holds its own lock (0023); callers close() it.
   */
  branch(atMessage: number, cwd: string, model: string): Session {
    return this.branchLocked(atMessage, cwd, model).session;
  }

  /** Like branch(), but the child is locked before it becomes visible. */
  branchLocked(atMessage: number, cwd: string, model: string): LockedSession {
    if (!Number.isInteger(atMessage) || atMessage < 0) throw new RangeError('branch message index must be non-negative');
    const locked = Session.createLocked(cwd, model, dirname(this.file), {
      lineage: { parentSessionId: this.id, parentFile: this.file, relation: 'branch', atMessage },
    });
    try {
      let messageIndex = -1;
      const copied: SessionEntry[] = [];
      for (const entry of this.entries) {
        if (entry.t === 'meta' || ('v' in entry && entry.v === 2)) continue;
        if (entry.t === 'msg') {
          messageIndex++;
          if (messageIndex > atMessage) break;
        }
        copied.push(entry);
      }
      locked.session.appendMany(copied);
      locked.session.markReady();
      return locked;
    } catch (error) {
      locked.release();
      try {
        unlinkSync(locked.session.file);
      } catch {
        /* retain the original copy error */
      }
      throw error;
    }
  }

  private repairAppendBoundary(): void {
    const repair = this.tailRepair;
    if (!repair) return;
    if (repair.kind === 'newline') {
      durableAppend(this.file, '\n');
    } else {
      const fd = openSync(this.file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) throw new TypeError(`session is not a regular file: ${this.file}`);
        if (stats.nlink !== 1) {
          throw new SessionPersistenceError(
            `session journal has ${stats.nlink} links; journals must be single-link files`,
            this.file,
          );
        }
        ftruncateSync(fd, repair.size);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.tailRepair = undefined;
  }

  append(entry: SessionEntry): void {
    this.appendMany([entry]);
  }

  /**
   * Validate and append a bounded snapshot with one descriptor write/fsync.
   * Used for lineage copies so deadline behavior depends on bytes, not a
   * potentially huge count of per-message durability transactions.
   */
  appendMany(entries: readonly SessionEntry[]): void {
    if (entries.length === 0) return;
    // Every mutation funnels through here; the capability check is runtime,
    // not only type-level, so a cast around SessionView still fails (0023).
    const token = mutationTokens.get(this);
    if (token === undefined || ownedSessionLocks.get(`${this.file}.lock`) !== token) {
      throw new SessionLockError(this.file);
    }
    if (this.writeFailure !== undefined) {
      throw new SessionPersistenceError(
        'session writes are disabled after an ambiguous persistence failure; release the lock and reopen the journal before continuing',
        this.file,
        { cause: this.writeFailure },
      );
    }
    const serialized = entries.map((entry) => serializeEntry(entry));
    const normalized = serialized.map((item) => item.entry);
    if (normalized.some((entry) => 'v' in entry && entry.v === 2)) {
      validateLifecycle([...this.entries, ...normalized]);
    }
    let projectedSize: number;
    const content = serialized.map((item) => item.line).join('');
    try {
      this.repairAppendBoundary();
      projectedSize = statSync(this.file).size + Buffer.byteLength(content);
    } catch (error) {
      // Repair/path failures leave the append boundary untrusted. Poison this
      // Session object so a rebuilt Agent cannot append contradictory rows.
      this.writeFailure = error;
      throw error;
    }
    const containsData = normalized.some((entry) => entry.t === 'msg' || entry.t === 'usage');
    const limit = containsData ? MAX_SESSION_DATA_BYTES : MAX_SESSION_FILE_BYTES;
    if (projectedSize > limit) {
      throw new RangeError(
        `session append would exceed the ${limit}-byte ${limit === MAX_SESSION_DATA_BYTES ? 'data' : 'recovery'} limit; compact the session`,
      );
    }
    try {
      durableAppend(this.file, content);
    } catch (error) {
      // write/fsync failures are outcome-ambiguous: the row may already be on
      // disk even though the in-memory lifecycle has not accepted it.
      this.writeFailure = error;
      throw error;
    }
    this.entries.push(...normalized);
  }

  setRunStatus(status: RunStatus, reason?: string, options: { budget?: RunBudgetSnapshot } = {}): void {
    this.append({
      t: 'run_status',
      v: 2,
      at: now(),
      status,
      ...(reason ? { reason } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
    });
  }

  markReady(): void {
    this.append({ t: 'session_ready', v: 2, at: now() });
  }

  beginModelRequest(
    model: string,
    options: { requestId?: string; messageCount?: number; spendReservation?: SpendReservation } = {},
  ): string {
    const requestId = options.requestId ?? randomUUID();
    this.append({
      t: 'model_request_started',
      v: 2,
      at: now(),
      requestId,
      model,
      ...(options.messageCount !== undefined ? { messageCount: options.messageCount } : {}),
      ...(options.spendReservation ? { spendReservation: options.spendReservation } : {}),
    });
    return requestId;
  }

  completeModelRequest(
    requestId: string,
    options: { stopReason?: string; usage?: Usage; cost?: RequestCost } = {},
  ): void {
    this.append({
      t: 'model_request_completed',
      v: 2,
      at: now(),
      requestId,
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.cost ? { cost: options.cost } : {}),
    });
  }

  failModelRequest(requestId: string, error: string, retryable?: boolean): void {
    this.append({
      t: 'model_request_failed',
      v: 2,
      at: now(),
      requestId,
      error,
      ...(retryable !== undefined ? { retryable } : {}),
    });
  }

  markModelRequestOutcomeUnknown(requestId: string, reason: string): void {
    this.append({ t: 'model_request_outcome_unknown', v: 2, at: now(), requestId, reason });
  }

  markInterruptedModelRequestsOutcomeUnknown(
    reason = 'process stopped after provider dispatch but before a terminal response was durably recorded',
  ): string[] {
    const requestIds = this.interruptedModelRequests.map((state) => state.requestId);
    for (const requestId of requestIds) this.markModelRequestOutcomeUnknown(requestId, reason);
    return requestIds;
  }

  planTool(call: ToolCallBlock, options: { executionId?: string; requestId?: string } = {}): string {
    const executionId = options.executionId ?? randomUUID();
    this.append({
      t: 'tool_planned',
      v: 2,
      at: now(),
      executionId,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      call,
    });
    return executionId;
  }

  /** Defer a planned call pending a human decision; the derived status becomes awaiting_approval. */
  requestToolApproval(executionId: string): void {
    this.append({ t: 'tool_approval_requested', v: 2, at: now(), executionId });
  }

  /**
   * Record the human decision. `decidedAt` defaults to append time and should be
   * passed when the decision was collected earlier (a resume invocation applying
   * flags recorded before the journal was reopened).
   */
  decideToolApproval(
    executionId: string,
    decision: ApprovalDecision,
    options: { decidedAt?: string; editedArguments?: Record<string, unknown>; reason?: string } = {},
  ): void {
    if (decision !== 'edited' && options.editedArguments !== undefined) {
      throw new TypeError('editedArguments is only valid for an edited decision');
    }
    this.append({
      t: 'tool_approval_decided',
      v: 2,
      at: now(),
      executionId,
      decision,
      decidedAt: options.decidedAt ?? now(),
      ...(options.editedArguments !== undefined ? { editedArguments: options.editedArguments } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
  }

  startTool(executionId: string): void {
    this.append({ t: 'tool_started', v: 2, at: now(), executionId });
  }

  /** Terminal state for a planned call rejected before dispatch (budget, policy, or cancellation). */
  skipTool(executionId: string, reason: string): void {
    this.append({ t: 'tool_skipped', v: 2, at: now(), executionId, reason });
  }

  completeTool(executionId: string): void {
    this.append({ t: 'tool_completed', v: 2, at: now(), executionId });
  }

  failTool(executionId: string, error: string): void {
    this.append({ t: 'tool_failed', v: 2, at: now(), executionId, error });
  }

  markToolOutcomeUnknown(executionId: string, reason: string): void {
    this.append({ t: 'tool_outcome_unknown', v: 2, at: now(), executionId, reason });
  }

  /** Mark only calls that actually started and lack a terminal row. Planned calls are known not to have run. */
  markInterruptedToolsOutcomeUnknown(reason = 'process stopped before the tool result was durably recorded'): string[] {
    const executionIds = this.interruptedToolExecutions.map((state) => state.executionId);
    for (const executionId of executionIds) this.markToolOutcomeUnknown(executionId, reason);
    return executionIds;
  }

  beginCompaction(
    trigger: 'auto' | 'manual',
    options: { compactionId?: string; keepFromMessage?: number } = {},
  ): string {
    const blocked = this.suspendedToolExecutions;
    if (blocked.length > 0) {
      throw new Error(
        `cannot compact while tool approvals are pending; decide and resume execution(s): ${blocked
          .map((state) => state.executionId)
          .join(', ')}`,
      );
    }
    const compactionId = options.compactionId ?? randomUUID();
    this.append({
      t: 'compaction_started',
      v: 2,
      at: now(),
      compactionId,
      trigger,
      ...(options.keepFromMessage !== undefined ? { keepFromMessage: options.keepFromMessage } : {}),
    });
    return compactionId;
  }

  completeCompaction(
    compactionId: string,
    droppedMessages: number,
    options: { targetSessionId?: string; usage?: Usage } = {},
  ): void {
    this.append({
      t: 'compaction_completed',
      v: 2,
      at: now(),
      compactionId,
      droppedMessages,
      ...(options.targetSessionId ? { targetSessionId: options.targetSessionId } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
    });
  }

  failCompaction(compactionId: string, error: string): void {
    this.append({ t: 'compaction_failed', v: 2, at: now(), compactionId, error });
  }

  markInterruptedCompactionsFailed(reason = 'prior process stopped before compaction commit'): string[] {
    const states = new Map<string, 'started' | 'completed' | 'failed'>();
    for (const entry of this.lifecycleEntries) {
      if (entry.t === 'compaction_started') states.set(entry.compactionId, 'started');
      else if (entry.t === 'compaction_completed') states.set(entry.compactionId, 'completed');
      else if (entry.t === 'compaction_failed') states.set(entry.compactionId, 'failed');
    }
    const interrupted = [...states.entries()]
      .filter(([, status]) => status === 'started')
      .map(([compactionId]) => compactionId);
    for (const compactionId of interrupted) this.failCompaction(compactionId, reason);
    return interrupted;
  }

  get messages(): Message[] {
    return this.entries
      .filter((entry): entry is Extract<SessionEntry, { t: 'msg' }> => entry.t === 'msg')
      .map((entry) => structuredClone(entry.message));
  }

  get usage(): Usage {
    const total = emptyUsage();
    for (const usage of this.usageEntries) addUsage(total, usage);
    return total;
  }

  get usageEntries(): readonly Usage[] {
    return this.usageLedgerEntries.map((entry) => structuredClone(entry.usage));
  }

  get usageLedgerEntries(): readonly UsageLedgerEntry[] {
    const rows: UsageLedgerEntry[] = [];
    let lifecycleAccountingStarted = false;
    const models = new Map<string, string>();
    for (const entry of this.entries) {
      if (entry.t === 'model_request_started') {
        lifecycleAccountingStarted = true;
        models.set(entry.requestId, entry.model);
      }
      if (entry.t === 'usage' && !lifecycleAccountingStarted) {
        rows.push({ usage: structuredClone(entry.usage), ...(this.meta?.model ? { model: this.meta.model } : {}) });
      }
      if (entry.t === 'model_request_completed' && entry.usage) {
        rows.push({
          usage: structuredClone(entry.usage),
          requestId: entry.requestId,
          ...(models.get(entry.requestId) ? { model: models.get(entry.requestId)! } : {}),
          ...(entry.cost ? { cost: structuredClone(entry.cost) } : {}),
        });
      }
    }
    return rows;
  }

  /** Dollar rows are request-linked; unpriced and unknown attempts remain explicit. */
  get costSummary(): CostSummary {
    return summarizeCosts(this.entries);
  }

  get meta(): Extract<SessionEntry, { t: 'meta' }> | undefined {
    const entry = this.entries[0];
    return entry?.t === 'meta' ? structuredClone(entry) : undefined;
  }

  get lifecycleEntries(): readonly LifecycleEntry[] {
    return this.entries
      .filter((entry): entry is LifecycleEntry => 'v' in entry && entry.v === 2)
      .map((entry) => structuredClone(entry));
  }

  get lineage(): SessionLineage | undefined {
    const entry = this.lifecycleEntries.find(
      (item): item is Extract<LifecycleEntry, { t: 'session_lineage' }> => item.t === 'session_lineage',
    );
    if (!entry) return undefined;
    return {
      parentSessionId: entry.parentSessionId,
      relation: entry.relation,
      ...(entry.parentFile ? { parentFile: entry.parentFile } : {}),
      ...(entry.atMessage !== undefined ? { atMessage: entry.atMessage } : {}),
      ...(entry.priorUsage ? { priorUsage: structuredClone(entry.priorUsage) } : {}),
      ...(entry.priorUsageComplete !== undefined ? { priorUsageComplete: entry.priorUsageComplete } : {}),
      ...(entry.priorCost ? { priorCost: structuredClone(entry.priorCost) } : {}),
    };
  }

  get ready(): boolean {
    return this.lifecycleEntries.some((entry) => entry.t === 'session_ready');
  }

  get runStatus(): Extract<LifecycleEntry, { t: 'run_status' }> | undefined {
    const entry = this.lifecycleEntries.filter(
      (entry): entry is Extract<LifecycleEntry, { t: 'run_status' }> => entry.t === 'run_status',
    ).at(-1);
    return entry ? structuredClone(entry) : undefined;
  }

  get toolExecutions(): readonly ToolExecutionState[] {
    return [...reduceToolExecutions(this.entries).values()].map((state) => structuredClone(state));
  }

  get modelRequests(): readonly ModelRequestState[] {
    return [...reduceModelRequests(this.entries).values()].map((state) => structuredClone(state));
  }

  get interruptedModelRequests(): readonly ModelRequestState[] {
    return this.modelRequests.filter((state) => state.status === 'started');
  }

  get pendingToolExecutions(): readonly ToolExecutionState[] {
    return this.toolExecutions.filter((state) => state.status === 'planned' || state.status === 'started');
  }

  /** Gated calls with no recorded decision yet. */
  get awaitingApprovalExecutions(): readonly ToolExecutionState[] {
    return this.toolExecutions.filter((state) => state.status === 'awaiting_approval');
  }

  /**
   * Executions a resume must still settle: undecided gated calls plus decisions
   * that were recorded before anything started (0011 decision 4 — approved with
   * no `started` row means nothing began).
   */
  get suspendedToolExecutions(): readonly ToolExecutionState[] {
    return this.toolExecutions.filter(
      (state) =>
        state.status === 'awaiting_approval' ||
        (state.status === 'planned' && state.approval?.decision !== undefined),
    );
  }

  /** Budget accounting for the run segment that is open or ended suspended. */
  get openRun(): OpenRunState {
    return reduceOpenRun(this.entries);
  }

  /** Declared journal generation; 1 for sessions written before the marker existed. */
  get schemaVersion(): number {
    return journalSchemaVersion(this.entries);
  }

  get interruptedToolExecutions(): readonly ToolExecutionState[] {
    return this.toolExecutions.filter((state) => state.status === 'started');
  }
}

export interface LineageUsage {
  usage: Usage;
  /** False only for a legacy chain that was missing or exceeded the bounded ancestry scan. */
  complete: boolean;
  traversed: number;
}

export interface LineageCost {
  cost: CostSummary;
  /** False for missing ancestry or any unpriced/unknown request. */
  complete: boolean;
  traversed: number;
}

/** Durable request costs across a compacted/continued lineage, without re-pricing history. */
export function costAcrossSessionLineageDetailed(session: SessionView, maxDepth = 64): LineageCost {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError('maxDepth must be a positive safe integer');
  const total = emptyCostSummary();
  const seen = new Set<string>();
  let current: SessionView | undefined = session;
  let traversed = 0;
  let ancestryComplete = true;
  for (; current && traversed < maxDepth; traversed++) {
    if (seen.has(current.file)) throw new SessionCorruptionError('session lineage contains a cycle', current.file);
    seen.add(current.file);
    addCostSummary(total, current.costSummary);
    const lineage = current.lineage;
    if (lineage?.priorCost) {
      addCostSummary(total, lineage.priorCost);
      return { cost: total, complete: ancestryComplete && costComplete(total), traversed: traversed + 1 };
    }
    if (!lineage?.parentFile || (lineage.relation !== 'compaction' && lineage.relation !== 'continuation')) {
      ancestryComplete = ancestryComplete && (lineage?.parentFile !== undefined || lineage === undefined);
      return { cost: total, complete: ancestryComplete && costComplete(total), traversed: traversed + 1 };
    }
    const parentFile = isAbsolute(lineage.parentFile)
      ? lineage.parentFile
      : join(dirname(current.file), lineage.parentFile);
    if (!existsSync(parentFile)) {
      return { cost: total, complete: false, traversed: traversed + 1 };
    }
    current = Session.open(parentFile);
  }
  return { cost: total, complete: current === undefined && costComplete(total), traversed };
}

/** Provider-reported usage across a compacted/continued session lineage. */
export function usageAcrossSessionLineageDetailed(session: SessionView, maxDepth = 64): LineageUsage {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError('maxDepth must be a positive safe integer');
  const total = emptyUsage();
  const seen = new Set<string>();
  let current: SessionView | undefined = session;
  let traversed = 0;
  for (; current && traversed < maxDepth; traversed++) {
    if (seen.has(current.file)) throw new SessionCorruptionError('session lineage contains a cycle', current.file);
    seen.add(current.file);
    addUsage(total, current.usage);
    const lineage = current.lineage;
    if (lineage?.priorUsage) {
      addUsage(total, lineage.priorUsage);
      return { usage: total, complete: lineage.priorUsageComplete ?? true, traversed: traversed + 1 };
    }
    if (
      !lineage?.parentFile ||
      (lineage.relation !== 'compaction' && lineage.relation !== 'continuation')
    ) {
      return { usage: total, complete: lineage?.parentFile !== undefined || lineage === undefined, traversed: traversed + 1 };
    }
    const parentFile = isAbsolute(lineage.parentFile)
      ? lineage.parentFile
      : join(dirname(current.file), lineage.parentFile);
    if (!existsSync(parentFile)) return { usage: total, complete: false, traversed: traversed + 1 };
    current = Session.open(parentFile);
  }
  return { usage: total, complete: current === undefined, traversed };
}

/** Compatibility helper for callers that need only the bounded numeric total. */
export function usageAcrossSessionLineage(session: SessionView, maxDepth = 64): Usage {
  return usageAcrossSessionLineageDetailed(session, maxDepth).usage;
}
