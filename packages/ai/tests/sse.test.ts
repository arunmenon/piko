import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SSELimitError, SSEParser, createRequestSignalScope, sseEvents } from '../src/sse.js';

test('request deadlines reject fractional and overflowing timers', () => {
  assert.throws(() => createRequestSignalScope(undefined, 1.5), /timer-safe integer/);
  assert.throws(() => createRequestSignalScope(undefined, 2_147_483_648), /timer-safe integer/);
});

test('parses events split across chunks', () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.push('event: message_start\nda'), []);
  const events = parser.push('ta: {"a":1}\n\n');
  assert.deepEqual(events, [{ event: 'message_start', data: '{"a":1}' }]);
});

test('handles CRLF and multiple events per chunk', () => {
  const parser = new SSEParser();
  const events = parser.push('data: one\r\n\r\ndata: two\n\n');
  assert.deepEqual(events, [
    { event: undefined, data: 'one' },
    { event: undefined, data: 'two' },
  ]);
});

test('flush recovers a final unterminated event', () => {
  const parser = new SSEParser();
  assert.deepEqual(parser.push('data: tail\n'), []);
  assert.deepEqual(parser.flush(), [{ event: undefined, data: 'tail' }]);
  assert.deepEqual(parser.flush(), []);
});

test('joins multi-line data and ignores comments', () => {
  const parser = new SSEParser();
  const events = parser.push(': keepalive\ndata: line1\ndata: line2\n\n');
  assert.deepEqual(events, [{ event: undefined, data: 'line1\nline2' }]);
});

test('parser bounds its pending buffer and accumulated event data', () => {
  assert.throws(
    () =>
      new SSEParser({ maxBufferChars: 8, maxEventDataChars: 8, maxEvents: 10 }).push('123456789'),
    SSELimitError,
  );

  const parser = new SSEParser({ maxBufferChars: 100, maxEventDataChars: 5, maxEvents: 10 });
  assert.throws(() => parser.push('data: abc\ndata: def\n'), SSELimitError);
});

test('stream bounds the number of provider events', async () => {
  const body = new Response('data: one\n\ndata: two\n\ndata: three\n\n').body!;
  await assert.rejects(
    (async () => {
      for await (const _event of sseEvents(body, undefined, {
        maxBufferChars: 100,
        maxEventDataChars: 20,
        maxEvents: 2,
      })) {
        // consume
      }
    })(),
    SSELimitError,
  );
});

test('stream reports raw response activity once before buffered event delivery', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: one\n\n'));
      controller.enqueue(encoder.encode('data: two\n\n'));
      controller.close();
    },
  });
  const order: string[] = [];
  for await (const event of sseEvents(body, undefined, undefined, () => order.push('bytes'))) {
    order.push(event.data);
  }
  assert.deepEqual(order, ['bytes', 'one', 'two']);
});
