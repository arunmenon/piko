import { addUsage, emptyUsage, type Message, type ToolCallBlock, type Usage } from '@pi/ai';
import {
  addRequestCost,
  emptyCostSummary,
  type CostSummary,
  type RequestCost,
  type SpendReservation,
} from './pricing.js';
import type { ApprovalRuleDecision, ApprovalRuleMatch, ToolApprovalGrant } from './tools/approval-rules.js';

/** Rows written by piko 0.1. Kept verbatim so existing transcripts remain readable. */
export type LegacySessionEntry =
  | { t: 'meta'; v: 1; id: string; cwd: string; model: string; created: string }
  | { t: 'msg'; message: Message }
  | { t: 'usage'; usage: Usage };

export type RunStatus =
  | 'running'
  | 'completed'
  | 'incomplete'
  | 'budget_exceeded'
  | 'canceled'
  | 'failed'
  | 'suspended';
export type SessionLineageRelation = 'branch' | 'compaction' | 'continuation';

/**
 * How a tolerated partial tail was repaired before the journal accepted new
 * rows (ADR 0015). `truncated_partial_line` discarded the bytes after the last
 * complete row; `appended_missing_newline` kept a complete but undelimited
 * final row and wrote the delimiter it lacked.
 */
export type JournalRepairKind = 'truncated_partial_line' | 'appended_missing_newline';

/**
 * Journal schema generation, written once per session as a `journal_schema` row.
 * Sessions created before the marker existed are read as generation 1; a file
 * declaring a newer generation is refused rather than half-understood.
 *
 * 1 — v0.2 lifecycle rows (model request, tool, compaction, run status, lineage).
 * 2 — adds approvals/suspension and optional request-linked pricing fields
 *     (ADRs 0011 and 0020).
 */
export const JOURNAL_SCHEMA_VERSION = 2;
export const LEGACY_JOURNAL_SCHEMA_VERSION = 1;

/** Run budget ceilings captured on a terminal row so a resume can continue under them. */
export interface RunBudgetSnapshot {
  maxModelRequests?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
  maxToolOutputBytes?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxSpendUSD?: number;
}

const runBudgetSnapshotFields = [
  'maxModelRequests',
  'maxToolCalls',
  'maxWallTimeMs',
  'maxToolOutputBytes',
  'maxInputTokens',
  'maxOutputTokens',
  'maxTotalTokens',
] as const;

export interface SessionLineage {
  parentSessionId: string;
  relation: SessionLineageRelation;
  parentFile?: string;
  atMessage?: number;
  /** Provider usage through the parent at publication time. New lineage heads
   *  carry this checkpoint so accounting remains bounded at any chain depth. */
  priorUsage?: Usage;
  /** False when priorUsage was itself reconstructed from a bounded legacy chain. */
  priorUsageComplete?: boolean;
  /** Dollar checkpoint paired with priorUsage for bounded lineage accounting. */
  priorCost?: CostSummary;
}

interface LifecycleBase {
  v: 2;
  /** Wall-clock audit time. Ordering is defined by JSONL position, not this value. */
  at: string;
}

export type ModelRequestEntry =
  | (LifecycleBase & {
      t: 'model_request_started';
      requestId: string;
      model: string;
      messageCount?: number;
      spendReservation?: SpendReservation;
    })
  | (LifecycleBase & {
      t: 'model_request_completed';
      requestId: string;
      stopReason?: string;
      usage?: Usage;
      cost?: RequestCost;
    })
  | (LifecycleBase & {
      t: 'model_request_failed';
      requestId: string;
      error: string;
      retryable?: boolean;
    })
  | (LifecycleBase & {
      t: 'model_request_outcome_unknown';
      requestId: string;
      reason: string;
    });

export type ModelRequestStatus = 'started' | 'completed' | 'failed' | 'outcome_unknown';

export interface ModelRequestState {
  requestId: string;
  model: string;
  messageCount?: number;
  status: ModelRequestStatus;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  usage?: Usage;
  spendReservation?: SpendReservation;
  cost?: RequestCost;
  error?: string;
  retryable?: boolean;
  reason?: string;
}

export type ApprovalDecision = 'approved' | 'edited' | 'rejected';

/**
 * Dispatch-time fingerprint of the workspace a side-effecting call was started
 * against (ADR 0007). A resumer that finds an `outcome_unknown` call can compare
 * this against the workspace it sees and tell whether anything moved underneath
 * it. Best-effort by construction: the field is absent whenever the digest could
 * not be taken, and an absent digest never means "unchanged".
 *
 * It rides the `tool_started` row rather than `tool_planned` because taking it
 * runs host git: nothing may probe a workspace for a call that policy, budget,
 * approval, or cancellation is about to refuse.
 */
export interface WorkspaceDigest {
  /** The only source today: a git checkout's HEAD plus its porcelain status. */
  kind: 'git';
  algorithm: 'sha256';
  /** Lowercase hex digest. */
  digest: string;
  /** Directory the digest describes; bash keeps its own cwd across calls. */
  workspace: string;
}

