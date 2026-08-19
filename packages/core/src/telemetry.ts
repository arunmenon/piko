import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Version of the exported audit/telemetry envelope. This contract is separate
 * from both the session recovery journal and AgentEvent's interactive UI stream.
 */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export type TelemetryIdKind = 'session' | 'run' | 'request' | 'tool' | 'event' | 'span';

/** IDs are opaque. The prefix is only for operators reading raw JSONL. */
export function createTelemetryId(kind: TelemetryIdKind): string {
  return `${kind}_${randomUUID()}`;
}

export interface TelemetryContext {
  /** Stable across resumed turns that belong to the same persisted session. */
  sessionId: string;
  /** Stable for one Agent.run invocation. */
  runId: string;
  /** Correlates a child run without requiring a shared process or trace backend. */
  parentRunId?: string;
  /** Stable for one provider request, including all streamed chunks. */
  requestId?: string;
  /** Provider-issued tool call ID. */
  toolCallId?: string;
  /** Harness-issued ID for one attempted tool execution. */
  toolExecutionId?: string;
}

export function createTelemetryContext(
  sessionId = createTelemetryId('session'),
  options: { runId?: string; parentRunId?: string } = {},
): TelemetryContext {
  return {
    sessionId,
    runId: options.runId ?? createTelemetryId('run'),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
  };
}

export type TelemetryScalar = string | number | boolean;
export type TelemetryAttributeValue = TelemetryScalar | readonly TelemetryScalar[];
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export type RuntimeEventName =
  | 'run.status'
  | 'model.response'
  | 'tool.planned'
  | 'policy.decision'
  | 'budget.exceeded'
  | 'context.offloaded'
  | 'context.preflight_failed'
  | 'session.lineage'
  | 'runtime.error';

export type RuntimeSpanName = 'agent.run' | 'model.request' | 'tool.execute' | 'context.compact';
export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';
export type TelemetrySpanStatus = 'ok' | 'error' | 'canceled' | 'incomplete' | 'budget_exceeded' | 'unknown';

interface RuntimeTelemetryBase extends TelemetryContext {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  /** Stable deduplication ID for this exported envelope. */
  eventId: string;
  timestamp: string;
}

export interface RuntimeAuditEvent extends RuntimeTelemetryBase {
  kind: 'event';
  name: RuntimeEventName;
  level: TelemetryLevel;
  attributes?: TelemetryAttributes;
}

export interface RuntimeSpanStarted extends RuntimeTelemetryBase {
  kind: 'span_started';
  name: RuntimeSpanName;
  spanId: string;
  parentSpanId?: string;
  attributes?: TelemetryAttributes;
}

export interface TelemetryError {
  type: string;
  message: string;
  stack?: string;
}

export interface RuntimeSpanEnded extends RuntimeTelemetryBase {
  kind: 'span_ended';
  name: RuntimeSpanName;
  spanId: string;
  parentSpanId?: string;
  status: TelemetrySpanStatus;
  durationMs?: number;
  error?: TelemetryError;
  attributes?: TelemetryAttributes;
}

export type RuntimeTelemetryEvent = RuntimeAuditEvent | RuntimeSpanStarted | RuntimeSpanEnded;

interface EnvelopeOverrides {
  eventId?: string;
  timestamp?: string;
}

