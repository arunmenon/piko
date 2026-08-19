import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CompositeEventSink,
  JsonlEventSink,
  SafeObserver,
  TELEMETRY_SCHEMA_VERSION,
  createRuntimeEvent,
  createSpanEnded,
  createSpanStarted,
  createTelemetryContext,
  parseRuntimeTelemetryEvent,
  type EventSink,
  type RuntimeTelemetryEvent,
} from '../src/telemetry.js';

const timestamp = '2026-08-19T00:00:00.000Z';

test('builders produce a versioned schema with stable correlation identifiers', () => {
  const context = {
    ...createTelemetryContext('session-stable', { runId: 'run-stable' }),
    requestId: 'request-stable',
    toolCallId: 'provider-call-stable',
    toolExecutionId: 'tool-stable',
  };
  const started = createSpanStarted(context, {
    eventId: 'event-start',
    timestamp,
    name: 'tool.execute',
    spanId: 'span-stable',
  });
  const ended = createSpanEnded(context, {
    eventId: 'event-end',
    timestamp,
    name: 'tool.execute',
    spanId: started.spanId,
    status: 'ok',
    durationMs: 12,
  });

  assert.equal(started.schemaVersion, TELEMETRY_SCHEMA_VERSION);
  assert.equal(ended.schemaVersion, TELEMETRY_SCHEMA_VERSION);
  assert.equal(started.sessionId, ended.sessionId);
  assert.equal(started.runId, ended.runId);
  assert.equal(started.requestId, ended.requestId);
  assert.equal(started.toolCallId, ended.toolCallId);
  assert.equal(started.toolExecutionId, ended.toolExecutionId);
  assert.equal(started.spanId, ended.spanId);
  assert.equal(parseRuntimeTelemetryEvent(JSON.parse(JSON.stringify(ended))).status, 'ok');
});

test('runtime parser rejects unsupported versions and malformed span fields', () => {
  const event = createRuntimeEvent({ sessionId: 's', runId: 'r' }, { name: 'run.status', timestamp });
  assert.throws(() => parseRuntimeTelemetryEvent({ ...event, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(
    () => parseRuntimeTelemetryEvent({ ...event, kind: 'span_ended', name: 'agent.run', spanId: 'span', status: 'ok', durationMs: -1 }),
    /durationMs/,
  );
});

test('SafeObserver redacts sensitive attributes and embedded credentials without losing diagnostics', async () => {
  const received: RuntimeTelemetryEvent[] = [];
  const sink: EventSink = { emit: (event) => received.push(event) };
  const observer = new SafeObserver({ sink });
  const event = createSpanEnded(
    { sessionId: 's', runId: 'r' },
    {
      name: 'model.request',
      spanId: 'span',
      status: 'error',
      timestamp,
      attributes: {
        apiKey: 'secret-value',
        inputTokens: 42,
        authorization: 'Bearer TOP_SECRET',
        OPENAI_API_KEY: 'TOP_SECRET',
        detail: 'request used authorization: Bearer TOP_SECRET',
      },
      error: {
        type: 'ProviderError',
        message: 'Request failed with status 401; authorization: Bearer TOP_SECRET',
        stack: 'ProviderError: OPENAI_API_KEY=TOP_SECRET\n    at request (client.ts:12:3)',
      },
    },
  );

  await observer.emit(event);

  const emitted = received[0];
  assert.equal(emitted?.kind, 'span_ended');
  if (emitted?.kind !== 'span_ended') assert.fail('expected a span-ended event');
  assert.deepEqual(emitted.attributes, {
    apiKey: '[REDACTED]',
    inputTokens: 42,
    authorization: '[REDACTED]',
    OPENAI_API_KEY: '[REDACTED]',
    detail: 'request used authorization: [REDACTED]',
  });
  assert.match(emitted.error?.message ?? '', /Request failed with status 401/);
  assert.match(emitted.error?.stack ?? '', /at request \(client\.ts:12:3\)/);
  assert.match(emitted.error?.message ?? '', /\[REDACTED\]/);
  assert.match(emitted.error?.stack ?? '', /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(emitted), /TOP_SECRET/);
  assert.equal(event.attributes?.['apiKey'], 'secret-value');
  assert.match(event.error?.message ?? '', /TOP_SECRET/);
});

test('custom redactors can transform or suppress events', async () => {
  const received: RuntimeTelemetryEvent[] = [];
  const observer = new SafeObserver({
    sink: { emit: (event) => received.push(event) },
    redactors: [(event) => (event.level === 'debug' ? undefined : { ...event, attributes: { retained: true } })],
  });
  await observer.emit(createRuntimeEvent({ sessionId: 's', runId: 'r' }, { name: 'run.status', level: 'debug', timestamp }));
  await observer.emit(createRuntimeEvent({ sessionId: 's', runId: 'r' }, { name: 'run.status', timestamp }));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]?.attributes, { retained: true });
});

test('JsonlEventSink appends valid events durably with owner-only permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-telemetry-'));
  const file = join(dir, 'audit.jsonl');
  // Exercise normalization of an existing file created with permissive mode.
  writeFileSync(file, '', { flag: 'w', mode: 0o644 });
  const sink = new JsonlEventSink(file);
  const first = createRuntimeEvent({ sessionId: 's', runId: 'r' }, { name: 'run.status', timestamp });
  const second = createRuntimeEvent({ sessionId: 's', runId: 'r' }, { name: 'budget.exceeded', timestamp });
  sink.emit(first);
  sink.emit(second);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => parseRuntimeTelemetryEvent(JSON.parse(line)));
  assert.deepEqual(rows.map((row) => row.name), ['run.status', 'budget.exceeded']);
});

test('CompositeEventSink and SafeObserver isolate exporter errors', async () => {
  const received: RuntimeTelemetryEvent[] = [];
  const failures: string[] = [];
  const broken: EventSink = {
    emit() {
      throw new Error('exporter unavailable');
    },
    flush() {
      throw new Error('flush unavailable');
    },
  };
  const composite = new CompositeEventSink(
    [broken, { emit: (event) => received.push(event) }],
    (error, operation) => failures.push(`${operation}:${String(error)}`),
  );
  const observer = new SafeObserver({ sink: composite });
  const event = createRuntimeEvent({ sessionId: 's', runId: 'r' }, { name: 'runtime.error', timestamp });

  await assert.doesNotReject(observer.emit(event));
  await assert.doesNotReject(observer.flush());
  assert.equal(received.length, 1);
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /emit:Error: exporter unavailable/);
  assert.match(failures[1]!, /flush:Error: flush unavailable/);
});