export type ToolLifecycleEntry =
  | (LifecycleBase & {
      t: 'tool_planned';
      executionId: string;
      requestId?: string;
      call: ToolCallBlock;
    })
  /** A gated call is deferred pending a recorded human decision (ADR 0011). */
  | (LifecycleBase & {
      t: 'tool_approval_requested';
      executionId: string;
      /**
       * The argument-prefix rule that decided this gate, when a rule decided it
       * (ADR 0011 addendum). Optional and additive, so the schema generation
       * does not move and rows written before rules existed stay valid.
       */
      rule?: ApprovalRuleMatch;
    })
  | (LifecycleBase & {
      t: 'tool_approval_decided';
      executionId: string;
      decision: ApprovalDecision;
      /** When the human decided, which is not the append time when a decision
       *  is collected by one invocation and applied by the next. */
      decidedAt: string;
      /** Replacement arguments for an `edited` decision; the planned row keeps the original. */
      editedArguments?: Record<string, unknown>;
      reason?: string;
    })
  | (LifecycleBase & { t: 'tool_started'; executionId: string; workspaceDigest?: WorkspaceDigest })
  | (LifecycleBase & { t: 'tool_skipped'; executionId: string; reason: string })
  | (LifecycleBase & { t: 'tool_completed'; executionId: string })
  | (LifecycleBase & { t: 'tool_failed'; executionId: string; error: string })
  | (LifecycleBase & { t: 'tool_outcome_unknown'; executionId: string; reason: string });

export type CompactionEntry =
  | (LifecycleBase & {
      t: 'compaction_started';
      compactionId: string;
      trigger: 'auto' | 'manual';
      keepFromMessage?: number;
    })
  | (LifecycleBase & {
      t: 'compaction_completed';
      compactionId: string;
      droppedMessages: number;
      targetSessionId?: string;
      usage?: Usage;
    })
  | (LifecycleBase & { t: 'compaction_failed'; compactionId: string; error: string });

export type LifecycleEntry =
  | ModelRequestEntry
  | ToolLifecycleEntry
  | CompactionEntry
  | (LifecycleBase & {
      t: 'run_status';
      status: RunStatus;
      reason?: string;
      /** Ceilings in force for the run, recorded so a resumed run continues under them. */
      budget?: RunBudgetSnapshot;
    })
  | (LifecycleBase & { t: 'journal_schema'; schema: number })
  /**
   * One extension module admitted at startup (ADR 0012): what was imported, the
   * SHA-256 of the bytes that were imported, the tools it contributed, and
   * whether the user pinned that digest on the command line. Additive under
   * 0019, so the schema generation does not move.
   */
  | (LifecycleBase & {
      t: 'extension_loaded';
      path: string;
      sha256: string;
      toolNames: string[];
      pinned: boolean;
      /**
       * True when the digest covers the entry module's own bytes only, read
       * around the import, and not its transitive imports. Optional so older
       * rows stay valid; the loader always writes it (ADR 0012 addendum).
       */
      entryOnly?: boolean;
    })
  | (LifecycleBase & {
      t: 'journal_repaired';
      /** What the repair did to the append boundary. */
      repair: JournalRepairKind;
      /** Byte offset the repair was applied at: the truncation point, or where
       *  the delimiter was written. */
      offset: number;
      /** Bytes the repair removed; zero when only a delimiter was added. */
      discardedBytes: number;
    })
  /**
   * A session-scoped "always allow this prefix" grant, or its revocation
   * (ADR 0011 addendum). Additive under 0019, so the schema generation does not
   * move. Replayed on resume; a grant can only narrow prompting.
   */
  | (LifecycleBase & { t: 'tool_approval_grant' } & ToolApprovalGrant)
  | (LifecycleBase & { t: 'session_ready' })
  | (LifecycleBase & { t: 'session_lineage' } & SessionLineage);

export type SessionEntry = LegacySessionEntry | LifecycleEntry;

export type ToolExecutionStatus =
  | 'planned'
  | 'awaiting_approval'
  | 'started'
  | 'skipped'
  | 'completed'
  | 'failed'
  | 'outcome_unknown';

/** Approval trail for one gated execution. Present once approval was requested. */
export interface ToolApprovalState {
  requestedAt: string;
  /** The argument-prefix rule that gated the call, when a rule did. */
  rule?: ApprovalRuleMatch;
  decision?: ApprovalDecision;
  decidedAt?: string;
  reason?: string;
  editedArguments?: Record<string, unknown>;
}

export interface ToolExecutionState {
  executionId: string;
  requestId?: string;
  call: ToolCallBlock;
  status: ToolExecutionStatus;
  plannedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  reason?: string;
  approval?: ToolApprovalState;
  /** Present when the dispatcher could fingerprint the workspace at start (ADR 0007). */
  workspaceDigest?: WorkspaceDigest;
}