function envelope(context: TelemetryContext, overrides: EnvelopeOverrides): RuntimeTelemetryBase {
  return {
    ...context,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: overrides.eventId ?? createTelemetryId('event'),
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

export interface RuntimeEventInput extends EnvelopeOverrides {
  name: RuntimeEventName;
  level?: TelemetryLevel;
  attributes?: TelemetryAttributes;
}

export function createRuntimeEvent(context: TelemetryContext, input: RuntimeEventInput): RuntimeAuditEvent {
  return {
    ...envelope(context, input),
    kind: 'event',
    name: input.name,
    level: input.level ?? 'info',
    ...(input.attributes ? { attributes: input.attributes } : {}),
  };
}

export interface SpanStartedInput extends EnvelopeOverrides {
  name: RuntimeSpanName;
  spanId?: string;
  parentSpanId?: string;
  attributes?: TelemetryAttributes;
}

export function createSpanStarted(context: TelemetryContext, input: SpanStartedInput): RuntimeSpanStarted {
  return {
    ...envelope(context, input),
    kind: 'span_started',
    name: input.name,
    spanId: input.spanId ?? createTelemetryId('span'),
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
  };
}

export interface SpanEndedInput extends EnvelopeOverrides {
  name: RuntimeSpanName;
  spanId: string;
  parentSpanId?: string;
  status: TelemetrySpanStatus;
  durationMs?: number;
  error?: TelemetryError;
  attributes?: TelemetryAttributes;
}

export function createSpanEnded(context: TelemetryContext, input: SpanEndedInput): RuntimeSpanEnded {
  return {
    ...envelope(context, input),
    kind: 'span_ended',
    name: input.name,
    spanId: input.spanId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    status: input.status,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) requireString(value, path);
}

function validateAttributes(value: unknown, path: string): asserts value is TelemetryAttributes {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  for (const [key, attribute] of Object.entries(value)) {
    const attributePath = `${path}.${key}`;
    if (Array.isArray(attribute)) {
      for (const item of attribute) {
        if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
          throw new TypeError(`${attributePath} must contain only strings, numbers, or booleans`);
        }
        if (typeof item === 'number' && !Number.isFinite(item)) {
          throw new TypeError(`${attributePath} must contain only finite numbers`);
        }
      }
    } else if (typeof attribute !== 'string' && typeof attribute !== 'number' && typeof attribute !== 'boolean') {
      throw new TypeError(`${attributePath} must be a string, number, boolean, or array of those values`);
    } else if (typeof attribute === 'number' && !Number.isFinite(attribute)) {
      throw new TypeError(`${attributePath} must be finite`);
    }
  }
}

const runtimeEventNames = new Set<RuntimeEventName>([
  'run.status',
  'model.response',
  'tool.planned',
  'policy.decision',
  'budget.exceeded',
  'context.offloaded',
  'context.preflight_failed',
  'session.lineage',
  'runtime.error',
]);
const runtimeSpanNames = new Set<RuntimeSpanName>(['agent.run', 'model.request', 'tool.execute', 'context.compact']);
const telemetryLevels = new Set<TelemetryLevel>(['debug', 'info', 'warn', 'error']);
const telemetrySpanStatuses = new Set<TelemetrySpanStatus>([
  'ok',
  'error',
  'canceled',
  'incomplete',
  'budget_exceeded',
  'unknown',
]);

/** Runtime validation for records read from JSONL or accepted by an adapter. */
export function validateRuntimeTelemetryEvent(value: unknown): asserts value is RuntimeTelemetryEvent {
  if (!isRecord(value)) throw new TypeError('telemetry event must be an object');
  if (value['schemaVersion'] !== TELEMETRY_SCHEMA_VERSION) {
    throw new TypeError(`telemetry event schemaVersion must be ${TELEMETRY_SCHEMA_VERSION}`);
  }
  requireString(value['eventId'], 'telemetry event.eventId');
  requireString(value['timestamp'], 'telemetry event.timestamp');
  if (Number.isNaN(Date.parse(value['timestamp']))) throw new TypeError('telemetry event.timestamp must be an ISO timestamp');
  requireString(value['sessionId'], 'telemetry event.sessionId');
  requireString(value['runId'], 'telemetry event.runId');
  optionalString(value['parentRunId'], 'telemetry event.parentRunId');
  optionalString(value['requestId'], 'telemetry event.requestId');
  optionalString(value['toolCallId'], 'telemetry event.toolCallId');
  optionalString(value['toolExecutionId'], 'telemetry event.toolExecutionId');
  if (value['attributes'] !== undefined) validateAttributes(value['attributes'], 'telemetry event.attributes');

  switch (value['kind']) {
    case 'event':
      if (!runtimeEventNames.has(value['name'] as RuntimeEventName)) throw new TypeError('unsupported runtime event name');
      if (!telemetryLevels.has(value['level'] as TelemetryLevel)) throw new TypeError('unsupported telemetry level');
      return;
    case 'span_started':
      if (!runtimeSpanNames.has(value['name'] as RuntimeSpanName)) throw new TypeError('unsupported runtime span name');
      requireString(value['spanId'], 'telemetry span.spanId');
      optionalString(value['parentSpanId'], 'telemetry span.parentSpanId');
      return;
    case 'span_ended': {
      if (!runtimeSpanNames.has(value['name'] as RuntimeSpanName)) throw new TypeError('unsupported runtime span name');
      requireString(value['spanId'], 'telemetry span.spanId');
      optionalString(value['parentSpanId'], 'telemetry span.parentSpanId');
      if (!telemetrySpanStatuses.has(value['status'] as TelemetrySpanStatus)) {
        throw new TypeError('unsupported telemetry span status');
      }
      if (
        value['durationMs'] !== undefined &&
        (typeof value['durationMs'] !== 'number' || !Number.isFinite(value['durationMs']) || value['durationMs'] < 0)
      ) {
        throw new TypeError('telemetry span.durationMs must be a finite non-negative number');
      }
      if (value['error'] !== undefined) {
        if (!isRecord(value['error'])) throw new TypeError('telemetry span.error must be an object');
        requireString(value['error']['type'], 'telemetry span.error.type');
        requireString(value['error']['message'], 'telemetry span.error.message');
        optionalString(value['error']['stack'], 'telemetry span.error.stack');
      }
      return;
    }
    default:
      throw new TypeError('unsupported telemetry event kind');
  }
}

export function parseRuntimeTelemetryEvent(value: unknown): RuntimeTelemetryEvent {
  validateRuntimeTelemetryEvent(value);
  return value;
}

/** Minimal adapter boundary for JSONL, OpenTelemetry, or hosted exporters. */
export interface EventSink {
  emit(event: RuntimeTelemetryEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface Observer {
  /** Instrumentation is best-effort and must never change agent control flow. */
  emit(event: RuntimeTelemetryEvent): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type TelemetryRedactor = (event: RuntimeTelemetryEvent) => RuntimeTelemetryEvent | undefined;
export type SinkOperation = 'emit' | 'flush' | 'close';
export type SinkErrorHandler = (error: unknown, operation: SinkOperation, sink: EventSink) => void;

const defaultSensitiveKeys = new Set([
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'credential',
  'credentials',
  'password',
  'passwd',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'setcookie',
  'token',
  'accesstoken',
  'clientsecret',
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (defaultSensitiveKeys.has(normalized)) return true;
  return [
    'apikey',
    'apisecret',
    'authorization',
    'password',
    'passwd',
    'accesstoken',
    'refreshtoken',
    'sessiontoken',
    'clientsecret',
    'secretaccesskey',
    'privatekey',
    'cookie',
  ].some((suffix) => normalized.endsWith(suffix));
}

const credentialAssignmentPattern = new RegExp(
  String.raw`((?:authorization|proxy[\s._-]*authorization|api[\s._-]*key|access[\s._-]*token|refresh[\s._-]*token|session[\s._-]*token|private[\s._-]*(?:key|token)|client[\s._-]*secret|secret[\s._-]*(?:access[\s._-]*)?key|password|passwd|token|secret)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;&]+)`,
  'gi',
);

/** Preserve surrounding diagnostics while replacing common embedded credentials. */
function redactCredentialValues(value: string, replacement: string): string {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      `${replacement} PRIVATE KEY`,
    )
    .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, `$1${replacement}`)
    .replace(credentialAssignmentPattern, `$1${replacement}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${replacement}`)
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s/]+@/gi, `$1${replacement}@`)
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, replacement)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, replacement);
}

