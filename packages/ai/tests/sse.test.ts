import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SSEParser } from '../src/sse.js';

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
