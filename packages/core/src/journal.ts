import type { Message, ToolCallBlock, Usage } from '@pi/ai';

/** Rows written by piko 0.1. Kept verbatim so existing transcripts remain readable. */
export type LegacySessionEntry =
  | { t: 'meta'; v: 1; id: string; cwd: string; model: string; created: string }
  | { t: 'msg'; message: Message }
  | { t: 'usage'; usage: Usage };

export type RunStatus = 'running' | 'completed' | 'incomplete' | 'budget_exceeded' | 'canceled' | 'failed';
export type SessionLineageRelation = 'branch' | 'compaction' | 'continuation';

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
    })
  | (LifecycleBase & {
      t: 'model_request_completed';
      requestId: string;
      stopReason?: string;
      usage?: Usage;
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
  error?: string;
  retryable?: boolean;
  reason?: string;
}

export type ToolLifecycleEntry =
  | (LifecycleBase & {
      t: 'tool_planned';
      executionId: string;
      requestId?: string;
      call: ToolCallBlock;
    })
  | (LifecycleBase & { t: 'tool_started'; executionId: string })
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
  | (LifecycleBase & { t: 'run_status'; status: RunStatus; reason?: string })
  | (LifecycleBase & { t: 'session_ready' })
  | (LifecycleBase & { t: 'session_lineage' } & SessionLineage);

export type SessionEntry = LegacySessionEntry | LifecycleEntry;

export type ToolExecutionStatus = 'planned' | 'started' | 'skipped' | 'completed' | 'failed' | 'outcome_unknown';

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
}

const runStatuses = new Set<RunStatus>([
  'running',
  'completed',
  'incomplete',
  'budget_exceeded',
  'canceled',
  'failed',
]);
const lineageRelations = new Set<SessionLineageRelation>(['branch', 'compaction', 'continuation']);

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
      return;
    case 'model_request_completed':
      requireString(entry['requestId'], `${type}.requestId`);
      optionalString(entry['stopReason'], `${type}.stopReason`);
      if (entry['usage'] !== undefined) validateUsage(entry['usage'], `${type}.usage`);
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
    case 'tool_completed':
      requireString(entry['executionId'], `${type}.executionId`);
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
    if (entry.t === 'tool_started') {
      if (state.status !== 'planned') invalidTransition(`${entry.executionId} cannot start from ${state.status}`);
      state.status = 'started';
      state.startedAt = entry.at;
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

/** Reduce provider attempts so crash recovery can distinguish unknown billing. */
export function reduceModelRequests(entries: readonly SessionEntry[]): Map<string, ModelRequestState> {
  const states = new Map<string, ModelRequestState>();
  for (const entry of entries) {
    if (entry.t === 'model_request_started') {
      if (states.has(entry.requestId)) invalidTransition(`duplicate model request ${entry.requestId}`);
      states.set(entry.requestId, {
        requestId: entry.requestId,
        model: entry.model,
        ...(entry.messageCount !== undefined ? { messageCount: entry.messageCount } : {}),
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

/** Validate request/compaction uniqueness and terminal ordering in addition to tools. */
export function validateLifecycle(entries: readonly SessionEntry[]): void {
  reduceToolExecutions(entries);
  reduceModelRequests(entries);
  const compactions = new Map<string, 'started' | 'completed' | 'failed'>();
  let lineageSeen = false;
  let readySeen = false;
  for (const entry of entries) {
    if (entry.t === 'compaction_started') {
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