function redactValue(value: unknown, replacement: string, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return replacement;
  if (typeof value === 'string') return redactCredentialValues(value, replacement);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, replacement));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, replacement, childKey),
      ]),
    );
  }
  return value;
}

/**
 * Redacts credential-bearing keys and common embedded credential formats across
 * every string in the envelope, including error messages and stacks. SafeObserver
 * clones the event before applying this hook, so the caller's value is untouched.
 */
export function redactSensitiveData(replacement = '[REDACTED]'): TelemetryRedactor {
  return (event) => redactValue(event, replacement) as RuntimeTelemetryEvent;
}

/** @deprecated Use redactSensitiveData; retained as a source-compatible alias. */
export const redactSensitiveAttributes = redactSensitiveData;

function reportSinkError(handler: SinkErrorHandler | undefined, error: unknown, operation: SinkOperation, sink: EventSink) {
  try {
    handler?.(error, operation, sink);
  } catch {
    // Telemetry error reporting is telemetry too; it cannot affect agent behavior.
  }
}

export class SafeObserver implements Observer {
  readonly sink: EventSink;
  readonly redactors: readonly TelemetryRedactor[];
  readonly onError?: SinkErrorHandler;

  constructor(options: { sink?: EventSink; redactors?: readonly TelemetryRedactor[]; onError?: SinkErrorHandler } = {}) {
    this.sink = options.sink ?? new NoopEventSink();
    this.redactors = options.redactors ?? [redactSensitiveData()];
    this.onError = options.onError;
  }

