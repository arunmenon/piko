/**
 * Root-budget authority for one session tree (ADR 0026).
 *
 * Every ceiling in ADR 0009/0020 is scoped to a single user turn. This module
 * adds the second scope the matrix always implied: one authority per session
 * tree, file-backed under `~/.pi/budgets/<rootRunId>.json`, guarded by an
 * exclusive lock file so that reserve and reconcile are atomic across
 * processes. A child joins the tree by reading `PI_BUDGET_AUTHORITY` from its
 * environment, and its exposure is charged to itself, to every ancestor, and
 * to the root.
 *
 * What is atomic and what is not:
 *
 * - Atomic: one `reserve`, `reconcile`, `releaseUnknown`, `recordActiveTime`
 *   or `join` call. Each takes the exclusive lock, re-reads the ledger from
 *   disk, mutates it, writes a temporary file and renames it over the ledger,
 *   then releases the lock. A reader never observes a half-written ledger, and
 *   two concurrent reservations can never both be admitted against the same
 *   remaining dollar.
 * - Not atomic: the pair (reserve, dispatch). A process killed between the two
 *   leaves an admitted reservation with no request behind it. That is the
 *   deliberate 0007/0020 unknown-exposure rule: the reservation is retained on
 *   every ancestor until an explicit `reconcile` or `releaseUnknown`, and this
 *   module never releases one on its own.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/** Environment variable carrying the ledger path a child joins (ADR 0026). */
export const BUDGET_AUTHORITY_ENVIRONMENT_NAME = 'PI_BUDGET_AUTHORITY';

/** Journal generation of the ledger document; a mismatch is refused, never guessed. */
export const BUDGET_LEDGER_SCHEMA_VERSION = 1;

const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_BACKOFF_START_MS = 1;
const LOCK_BACKOFF_MAX_MS = 16;
/** A lock older than this whose owner is a verifiably dead local pid may be broken. */
const STALE_LOCK_MS = 2_000;
/** Terminal rows retained for audit; arithmetic uses the cumulative totals, never these. */
const MAX_RETAINED_HISTORY_ROWS = 256;
/** Distinct runs one tree may register before joining is refused. */
const MAX_REGISTERED_RUNS = 10_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_RECORD_BYTES = 4_096;
const USD_SCALE = 1_000_000_000_000;

/** Session-tree ceilings. Any subset may be set; an unset ceiling is not enforced. */
export interface RootBudgetCeilings {
  /** Dollar ceiling for the whole tree, enforced against reconciled plus outstanding exposure. */
  maxSpendUSD?: number;
  /** Provider-reported token ceiling for the whole tree. */
  maxTokens?: number;
  /** Model plus tool wall time attributable to the tree, summed across parallel children. */
  maxActiveTimeMs?: number;
  /** Wall-clock milliseconds since the root started. */
  maxElapsedTimeMs?: number;
}

/** One admitted reservation. Terminal rows move to the audit history. */
export interface BudgetLedgerRow {
  requestId: string;
  runId: string;
  /** Root first, immediate parent last. Empty for the root's own requests. */
  ancestors: string[];
  reservedUSD: number;
  reservedTokens: number;
  status: 'reserved' | 'reconciled' | 'released';
  actualUSD?: number;
  actualTokens?: number;
  at: string;
}

/** What one run and its subtree have cost the tree. */
export interface BudgetCharge {
  admittedUSD: number;
  admittedTokens: number;
  admittedRequests: number;
  reconciledUSD: number;
  reconciledTokens: number;
  reconciledRequests: number;
  outstandingUSD: number;
  outstandingTokens: number;
  outstandingRequests: number;
  activeTimeMs: number;
}

interface RegisteredRun {
  parentRunId?: string;
  ancestors: string[];
  joinedAt: string;
}

interface BudgetLedgerDocument {
  schemaVersion: number;
  rootRunId: string;
  createdAt: string;
  startedAtEpochMs: number;
  ceilings: RootBudgetCeilings;
  runs: Record<string, RegisteredRun>;
  /** Outstanding reservations only. */
  rows: BudgetLedgerRow[];
  /** Most recent terminal rows, for audit; never used in arithmetic. */
  history: BudgetLedgerRow[];
  /** Per-run charge, including every ancestor of every row. */
  charges: Record<string, BudgetCharge>;
}