const runStatuses = new Set<RunStatus>([
  'running',
  'completed',
  'incomplete',
  'budget_exceeded',
  'canceled',
  'failed',
  'suspended',
]);
const approvalDecisions = new Set<ApprovalDecision>(['approved', 'edited', 'rejected']);
const approvalRuleDecisions = new Set<ApprovalRuleDecision>(['allow', 'prompt', 'deny']);
const lineageRelations = new Set<SessionLineageRelation>(['branch', 'compaction', 'continuation']);
const journalRepairKinds = new Set<JournalRepairKind>(['truncated_partial_line', 'appended_missing_newline']);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function requireStringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function optionalStringValue(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireStringValue(value, path);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBoolean(value, path);
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${path} must be a positive integer`);
  }
  return value as number;
}

function validateRunBudgetSnapshot(value: unknown, path: string): void {
  const budget = requireRecord(value, path);
  for (const field of runBudgetSnapshotFields) {
    if (budget[field] !== undefined) requirePositiveInteger(budget[field], `${path}.${field}`);
  }
  if (budget['maxSpendUSD'] !== undefined) requirePositiveFinite(budget['maxSpendUSD'], `${path}.maxSpendUSD`);
}

function requireFiniteNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite nonnegative number`);
  }
  return value;
}

function requirePositiveFinite(value: unknown, path: string): number {
  const number = requireFiniteNonNegative(value, path);
  if (number <= 0) throw new TypeError(`${path} must be greater than zero`);
  return number;
}

function validatePricingProvenance(value: unknown, path: string): void {
  const pricing = requireRecord(value, path);
  if (!['explicit', 'fresh_cache', 'network', 'stale_cache'].includes(String(pricing['source']))) {
    throw new TypeError(`${path}.source is unsupported`);
  }
  requireString(pricing['revision'], `${path}.revision`);
  if (pricing['currency'] !== 'USD') throw new TypeError(`${path}.currency must be "USD"`);
  requireTimestamp(pricing['effectiveAt'], `${path}.effectiveAt`);
}

function validateRequestCost(value: unknown, path: string): void {
  const cost = requireRecord(value, path);
  requireString(cost['model'], `${path}.model`);
  requireFiniteNonNegative(cost['usd'], `${path}.usd`);
  requireFiniteNonNegative(cost['inputUSD'], `${path}.inputUSD`);
  requireFiniteNonNegative(cost['outputUSD'], `${path}.outputUSD`);
  requireFiniteNonNegative(cost['cacheReadUSD'], `${path}.cacheReadUSD`);
  requireFiniteNonNegative(cost['cacheWriteUSD'], `${path}.cacheWriteUSD`);
  validatePricingProvenance(cost['pricing'], `${path}.pricing`);
  const components =
    (cost['inputUSD'] as number) +
    (cost['outputUSD'] as number) +
    (cost['cacheReadUSD'] as number) +
    (cost['cacheWriteUSD'] as number);
  if (Math.abs((cost['usd'] as number) - components) > 1e-12) {
    throw new TypeError(`${path}.usd must equal its component costs`);
  }
}

function validateSpendReservation(value: unknown, path: string): void {
  const reservation = requireRecord(value, path);
  requireString(reservation['model'], `${path}.model`);
  requireFiniteNonNegative(reservation['usd'], `${path}.usd`);
  requirePositiveInteger(reservation['inputTokenUpperBound'], `${path}.inputTokenUpperBound`);
  requirePositiveInteger(reservation['outputTokenUpperBound'], `${path}.outputTokenUpperBound`);
  requirePositiveInteger(reservation['attempts'], `${path}.attempts`);
  validatePricingProvenance(reservation['pricing'], `${path}.pricing`);
}

function validateCostSummary(value: unknown, path: string): void {
  const summary = requireRecord(value, path);
  requireFiniteNonNegative(summary['actualUSD'], `${path}.actualUSD`);
  requireFiniteNonNegative(summary['reservedUSD'], `${path}.reservedUSD`);
  requireNonNegativeInteger(summary['pricedRequests'], `${path}.pricedRequests`);
  requireNonNegativeInteger(summary['unpricedRequests'], `${path}.unpricedRequests`);
  requireNonNegativeInteger(summary['unknownRequests'], `${path}.unknownRequests`);
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNonNegativeInteger(value, path);
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireString(value, path);
  if (Number.isNaN(Date.parse(timestamp))) throw new TypeError(`${path} must be an ISO timestamp`);
  return timestamp;
}

function validateUsage(value: unknown, path: string): asserts value is Usage {
  const usage = requireRecord(value, path);
  requireNonNegativeInteger(usage['inputTokens'], `${path}.inputTokens`);
  requireNonNegativeInteger(usage['outputTokens'], `${path}.outputTokens`);
  requireNonNegativeInteger(usage['cacheReadTokens'], `${path}.cacheReadTokens`);
  requireNonNegativeInteger(usage['cacheWriteTokens'], `${path}.cacheWriteTokens`);
}

