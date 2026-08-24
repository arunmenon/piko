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
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { addUsage, emptyUsage, type Message, type ToolCallBlock, type Usage } from '@pi/ai';
import {
  JOURNAL_SCHEMA_VERSION,
  journalSchemaVersion,
  parseSessionEntry,
  reduceModelRequests,
  reduceOpenRun,
  reduceToolExecutions,
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
    if (!fstatSync(fd).isFile()) throw new TypeError(`session is not a regular file: ${file}`);
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
  const sessions: { session: Session; file: string; mtime: number; created: number }[] = [];
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
  const parentCache = new Map<string, Session>();
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
  const candidates = (leaves.length > 0 ? leaves : valid).filter(
    (item) => !options.excludeActivelyLocked || !sessionLockExists(item.file),
  );
  candidates.sort((a, b) => b.mtime - a.mtime || b.created - a.created || b.file.localeCompare(a.file));
  return candidates[0]?.file;
}

interface LockOwner {
  pid: number;
  token?: string;
  created?: string;
}

function parseLockOwner(text: string): LockOwner | undefined {
  const legacyPid = Number(text.trim());
  if (Number.isSafeInteger(legacyPid) && legacyPid > 0) return { pid: legacyPid };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record['v'] !== 1 || !Number.isSafeInteger(record['pid']) || (record['pid'] as number) <= 0) return undefined;
    if (typeof record['token'] !== 'string' || record['token'].length === 0) return undefined;
    if (typeof record['created'] !== 'string' || Number.isNaN(Date.parse(record['created']))) return undefined;
    return { pid: record['pid'] as number, token: record['token'], created: record['created'] };
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
  const lockPath = `${file}.lock`;
  const token = randomUUID();
  const payload = `${JSON.stringify({ v: 1, pid: process.pid, token, created: now() })}\n`;

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
  return release;
}

type TailRepair = { kind: 'truncate'; size: number } | { kind: 'newline' };

function parseFile(file: string): { entries: SessionEntry[]; tailRepair?: TailRepair } {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new TypeError(`session is not a regular file: ${file}`);
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

  static create(cwd: string, model: string, dir = sessionsDirFor(cwd), options: SessionCreateOptions = {}): Session {
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
      const release = tryLockSession(file);
      if (!release) {
        if (options.id) throw new Error(`could not reserve session lock ${file}`);
        continue;
      }
      try {
        const session = Session.create(cwd, model, dir, { ...options, id });
        return { session, release };
      } catch (error) {
        release();
        if (!options.id && isErrno(error, 'EEXIST')) continue;
        throw error;
      }
    }
    throw new Error(`could not allocate and lock a unique session after ${CREATE_ATTEMPTS} attempts`);
  }

  static open(file: string): Session {
    const { entries, tailRepair } = parseFile(file);
    const meta = entries[0]!;
    if (meta.t !== 'meta') throw new SessionCorruptionError('session must begin with a meta entry', file, 1);
    return new Session(file, meta.id, entries, tailRepair);
  }

  /** New session containing legacy messages/usage up to message `atMessage` (0-based). */
  branch(atMessage: number, cwd: string, model: string): Session {
    if (!Number.isInteger(atMessage) || atMessage < 0) throw new RangeError('branch message index must be non-negative');
    const branched = Session.create(cwd, model, dirname(this.file), {
      lineage: { parentSessionId: this.id, parentFile: this.file, relation: 'branch', atMessage },
    });
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
    branched.appendMany(copied);
    branched.markReady();
    return branched;
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
        if (!fstatSync(fd).isFile()) throw new TypeError(`session is not a regular file: ${this.file}`);
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

  beginModelRequest(model: string, options: { requestId?: string; messageCount?: number } = {}): string {
    const requestId = options.requestId ?? randomUUID();
    this.append({
      t: 'model_request_started',
      v: 2,
      at: now(),
      requestId,
      model,
      ...(options.messageCount !== undefined ? { messageCount: options.messageCount } : {}),
    });
    return requestId;
  }

  completeModelRequest(requestId: string, options: { stopReason?: string; usage?: Usage } = {}): void {
    this.append({
      t: 'model_request_completed',
      v: 2,
      at: now(),
      requestId,
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
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
    const rows: Usage[] = [];
    let lifecycleAccountingStarted = false;
    for (const entry of this.entries) {
      if (entry.t === 'model_request_started') lifecycleAccountingStarted = true;
      if (entry.t === 'usage' && !lifecycleAccountingStarted) rows.push(structuredClone(entry.usage));
      if (entry.t === 'model_request_completed' && entry.usage) rows.push(structuredClone(entry.usage));
    }
    return rows;
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

/** Provider-reported usage across a compacted/continued session lineage. */
export function usageAcrossSessionLineageDetailed(session: Session, maxDepth = 64): LineageUsage {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError('maxDepth must be a positive safe integer');
  const total = emptyUsage();
  const seen = new Set<string>();
  let current: Session | undefined = session;
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
export function usageAcrossSessionLineage(session: Session, maxDepth = 64): Usage {
  return usageAcrossSessionLineageDetailed(session, maxDepth).usage;
}