/** The tree-wide figures a caller reports or enforces against. */
export interface RootBudgetSnapshot {
  rootRunId: string;
  ledgerPath: string;
  ceilings: RootBudgetCeilings;
  admittedUSD: number;
  admittedTokens: number;
  admittedRequests: number;
  reconciledUSD: number;
  reconciledTokens: number;
  reconciledRequests: number;
  /** Reservations with no terminal acknowledgement; retained exposure (0007, 0020). */
  outstandingUSD: number;
  outstandingTokens: number;
  outstandingRequests: number;
  activeTimeMs: number;
  elapsedTimeMs: number;
  /** Present only for a configured ceiling. */
  remainingUSD?: number;
  remainingTokens?: number;
  remainingActiveTimeMs?: number;
  remainingElapsedTimeMs?: number;
}

export type BudgetRefusalReason = 'spend' | 'tokens' | 'active_time' | 'elapsed_time';

export type BudgetReservationOutcome =
  | { admitted: true; snapshot: RootBudgetSnapshot }
  | { admitted: false; reason: BudgetRefusalReason; snapshot: RootBudgetSnapshot };

export interface BudgetReservationRequest {
  /** The run making the request; must have joined this authority. */
  runId: string;
  /** Stable request identity, also used to reconcile or release the reservation. */
  requestId: string;
  amountUSD: number;
  tokens: number;
}

/** The exclusive ledger lock could not be taken; the caller must fail closed. */
export class BudgetAuthorityLockError extends Error {
  constructor(readonly lockPath: string, readonly waitedMs: number) {
    super(`root-budget lock could not be acquired within ${waitedMs}ms: ${lockPath}`);
    this.name = 'BudgetAuthorityLockError';
  }
}

/** The ledger on disk is missing, unreadable, or of an unsupported generation. */
export class BudgetLedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BudgetLedgerError';
  }
}

function usd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('budget USD value must be finite and nonnegative');
  return Math.round(value * USD_SCALE) / USD_SCALE;
}

function usdCeiling(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('budget USD value must be finite and nonnegative');
  return Math.ceil(value * USD_SCALE) / USD_SCALE;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

/**
 * Synchronous bounded sleep. The whole ledger path is synchronous so that a
 * reservation cannot interleave with itself inside one process; a promise-based
 * wait here would reintroduce exactly the interleaving the lock exists to stop.
 */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to another user.
    return isErrno(error, 'EPERM');
  }
}

interface LockRecord {
  v: 1;
  pid: number;
  host: string;
  token: string;
  created: string;
}

function parseLockRecord(text: string): LockRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record['v'] !== 1) return undefined;
    if (!Number.isSafeInteger(record['pid']) || (record['pid'] as number) <= 0) return undefined;
    if (typeof record['host'] !== 'string' || record['host'].length === 0) return undefined;
    if (typeof record['token'] !== 'string' || record['token'].length === 0) return undefined;
    if (typeof record['created'] !== 'string') return undefined;
    return record as unknown as LockRecord;
  } catch {
    return undefined;
  }
}

/**
 * Break one lock whose owner is verifiably dead on this host. Unlike the
 * session lock (0024), which is never cleaned automatically because a stranded
 * session only blocks its own resume, a stranded budget lock wedges every
 * process in the tree. The classification is the same one `recoverStaleLock`
 * trusts: same host, dead pid, and old enough that a live owner mid-write
 * cannot be mistaken for a dead one.
 */