function validateImageBlock(value: Record<string, unknown>, path: string): void {
  requireString(value['mimeType'], `${path}.mimeType`);
  requireStringValue(value['data'], `${path}.data`);
}

function validateToolCall(value: unknown, path: string): asserts value is ToolCallBlock {
  const call = requireRecord(value, path);
  if (call['type'] !== 'toolCall') throw new TypeError(`${path}.type must be "toolCall"`);
  requireString(call['id'], `${path}.id`);
  requireString(call['name'], `${path}.name`);
  requireRecord(call['arguments'], `${path}.arguments`);
}

function validateWorkspaceDigest(value: unknown, path: string): void {
  const digest = requireRecord(value, path);
  if (digest['kind'] !== 'git') throw new TypeError(`${path}.kind is unsupported`);
  if (digest['algorithm'] !== 'sha256') throw new TypeError(`${path}.algorithm must be "sha256"`);
  const hex = requireString(digest['digest'], `${path}.digest`);
  if (!SHA256_HEX_PATTERN.test(hex)) throw new TypeError(`${path}.digest must be 64 lowercase hex characters`);
  requireString(digest['workspace'], `${path}.workspace`);
}

function validateApprovalRuleMatch(value: unknown, path: string): void {
  const match = requireRecord(value, path);
  requireNonNegativeInteger(match['index'], `${path}.index`);
  requireString(match['tool'], `${path}.tool`);
  if (!approvalRuleDecisions.has(match['decision'] as ApprovalRuleDecision)) {
    throw new TypeError(`${path}.decision is unsupported`);
  }
  optionalString(match['prefix'], `${path}.prefix`);
}

function validateMessage(value: unknown, path: string): asserts value is Message {
  const message = requireRecord(value, path);
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') throw new TypeError(`${path}.role must be "user" or "assistant"`);
  if (!Array.isArray(message['content'])) throw new TypeError(`${path}.content must be an array`);
  for (let index = 0; index < message['content'].length; index++) {
    const blockPath = `${path}.content[${index}]`;
    const block = requireRecord(message['content'][index], blockPath);
    switch (block['type']) {
      case 'text':
        requireStringValue(block['text'], `${blockPath}.text`);
        break;
      case 'image':
        if (role !== 'user') throw new TypeError(`${blockPath} is not valid assistant content`);
        validateImageBlock(block, blockPath);
        break;
      case 'toolCall':
        if (role !== 'assistant') throw new TypeError(`${blockPath} is not valid user content`);
        validateToolCall(block, blockPath);
        break;
      case 'thinking':
        if (role !== 'assistant') throw new TypeError(`${blockPath} is not valid user content`);
        requireStringValue(block['thinking'], `${blockPath}.thinking`);
        requireStringValue(block['signature'], `${blockPath}.signature`);
        optionalStringValue(block['redactedData'], `${blockPath}.redactedData`);
        break;
      case 'toolResult': {
        if (role !== 'user') throw new TypeError(`${blockPath} is not valid assistant content`);
        requireString(block['toolCallId'], `${blockPath}.toolCallId`);
        requireString(block['toolName'], `${blockPath}.toolName`);
        optionalBoolean(block['isError'], `${blockPath}.isError`);
        if (!Array.isArray(block['content'])) throw new TypeError(`${blockPath}.content must be an array`);
        for (let innerIndex = 0; innerIndex < block['content'].length; innerIndex++) {
          const innerPath = `${blockPath}.content[${innerIndex}]`;
          const inner = requireRecord(block['content'][innerIndex], innerPath);
          if (inner['type'] === 'text') requireStringValue(inner['text'], `${innerPath}.text`);
          else if (inner['type'] === 'image') validateImageBlock(inner, innerPath);
          else throw new TypeError(`${innerPath}.type is unsupported`);
        }
        break;
      }
      default:
        throw new TypeError(`${blockPath}.type is unsupported`);
    }
  }
}

function validateLifecycleBase(entry: Record<string, unknown>): void {
  if (entry['v'] !== 2) throw new TypeError('lifecycle entry v must be 2');
  requireTimestamp(entry['at'], 'entry.at');
}