  async emit(event: RuntimeTelemetryEvent): Promise<void> {
    try {
      let redacted: RuntimeTelemetryEvent | undefined = structuredClone(event);
      for (const redact of this.redactors) {
        if (!redacted) break;
        redacted = redact(redacted);
      }
      if (!redacted) return;
      validateRuntimeTelemetryEvent(redacted);
      await this.sink.emit(redacted);
    } catch (error) {
      reportSinkError(this.onError, error, 'emit', this.sink);
    }
  }

  async flush(): Promise<void> {
    try {
      await this.sink.flush?.();
    } catch (error) {
      reportSinkError(this.onError, error, 'flush', this.sink);
    }
  }

  async close(): Promise<void> {
    try {
      await this.sink.close?.();
    } catch (error) {
      reportSinkError(this.onError, error, 'close', this.sink);
    }
  }
}

export class NoopEventSink implements EventSink {
  emit(_event: RuntimeTelemetryEvent): void {}
}

/** Fan-out that attempts every sink even when another adapter fails. */
export class CompositeEventSink implements EventSink {
  readonly sinks: readonly EventSink[];
  readonly onError?: SinkErrorHandler;

  constructor(sinks: readonly EventSink[], onError?: SinkErrorHandler) {
    this.sinks = [...sinks];
    this.onError = onError;
  }

  async emit(event: RuntimeTelemetryEvent): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.emit(event);
      } catch (error) {
        reportSinkError(this.onError, error, 'emit', sink);
      }
    }
  }

  async flush(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.flush?.();
      } catch (error) {
        reportSinkError(this.onError, error, 'flush', sink);
      }
    }
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.close?.();
      } catch (error) {
        reportSinkError(this.onError, error, 'close', sink);
      }
    }
  }
}

/**
 * Owner-only append-only JSONL sink. Every row is fsync'd before emit returns;
 * the sink intentionally keeps no descriptor open so forked processes cannot
 * accidentally inherit it.
 */
export class JsonlEventSink implements EventSink {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  emit(event: RuntimeTelemetryEvent): void {
    validateRuntimeTelemetryEvent(event);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let created = false;
    let fd: number;
    try {
      fd = openSync(
        this.file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      created = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error;
      fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | noFollow);
    }
    try {
      if (!fstatSync(fd).isFile()) throw new TypeError(`telemetry sink is not a regular file: ${this.file}`);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) {
      // fsync the containing directory so the new file name survives a crash too.
      const directoryFd = openSync(dirname(this.file), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  }
}