function breakStaleLock(lockPath: string): boolean {
  let record: LockRecord | undefined;
  let ageMs: number;
  try {
    const stats = statSync(lockPath);
    if (!stats.isFile() || stats.size > MAX_LOCK_RECORD_BYTES) return false;
    ageMs = Date.now() - stats.mtimeMs;
    record = parseLockRecord(readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }
  if (!record || ageMs < STALE_LOCK_MS) return false;
  if (record.host !== hostname()) return false;
  if (processAlive(record.pid)) return false;
  try {
    // Re-read immediately before unlinking: the owner may have released and a
    // live process may have taken the lock since the classification above.
    const recheck = parseLockRecord(readFileSync(lockPath, 'utf8'));
    if (!recheck || recheck.token !== record.token) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive create-and-retry lock, the same `wx` pattern the session lock uses,
 * with bounded exponential backoff and a hard deadline. Failing to acquire is
 * never silently tolerated: the caller fails closed.
 */
function acquireLedgerLock(lockPath: string, timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS): () => void {
  const token = randomUUID();
  const payload = `${JSON.stringify({
    v: 1,
    pid: process.pid,
    host: hostname(),
    token,
    created: new Date().toISOString(),
  } satisfies LockRecord)}\n`;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let backoffMs = LOCK_BACKOFF_START_MS;
  let staleCheckDone = false;
  for (;;) {
    try {
      writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = parseLockRecord(readFileSync(lockPath, 'utf8'));
          if (owner?.token === token) unlinkSync(lockPath);
        } catch {
          /* already gone, or no longer ours */
        }
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    // One stale-owner check halfway through the wait, and one last attempt at
    // the deadline, so a tree whose lock holder was killed recovers instead of
    // wedging every sibling. Anything still held by a live owner is a timeout.
    const atDeadline = Date.now() >= deadline;
    if (!staleCheckDone && (atDeadline || Date.now() >= startedAt + timeoutMs / 2)) {
      staleCheckDone = true;
      if (breakStaleLock(lockPath)) continue;
    }
    if (atDeadline) throw new BudgetAuthorityLockError(lockPath, timeoutMs);
    sleepSync(backoffMs);
    backoffMs = Math.min(LOCK_BACKOFF_MAX_MS, backoffMs * 2);
  }
}

function emptyCharge(): BudgetCharge {
  return {
    admittedUSD: 0,
    admittedTokens: 0,
    admittedRequests: 0,
    reconciledUSD: 0,
    reconciledTokens: 0,
    reconciledRequests: 0,
    outstandingUSD: 0,
    outstandingTokens: 0,
    outstandingRequests: 0,
    activeTimeMs: 0,
  };
}

function validateCeilings(ceilings: RootBudgetCeilings): void {
  if (ceilings.maxSpendUSD !== undefined && (!Number.isFinite(ceilings.maxSpendUSD) || ceilings.maxSpendUSD <= 0)) {
    throw new RangeError('invalid session budget maxSpendUSD: expected a finite number > 0');
  }
  for (const name of ['maxTokens', 'maxActiveTimeMs', 'maxElapsedTimeMs'] as const) {
    const value = ceilings[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`invalid session budget ${name}: expected a safe integer > 0`);
    }
  }
}

function readLedger(path: string): BudgetLedgerDocument {
  let text: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new BudgetLedgerError(`root-budget ledger is not a regular file: ${path}`);
    if (stats.size > MAX_LEDGER_BYTES) throw new BudgetLedgerError(`root-budget ledger exceeds ${MAX_LEDGER_BYTES} bytes: ${path}`);
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof BudgetLedgerError) throw error;
    throw new BudgetLedgerError(`root-budget ledger is unreadable: ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new BudgetLedgerError(`root-budget ledger is not valid JSON: ${path}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BudgetLedgerError(`root-budget ledger is not an object: ${path}`);
  }
  const document = parsed as BudgetLedgerDocument;
  if (document.schemaVersion !== BUDGET_LEDGER_SCHEMA_VERSION) {
    throw new BudgetLedgerError(
      `root-budget ledger schema ${String(document.schemaVersion)} is not supported (expected ${BUDGET_LEDGER_SCHEMA_VERSION}): ${path}`,
    );
  }
  if (typeof document.rootRunId !== 'string' || !Array.isArray(document.rows) || typeof document.charges !== 'object') {
    throw new BudgetLedgerError(`root-budget ledger is missing required fields: ${path}`);
  }
  return document;
}

/** Publish a ledger revision by rename, so a concurrent reader never sees a partial write. */
function writeLedger(path: string, document: BudgetLedgerDocument): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      /* preserve the original write error */
    }
    throw error;
  }
}