/** Runtime validation for both legacy transcript rows and v2 lifecycle rows. */
export function validateSessionEntry(value: unknown): asserts value is SessionEntry {
  const entry = requireRecord(value, 'entry');
  const type = requireString(entry['t'], 'entry.t');
  switch (type) {
    case 'meta':
      if (entry['v'] !== 1) throw new TypeError('meta.v must be 1');
      requireString(entry['id'], 'meta.id');
      requireString(entry['cwd'], 'meta.cwd');
      requireString(entry['model'], 'meta.model');
      requireTimestamp(entry['created'], 'meta.created');
      return;
    case 'msg':
      validateMessage(entry['message'], 'msg.message');
      return;
    case 'usage':
      validateUsage(entry['usage'], 'usage.usage');
      return;
    default:
      validateLifecycleBase(entry);
  }

  switch (type) {
    case 'model_request_started':
      requireString(entry['requestId'], `${type}.requestId`);
      requireString(entry['model'], `${type}.model`);
      optionalNonNegativeInteger(entry['messageCount'], `${type}.messageCount`);
      if (entry['spendReservation'] !== undefined) {
        validateSpendReservation(entry['spendReservation'], `${type}.spendReservation`);
      }
      return;
    case 'model_request_completed':
      requireString(entry['requestId'], `${type}.requestId`);
      optionalString(entry['stopReason'], `${type}.stopReason`);
      if (entry['usage'] !== undefined) validateUsage(entry['usage'], `${type}.usage`);
      if (entry['cost'] !== undefined) validateRequestCost(entry['cost'], `${type}.cost`);
      if (entry['cost'] !== undefined && entry['usage'] === undefined) {
        throw new TypeError(`${type}.cost requires usage`);
      }
      return;
    case 'model_request_failed':
      requireString(entry['requestId'], `${type}.requestId`);
      requireString(entry['error'], `${type}.error`);
      optionalBoolean(entry['retryable'], `${type}.retryable`);
      return;
    case 'model_request_outcome_unknown':
      requireString(entry['requestId'], `${type}.requestId`);
      requireString(entry['reason'], `${type}.reason`);
      return;
    case 'tool_planned':
      requireString(entry['executionId'], `${type}.executionId`);
      optionalString(entry['requestId'], `${type}.requestId`);
      validateToolCall(entry['call'], `${type}.call`);
      return;
    case 'tool_started':
      requireString(entry['executionId'], `${type}.executionId`);
      if (entry['workspaceDigest'] !== undefined) {
        validateWorkspaceDigest(entry['workspaceDigest'], `${type}.workspaceDigest`);
      }
      return;
    case 'tool_completed':
      requireString(entry['executionId'], `${type}.executionId`);
      return;
    case 'tool_approval_requested':
      requireString(entry['executionId'], `${type}.executionId`);
      if (entry['rule'] !== undefined) validateApprovalRuleMatch(entry['rule'], `${type}.rule`);
      return;
    case 'tool_approval_grant':
      requireString(entry['tool'], `${type}.tool`);
      requireString(entry['prefix'], `${type}.prefix`);
      requireTimestamp(entry['grantedAt'], `${type}.grantedAt`);
      optionalBoolean(entry['revoked'], `${type}.revoked`);
      return;
    case 'tool_approval_decided':
      requireString(entry['executionId'], `${type}.executionId`);
      if (!approvalDecisions.has(entry['decision'] as ApprovalDecision)) {
        throw new TypeError(`${type}.decision is unsupported`);
      }
      requireTimestamp(entry['decidedAt'], `${type}.decidedAt`);
      if (entry['editedArguments'] !== undefined) {
        requireRecord(entry['editedArguments'], `${type}.editedArguments`);
      }
      if (entry['decision'] !== 'edited' && entry['editedArguments'] !== undefined) {
        throw new TypeError(`${type}.editedArguments is only valid for an edited decision`);
      }
      optionalString(entry['reason'], `${type}.reason`);
      return;
    case 'tool_skipped':
      requireString(entry['executionId'], `${type}.executionId`);
      requireString(entry['reason'], `${type}.reason`);
      return;
    case 'tool_failed':
      requireString(entry['executionId'], `${type}.executionId`);
      requireString(entry['error'], `${type}.error`);
      return;
    case 'tool_outcome_unknown':
      requireString(entry['executionId'], `${type}.executionId`);
      requireString(entry['reason'], `${type}.reason`);
      return;
    case 'compaction_started': {
      requireString(entry['compactionId'], `${type}.compactionId`);
      const trigger = entry['trigger'];
      if (trigger !== 'auto' && trigger !== 'manual') throw new TypeError(`${type}.trigger is unsupported`);
      optionalNonNegativeInteger(entry['keepFromMessage'], `${type}.keepFromMessage`);
      return;
    }
    case 'compaction_completed':
      requireString(entry['compactionId'], `${type}.compactionId`);
      requireNonNegativeInteger(entry['droppedMessages'], `${type}.droppedMessages`);
      optionalString(entry['targetSessionId'], `${type}.targetSessionId`);
      if (entry['usage'] !== undefined) validateUsage(entry['usage'], `${type}.usage`);
      return;
    case 'compaction_failed':
      requireString(entry['compactionId'], `${type}.compactionId`);
      requireString(entry['error'], `${type}.error`);
      return;
    case 'run_status':
      if (!runStatuses.has(entry['status'] as RunStatus)) throw new TypeError(`${type}.status is unsupported`);
      optionalString(entry['reason'], `${type}.reason`);
      if (entry['budget'] !== undefined) validateRunBudgetSnapshot(entry['budget'], `${type}.budget`);
      return;
    case 'journal_schema':
      requirePositiveInteger(entry['schema'], `${type}.schema`);
      return;
    case 'extension_loaded': {
      requireString(entry['path'], `${type}.path`);
      const digest = requireString(entry['sha256'], `${type}.sha256`);
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${type}.sha256 must be a lowercase hex SHA-256`);
      const toolNames = entry['toolNames'];
      if (!Array.isArray(toolNames)) throw new TypeError(`${type}.toolNames must be an array`);
      toolNames.forEach((name, index) => requireString(name, `${type}.toolNames[${index}]`));
      requireBoolean(entry['pinned'], `${type}.pinned`);
      optionalBoolean(entry['entryOnly'], `${type}.entryOnly`);
      return;
    }
    case 'journal_repaired':
      if (!journalRepairKinds.has(entry['repair'] as JournalRepairKind)) {
        throw new TypeError(`${type}.repair is unsupported`);
      }
      requireNonNegativeInteger(entry['offset'], `${type}.offset`);
      requireNonNegativeInteger(entry['discardedBytes'], `${type}.discardedBytes`);
      if (entry['repair'] === 'appended_missing_newline' && (entry['discardedBytes'] as number) !== 0) {
        throw new TypeError(`${type}.discardedBytes must be zero when only a delimiter was added`);
      }
      return;
    case 'session_ready':
      return;
    case 'session_lineage':
      requireString(entry['parentSessionId'], `${type}.parentSessionId`);
      if (!lineageRelations.has(entry['relation'] as SessionLineageRelation)) {
        throw new TypeError(`${type}.relation is unsupported`);
      }
      optionalString(entry['parentFile'], `${type}.parentFile`);
      optionalNonNegativeInteger(entry['atMessage'], `${type}.atMessage`);
      if (entry['priorUsage'] !== undefined) validateUsage(entry['priorUsage'], `${type}.priorUsage`);
      optionalBoolean(entry['priorUsageComplete'], `${type}.priorUsageComplete`);
      if (entry['priorCost'] !== undefined) validateCostSummary(entry['priorCost'], `${type}.priorCost`);
      return;
    default:
      throw new TypeError(`unsupported session entry type: ${type}`);
  }
}

export function parseSessionEntry(value: unknown): SessionEntry {
  validateSessionEntry(value);
  return value;
}

function invalidTransition(message: string): never {
  throw new TypeError(`invalid lifecycle transition: ${message}`);
}

/**
 * Reduces and validates tool lifecycle events. This is deliberately strict: a
 * transcript with contradictory side-effect state is unsafe to resume.
 */
export function reduceToolExecutions(entries: readonly SessionEntry[]): Map<string, ToolExecutionState> {
  const states = new Map<string, ToolExecutionState>();
  for (const entry of entries) {
    if (entry.t === 'tool_planned') {
      if (states.has(entry.executionId)) invalidTransition(`duplicate tool execution ${entry.executionId}`);
      states.set(entry.executionId, {
        executionId: entry.executionId,
        ...(entry.requestId ? { requestId: entry.requestId } : {}),
        call: entry.call,
        status: 'planned',
        plannedAt: entry.at,
      });
      continue;
    }
    if (
      entry.t !== 'tool_approval_requested' &&
      entry.t !== 'tool_approval_decided' &&
      entry.t !== 'tool_started' &&
      entry.t !== 'tool_skipped' &&
      entry.t !== 'tool_completed' &&
      entry.t !== 'tool_failed' &&
      entry.t !== 'tool_outcome_unknown'
    ) {
      continue;
    }
    const state = states.get(entry.executionId);
    if (!state) invalidTransition(`${entry.t} references unknown tool execution ${entry.executionId}`);
    if (entry.t === 'tool_approval_requested') {
      if (state.status !== 'planned') {
        invalidTransition(`${entry.executionId} cannot request approval from ${state.status}`);
      }
      state.status = 'awaiting_approval';
      state.approval = { requestedAt: entry.at, ...(entry.rule ? { rule: structuredClone(entry.rule) } : {}) };
      continue;
    }
    if (entry.t === 'tool_approval_decided') {
      if (state.status !== 'awaiting_approval' || !state.approval) {
        invalidTransition(`${entry.executionId} cannot be decided from ${state.status}`);
      }
      state.approval = {
        ...state.approval,
        decision: entry.decision,
        decidedAt: entry.decidedAt,
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        ...(entry.editedArguments !== undefined ? { editedArguments: entry.editedArguments } : {}),
      };
      // A rejection is terminal by itself: nothing ran and nothing will. An
      // approval returns the execution to `planned`, which is exactly what it
      // is — cleared for dispatch, not yet started (ADR 0011 decision 4).
      if (entry.decision === 'rejected') {
        state.status = 'skipped';
        state.endedAt = entry.at;
        state.reason = entry.reason ?? 'rejected by a human reviewer';
      } else {
        state.status = 'planned';
      }
      continue;
    }
    if (entry.t === 'tool_started') {
      if (state.status !== 'planned') invalidTransition(`${entry.executionId} cannot start from ${state.status}`);
      state.status = 'started';
      state.startedAt = entry.at;
      if (entry.workspaceDigest) state.workspaceDigest = structuredClone(entry.workspaceDigest);
      continue;
    }
    if (entry.t === 'tool_skipped') {
      if (state.status !== 'planned') invalidTransition(`${entry.executionId} cannot be skipped from ${state.status}`);
      state.status = 'skipped';
      state.endedAt = entry.at;
      state.reason = entry.reason;
      continue;
    }
    if (state.status !== 'started') invalidTransition(`${entry.executionId} cannot finish from ${state.status}`);
    state.endedAt = entry.at;
    if (entry.t === 'tool_completed') state.status = 'completed';
    else if (entry.t === 'tool_failed') {
      state.status = 'failed';
      state.error = entry.error;
    } else {
      state.status = 'outcome_unknown';
      state.reason = entry.reason;
    }
  }
  return states;
}

/**
 * Replay the session-scoped approval grants (ADR 0011 addendum). Rows are
 * ordered, and a later row for the same `(tool, prefix)` pair replaces the
 * earlier one, so a revoking row removes the grant it names. This is what makes
 * a grant survive a resume without a second row type.
 */
export function reduceApprovalGrants(entries: readonly SessionEntry[]): ToolApprovalGrant[] {
  const grants = new Map<string, ToolApprovalGrant>();
  for (const entry of entries) {
    if (entry.t !== 'tool_approval_grant') continue;
    const key = `${entry.tool} ${entry.prefix}`;
    if (entry.revoked) grants.delete(key);
    else grants.set(key, { tool: entry.tool, prefix: entry.prefix, grantedAt: entry.grantedAt });
  }
  return [...grants.values()];
}

/** Reduce provider attempts so crash recovery can distinguish unknown billing. */
export function reduceModelRequests(entries: readonly SessionEntry[]): Map<string, ModelRequestState> {
  const states = new Map<string, ModelRequestState>();
  for (const entry of entries) {
    if (entry.t === 'model_request_started') {
      if (states.has(entry.requestId)) invalidTransition(`duplicate model request ${entry.requestId}`);
      if (entry.spendReservation && entry.spendReservation.model !== entry.model) {
        invalidTransition(`${entry.requestId} reservation model does not match request model`);
      }
      states.set(entry.requestId, {
        requestId: entry.requestId,
        model: entry.model,
        ...(entry.messageCount !== undefined ? { messageCount: entry.messageCount } : {}),
        ...(entry.spendReservation !== undefined
          ? { spendReservation: structuredClone(entry.spendReservation) }
          : {}),
        status: 'started',
        startedAt: entry.at,
      });
      continue;
    }
    if (
      entry.t !== 'model_request_completed' &&
      entry.t !== 'model_request_failed' &&
      entry.t !== 'model_request_outcome_unknown'
    ) {
      continue;
    }
    const state = states.get(entry.requestId);
    if (!state) invalidTransition(`${entry.t} references unknown model request ${entry.requestId}`);
    if (state.status !== 'started') invalidTransition(`${entry.requestId} cannot finish from ${state.status}`);
    state.endedAt = entry.at;
    if (entry.t === 'model_request_completed') {
      state.status = 'completed';
      if (entry.stopReason !== undefined) state.stopReason = entry.stopReason;
      if (entry.usage !== undefined) state.usage = structuredClone(entry.usage);
      if (entry.cost !== undefined) {
        if (entry.cost.model !== state.model) {
          invalidTransition(`${entry.requestId} cost model does not match request model`);
        }
        if (state.spendReservation) {
          const reserved = state.spendReservation.pricing;
          const priced = entry.cost.pricing;
          if (
            reserved.source !== priced.source ||
            reserved.revision !== priced.revision ||
            reserved.currency !== priced.currency ||
            reserved.effectiveAt !== priced.effectiveAt
          ) {
            invalidTransition(`${entry.requestId} cost provenance does not match its reservation`);
          }
        }
        state.cost = structuredClone(entry.cost);
      }
    } else if (entry.t === 'model_request_failed') {
      state.status = 'failed';
      state.error = entry.error;
      if (entry.retryable !== undefined) state.retryable = entry.retryable;
    } else {
      state.status = 'outcome_unknown';
      state.reason = entry.reason;
    }
  }
  return states;
}

/** Reconstruct actual and conservatively reserved dollars without re-pricing history. */
export function summarizeCosts(entries: readonly SessionEntry[]): CostSummary {
  const summary = emptyCostSummary();
  let lifecycleAccountingStarted = false;
  for (const entry of entries) {
    if (entry.t === 'model_request_started') lifecycleAccountingStarted = true;
    else if (entry.t === 'usage' && !lifecycleAccountingStarted) summary.unpricedRequests++;
  }
  for (const request of reduceModelRequests(entries).values()) {
    if (request.status === 'completed') {
      addRequestCost(summary, request.cost);
      if (!request.cost && request.spendReservation) summary.reservedUSD += request.spendReservation.usd;
      continue;
    }
    if (request.status === 'failed' || request.status === 'outcome_unknown' || request.status === 'started') {
      summary.unknownRequests++;
      if (request.spendReservation) summary.reservedUSD += request.spendReservation.usd;
    }
  }
  return summary;
}

/** Validate request/compaction uniqueness and terminal ordering in addition to tools. */
export function validateLifecycle(entries: readonly SessionEntry[]): void {
  reduceToolExecutions(entries);
  reduceModelRequests(entries);
  const compactions = new Map<string, 'started' | 'completed' | 'failed'>();
  let lineageSeen = false;
  let readySeen = false;
  let schemaSeen = false;
  for (const entry of entries) {
    if (entry.t === 'journal_schema') {
      if (schemaSeen) invalidTransition('a session can have only one journal schema marker');
      schemaSeen = true;
      if (entry.schema > JOURNAL_SCHEMA_VERSION) {
        throw new TypeError(
          `journal schema ${entry.schema} is newer than the supported version ${JOURNAL_SCHEMA_VERSION}; upgrade piko to read this session`,
        );
      }
    } else if (entry.t === 'compaction_started') {
      if (compactions.has(entry.compactionId)) invalidTransition(`duplicate compaction ${entry.compactionId}`);
      compactions.set(entry.compactionId, 'started');
    } else if (entry.t === 'compaction_completed' || entry.t === 'compaction_failed') {
      if (compactions.get(entry.compactionId) !== 'started') {
        invalidTransition(`${entry.t} does not follow a started compaction ${entry.compactionId}`);
      }
      compactions.set(entry.compactionId, entry.t === 'compaction_completed' ? 'completed' : 'failed');
    } else if (entry.t === 'session_lineage') {
      if (lineageSeen) invalidTransition('a session can have only one lineage entry');
      lineageSeen = true;
    } else if (entry.t === 'session_ready') {
      if (readySeen) invalidTransition('a session can have only one ready marker');
      readySeen = true;
    }
  }
}

/** Durable record of every append-boundary repair this journal has survived (ADR 0015). */
export function journalRepairs(
  entries: readonly SessionEntry[],
): readonly Extract<LifecycleEntry, { t: 'journal_repaired' }>[] {
  return entries.filter(
    (entry): entry is Extract<LifecycleEntry, { t: 'journal_repaired' }> => entry.t === 'journal_repaired',
  );
}

/** Declared journal generation; sessions written before the marker are generation 1. */
export function journalSchemaVersion(entries: readonly SessionEntry[]): number {
  for (const entry of entries) {
    if (entry.t === 'journal_schema') return entry.schema;
  }
  return LEGACY_JOURNAL_SCHEMA_VERSION;
}

/** Budget accounting for the run segment that is still open, or ended suspended. */
export interface OpenRunState {
  usage: Usage;
  cost: CostSummary;
  modelRequests: number;
  toolCalls: number;
  /** Ceilings recorded on the segment's terminal row, when it has one. */
  budget?: RunBudgetSnapshot;
}

/**
 * Reduce every lifecycle row belonging to the newest run segment. A resumed turn
 * seeds its counters from this, so 0009's bounded-per-input property holds across
 * a suspension instead of restarting at zero.
 *
 * A segment starts at a `running` marker that follows a terminal status (or the
 * start of the file). `running` after `suspended` continues the same segment, so
 * a run cannot buy fresh budget by suspending repeatedly.
 */
export function reduceOpenRun(entries: readonly SessionEntry[]): OpenRunState {
  let start = 0;
  let afterTerminal = true;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.t !== 'run_status') continue;
    if (entry.status === 'running' && afterTerminal) start = index + 1;
    afterTerminal = entry.status !== 'running' && entry.status !== 'suspended';
  }
  const state: OpenRunState = { usage: emptyUsage(), cost: emptyCostSummary(), modelRequests: 0, toolCalls: 0 };
  const segmentEntries = entries.slice(start);
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.t === 'model_request_started') {
      state.modelRequests++;
    } else if (entry.t === 'model_request_completed') {
      if (entry.usage) addUsage(state.usage, entry.usage);
    }
    else if (entry.t === 'tool_started') state.toolCalls++;
    else if (entry.t === 'run_status' && entry.budget) state.budget = structuredClone(entry.budget);
  }
  state.cost = summarizeCosts(segmentEntries);
  return state;
}