function snapshotOf(document: BudgetLedgerDocument, path: string, nowMs: number): RootBudgetSnapshot {
  const root = document.charges[document.rootRunId] ?? emptyCharge();
  const elapsedTimeMs = Math.max(0, nowMs - document.startedAtEpochMs);
  const exposureUSD = usdCeiling(root.reconciledUSD + root.outstandingUSD);
  const exposureTokens = root.reconciledTokens + root.outstandingTokens;
  const ceilings = document.ceilings;
  return {
    rootRunId: document.rootRunId,
    ledgerPath: path,
    ceilings: { ...ceilings },
    admittedUSD: root.admittedUSD,
    admittedTokens: root.admittedTokens,
    admittedRequests: root.admittedRequests,
    reconciledUSD: root.reconciledUSD,
    reconciledTokens: root.reconciledTokens,
    reconciledRequests: root.reconciledRequests,
    outstandingUSD: root.outstandingUSD,
    outstandingTokens: root.outstandingTokens,
    outstandingRequests: root.outstandingRequests,
    activeTimeMs: root.activeTimeMs,
    elapsedTimeMs,
    ...(ceilings.maxSpendUSD !== undefined ? { remainingUSD: usd(Math.max(0, ceilings.maxSpendUSD - exposureUSD)) } : {}),
    ...(ceilings.maxTokens !== undefined ? { remainingTokens: Math.max(0, ceilings.maxTokens - exposureTokens) } : {}),
    ...(ceilings.maxActiveTimeMs !== undefined
      ? { remainingActiveTimeMs: Math.max(0, ceilings.maxActiveTimeMs - root.activeTimeMs) }
      : {}),
    ...(ceilings.maxElapsedTimeMs !== undefined
      ? { remainingElapsedTimeMs: Math.max(0, ceilings.maxElapsedTimeMs - elapsedTimeMs) }
      : {}),
  };
}

/** Default ledger directory: outside the workspace, so the model cannot rewrite it. */
export function budgetsDir(): string {
  return join(homedir(), '.pi', 'budgets');
}

/** The ledger path a child inherits, or undefined when this process is not inside a budgeted tree. */
export function readBudgetAuthorityPath(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = environment[BUDGET_AUTHORITY_ENVIRONMENT_NAME];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw;
}

export interface CreateBudgetAuthorityOptions {
  rootRunId: string;
  ceilings?: RootBudgetCeilings;
  /** Directory holding the ledger; defaults to `~/.pi/budgets`. */
  directory?: string;
  /** Wall-clock origin for the elapsed ceiling; defaults to now. */
  startedAtEpochMs?: number;
}

/**
 * Every mutation is `lock -> read -> mutate -> atomic write -> unlock`. The
 * instance holds no cached ledger state, so two authorities in one process (a
 * root and a joined child in the same test) can never disagree with the file.
 */
export class RootBudgetAuthority {
  private constructor(
    readonly path: string,
    readonly rootRunId: string,
    private readonly runId: string,
  ) {}

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  /** Create the ledger for a new tree and register the root run. */
  static create(options: CreateBudgetAuthorityOptions): RootBudgetAuthority {
    if (!options.rootRunId) throw new Error('a root-budget authority requires a nonempty rootRunId');
    const ceilings = { ...(options.ceilings ?? {}) };
    validateCeilings(ceilings);
    const directory = options.directory ?? budgetsDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${encodeURIComponent(options.rootRunId)}.json`);
    const startedAtEpochMs = options.startedAtEpochMs ?? Date.now();
    const document: BudgetLedgerDocument = {
      schemaVersion: BUDGET_LEDGER_SCHEMA_VERSION,
      rootRunId: options.rootRunId,
      createdAt: new Date(startedAtEpochMs).toISOString(),
      startedAtEpochMs,
      ceilings,
      runs: { [options.rootRunId]: { ancestors: [], joinedAt: new Date(startedAtEpochMs).toISOString() } },
      rows: [],
      history: [],
      charges: { [options.rootRunId]: emptyCharge() },
    };
    const release = acquireLedgerLock(`${path}.lock`);
    try {
      writeLedger(path, document);
    } finally {
      release();
    }
    return new RootBudgetAuthority(path, options.rootRunId, options.rootRunId);
  }

  /**
   * Join an existing tree. The joining run is registered with its ancestor
   * chain resolved from the ledger, so every later row it writes is charged to
   * the root and to each ancestor between.
   */
  static join(path: string, options: { runId: string; parentRunId?: string }): RootBudgetAuthority {
    if (!options.runId) throw new Error('joining a root-budget authority requires a nonempty runId');
    let rootRunId = '';
    const release = acquireLedgerLock(`${path}.lock`);
    try {
      const document = readLedger(path);
      rootRunId = document.rootRunId;
      const existing = document.runs[options.runId];
      if (!existing) {
        if (Object.keys(document.runs).length >= MAX_REGISTERED_RUNS) {
          throw new BudgetLedgerError(
            `root-budget tree already holds ${MAX_REGISTERED_RUNS} runs; refusing to join ${options.runId}`,
          );
        }
        const parent = options.parentRunId ? document.runs[options.parentRunId] : undefined;
        const ancestors =
          options.runId === document.rootRunId
            ? []
            : parent && options.parentRunId
              ? [...parent.ancestors, options.parentRunId]
              : [document.rootRunId];
        document.runs[options.runId] = {
          ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
          ancestors,
          joinedAt: new Date().toISOString(),
        };
        document.charges[options.runId] ??= emptyCharge();
        writeLedger(path, document);
      }
    } finally {
      release();
    }
    return new RootBudgetAuthority(path, rootRunId, options.runId);
  }

  /** The ceilings this tree enforces, read from the ledger. */
  get ceilings(): RootBudgetCeilings {
    return { ...readLedger(this.path).ceilings };
  }

  /** Tree-wide figures. Reads without the lock: publication is by rename, so a read is never partial. */
  snapshot(): RootBudgetSnapshot {
    return snapshotOf(readLedger(this.path), this.path, Date.now());
  }

  /** What one run and its subtree have cost the tree. */
  chargeFor(runId: string): BudgetCharge {
    return { ...(readLedger(this.path).charges[runId] ?? emptyCharge()) };
  }

  /** Outstanding reservations, newest last. Exposure with no terminal acknowledgement. */
  outstanding(): BudgetLedgerRow[] {
    return readLedger(this.path).rows.map((row) => ({ ...row, ancestors: [...row.ancestors] }));
  }

  private mutate<T>(operation: (document: BudgetLedgerDocument, nowMs: number) => { result: T; write: boolean }): T {
    const release = acquireLedgerLock(this.lockPath);
    try {
      const document = readLedger(this.path);
      const { result, write } = operation(document, Date.now());
      if (write) writeLedger(this.path, document);
      return result;
    } finally {
      release();
    }
  }

  private runsCharged(document: BudgetLedgerDocument, runId: string, ancestors: readonly string[]): BudgetCharge[] {
    // A run's exposure is charged to itself and to every ancestor up to the
    // root; the set guards against a self-referential chain charging twice.
    const identifiers = new Set<string>([runId, ...ancestors, document.rootRunId]);
    return [...identifiers].map((identifier) => (document.charges[identifier] ??= emptyCharge()));
  }

  /**
   * Admit or refuse one reservation against the root's remaining budget. The
   * whole decision happens under the lock, so the sum of admitted reservations
   * can never exceed the ceiling however many children race here at once.
   */
  reserve(request: BudgetReservationRequest): BudgetReservationOutcome {
    if (!request.requestId) throw new Error('a reservation requires a nonempty requestId');
    if (!Number.isFinite(request.amountUSD) || request.amountUSD < 0) {
      throw new RangeError('a reservation amountUSD must be finite and nonnegative');
    }
    if (!Number.isSafeInteger(request.tokens) || request.tokens < 0) {
      throw new RangeError('a reservation token bound must be a nonnegative safe integer');
    }
    return this.mutate((document, nowMs) => {
      if (document.rows.some((row) => row.requestId === request.requestId)) {
        throw new Error(`request ${request.requestId} already holds a reservation in this tree`);
      }
      const current = snapshotOf(document, this.path, nowMs);
      const amountUSD = usdCeiling(request.amountUSD);
      const ceilings = document.ceilings;
      const refuse = (reason: BudgetRefusalReason): { result: BudgetReservationOutcome; write: boolean } => ({
        result: { admitted: false, reason, snapshot: current },
        write: false,
      });
      if (ceilings.maxElapsedTimeMs !== undefined && current.elapsedTimeMs >= ceilings.maxElapsedTimeMs) {
        return refuse('elapsed_time');
      }
      if (ceilings.maxActiveTimeMs !== undefined && current.activeTimeMs >= ceilings.maxActiveTimeMs) {
        return refuse('active_time');
      }
      if (ceilings.maxSpendUSD !== undefined) {
        const exposure = usdCeiling(current.reconciledUSD + current.outstandingUSD + amountUSD);
        if (exposure > ceilings.maxSpendUSD) return refuse('spend');
      }
      if (ceilings.maxTokens !== undefined) {
        const exposure = current.reconciledTokens + current.outstandingTokens + request.tokens;
        if (exposure > ceilings.maxTokens) return refuse('tokens');
      }
      const registered = document.runs[request.runId];
      const ancestors = registered ? [...registered.ancestors] : [document.rootRunId];
      if (!registered) {
        document.runs[request.runId] = { ancestors, joinedAt: new Date(nowMs).toISOString() };
      }
      const row: BudgetLedgerRow = {
        requestId: request.requestId,
        runId: request.runId,
        ancestors,
        reservedUSD: amountUSD,
        reservedTokens: request.tokens,
        status: 'reserved',
        at: new Date(nowMs).toISOString(),
      };
      document.rows.push(row);
      for (const charge of this.runsCharged(document, request.runId, ancestors)) {
        charge.admittedUSD = usdCeiling(charge.admittedUSD + amountUSD);
        charge.admittedTokens += request.tokens;
        charge.admittedRequests++;
        charge.outstandingUSD = usdCeiling(charge.outstandingUSD + amountUSD);
        charge.outstandingTokens += request.tokens;
        charge.outstandingRequests++;
      }
      return {
        result: { admitted: true, snapshot: snapshotOf(document, this.path, nowMs) },
        write: true,
      };
    });
  }

  /**
   * Replace a reservation with what the request actually cost. Reconciling a
   * request that holds no reservation is a no-op: a terminal acknowledgement
   * must never be able to create exposure or subtract it twice.
   */
  reconcile(requestId: string, actualUSD: number, actualTokens: number): RootBudgetSnapshot {
    if (!Number.isFinite(actualUSD) || actualUSD < 0) throw new RangeError('actualUSD must be finite and nonnegative');
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) {
      throw new RangeError('actualTokens must be a nonnegative safe integer');
    }
    return this.settle(requestId, 'reconciled', usd(actualUSD), actualTokens);
  }

  /**
   * Drop a reservation whose request is known never to have been billed. This
   * is never called automatically: an unknown outcome keeps its full
   * reservation on every ancestor until someone explicitly says otherwise.
   */
  releaseUnknown(requestId: string): RootBudgetSnapshot {
    return this.settle(requestId, 'released', 0, 0);
  }

  private settle(
    requestId: string,
    status: 'reconciled' | 'released',
    actualUSD: number,
    actualTokens: number,
  ): RootBudgetSnapshot {
    return this.mutate((document, nowMs) => {
      const index = document.rows.findIndex((row) => row.requestId === requestId);
      if (index < 0) return { result: snapshotOf(document, this.path, nowMs), write: false };
      const [row] = document.rows.splice(index, 1);
      const settled = row!;
      for (const charge of this.runsCharged(document, settled.runId, settled.ancestors)) {
        charge.outstandingUSD = usd(Math.max(0, charge.outstandingUSD - settled.reservedUSD));
        charge.outstandingTokens = Math.max(0, charge.outstandingTokens - settled.reservedTokens);
        charge.outstandingRequests = Math.max(0, charge.outstandingRequests - 1);
        if (status === 'reconciled') {
          charge.reconciledUSD = usd(charge.reconciledUSD + actualUSD);
          charge.reconciledTokens += actualTokens;
          charge.reconciledRequests++;
        }
      }
      settled.status = status;
      settled.actualUSD = actualUSD;
      settled.actualTokens = actualTokens;
      document.history.push(settled);
      if (document.history.length > MAX_RETAINED_HISTORY_ROWS) {
        document.history.splice(0, document.history.length - MAX_RETAINED_HISTORY_ROWS);
      }
      return { result: snapshotOf(document, this.path, nowMs), write: true };
    });
  }

  /**
   * Add model or tool wall time attributable to one run. Parallel children sum:
   * two children each busy for a second cost the tree two seconds of active
   * time and one second of elapsed time.
   */
  recordActiveTime(runId: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const rounded = Math.round(milliseconds);
    if (rounded <= 0) return;
    this.mutate((document) => {
      const registered = document.runs[runId];
      const ancestors = registered ? registered.ancestors : [document.rootRunId];
      for (const charge of this.runsCharged(document, runId, ancestors)) {
        charge.activeTimeMs += rounded;
      }
      return { result: undefined, write: true };
    });
  }

  /** Remove the ledger and its lock. Only the process that owns the root should call this. */
  remove(): void {
    for (const target of [this.path, this.lockPath]) {
      try {
        unlinkSync(target);
      } catch {
        /* already gone */
      }
    }
  }

  /** The run identity this handle writes rows under. */
  get localRunId(): string {
    return this.runId;
  }
}

/**
 * Attach to the tree named by `PI_BUDGET_AUTHORITY`, or start a new tree when
 * one or more session ceilings are configured. Returns undefined when this
 * process is neither inside a tree nor asked to bound one, which is the
 * unchanged pre-0026 behavior.
 */
export function resolveBudgetAuthority(options: {
  runId: string;
  parentRunId?: string;
  ceilings?: RootBudgetCeilings;
  directory?: string;
  environment?: NodeJS.ProcessEnv;
}): RootBudgetAuthority | undefined {
  const environment = options.environment ?? process.env;
  const inherited = readBudgetAuthorityPath(environment);
  if (inherited) {
    return RootBudgetAuthority.join(inherited, {
      runId: options.runId,
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    });
  }
  const ceilings = options.ceilings ?? {};
  const configured = Object.values(ceilings).some((value) => value !== undefined);
  if (!configured) return undefined;
  return RootBudgetAuthority.create({
    rootRunId: options.runId,
    ceilings,
    ...(options.directory ? { directory: options.directory } : {}),
  });
}

/** Reminder configuration; thresholds are fractions of the root budget still remaining. */
export interface BudgetReminderPolicy {
  /** Fire once as remaining budget falls to or below each fraction (default 0.5 and 0.2). */
  remainingFractions?: readonly number[];
  /** Also fire every N admitted requests. */
  everyRequests?: number;
}

export const DEFAULT_REMAINING_FRACTIONS = [0.5, 0.2] as const;

function formatDollars(value: number): string {
  return `$${value.toFixed(6)}`;
}

/**
 * Decides when the model is told how much tree budget is left. The message is a
 * `[harness]` turn message, exactly like the flail guard's: it is never part of
 * the fixed prefix, so it costs nothing until it actually fires.
 */
export class BudgetReminderTracker {
  private readonly fractions: number[];
  private readonly everyRequests?: number;
  private firedFractions = new Set<number>();
  private requestsSinceReminder = 0;

  constructor(policy: BudgetReminderPolicy = {}) {
    const fractions = [...(policy.remainingFractions ?? DEFAULT_REMAINING_FRACTIONS)];
    for (const fraction of fractions) {
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
        throw new RangeError('a budget reminder threshold must be a fraction in (0, 1)');
      }
    }
    if (policy.everyRequests !== undefined && (!Number.isSafeInteger(policy.everyRequests) || policy.everyRequests < 1)) {
      throw new RangeError('budget reminder everyRequests must be a safe integer >= 1');
    }
    // Highest first, so a snapshot that crosses two thresholds at once reports
    // the tightest one and marks both as fired.
    this.fractions = fractions.sort((left, right) => right - left);
    if (policy.everyRequests !== undefined) this.everyRequests = policy.everyRequests;
  }

  /**
   * The reminder due before the next provider request, if any. Call exactly
   * once per request: the every-N counter advances here.
   */
  next(snapshot: RootBudgetSnapshot): string | undefined {
    this.requestsSinceReminder++;
    const fraction = remainingFraction(snapshot);
    let crossed: number | undefined;
    if (fraction !== undefined) {
      for (const threshold of this.fractions) {
        if (fraction <= threshold && !this.firedFractions.has(threshold)) {
          this.firedFractions.add(threshold);
          crossed ??= threshold;
        }
      }
    }
    const periodic =
      this.everyRequests !== undefined && this.requestsSinceReminder >= this.everyRequests ? this.everyRequests : undefined;
    if (crossed === undefined && periodic === undefined) return undefined;
    this.requestsSinceReminder = 0;
    return budgetReminderText(snapshot);
  }
}

/** Smallest remaining fraction across the configured dollar and token ceilings. */
export function remainingFraction(snapshot: RootBudgetSnapshot): number | undefined {
  const fractions: number[] = [];
  if (snapshot.ceilings.maxSpendUSD !== undefined && snapshot.remainingUSD !== undefined) {
    fractions.push(snapshot.remainingUSD / snapshot.ceilings.maxSpendUSD);
  }
  if (snapshot.ceilings.maxTokens !== undefined && snapshot.remainingTokens !== undefined) {
    fractions.push(snapshot.remainingTokens / snapshot.ceilings.maxTokens);
  }
  return fractions.length > 0 ? Math.min(...fractions) : undefined;
}

/**
 * The reminder the model sees. It states remaining dollars and tokens for the
 * whole session tree, and says plainly that the harness, not the model, ends
 * the run when the budget is gone (ADR 0009's principle, restated where the
 * model can act on it).
 */
export function budgetReminderText(snapshot: RootBudgetSnapshot): string {
  const parts: string[] = [];
  if (snapshot.ceilings.maxSpendUSD !== undefined && snapshot.remainingUSD !== undefined) {
    parts.push(
      `${formatDollars(snapshot.remainingUSD)} of a ${formatDollars(snapshot.ceilings.maxSpendUSD)} spend ceiling`,
    );
  } else {
    parts.push('no dollar ceiling');
  }
  if (snapshot.ceilings.maxTokens !== undefined && snapshot.remainingTokens !== undefined) {
    parts.push(`${snapshot.remainingTokens} of ${snapshot.ceilings.maxTokens} tokens`);
  } else {
    parts.push('no token ceiling');
  }
  if (snapshot.ceilings.maxActiveTimeMs !== undefined && snapshot.remainingActiveTimeMs !== undefined) {
    parts.push(`${Math.round(snapshot.remainingActiveTimeMs / 1_000)}s of active time`);
  }
  if (snapshot.ceilings.maxElapsedTimeMs !== undefined && snapshot.remainingElapsedTimeMs !== undefined) {
    parts.push(`${Math.round(snapshot.remainingElapsedTimeMs / 1_000)}s of elapsed time`);
  }
  return (
    `[harness] Budget remaining for this session tree (this run and every child it spawned): ${parts.join(', ')}. ` +
    'The harness stops the turn when a ceiling is reached, so finish or hand off the work that fits what is left rather than starting something that does not.'
  );
}
