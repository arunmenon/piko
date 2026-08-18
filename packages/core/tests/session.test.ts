import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { synthesizeInterruptedResults } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { Message, Usage } from '@pi/ai';

const dir = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
const usage: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 };

function message(role: 'user' | 'assistant', text: string): Message {
  return role === 'user'
    ? { role, content: [{ type: 'text', text }] }
    : { role, content: [{ type: 'text', text }] };
}

test('session create/append/open roundtrip with usage totals', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: message('user', 'hi') });
  session.append({ t: 'msg', message: message('assistant', 'hello') });
  session.append({ t: 'usage', usage });
  session.append({ t: 'usage', usage });

  const reopened = Session.open(session.file);
  assert.equal(reopened.id, session.id);
  assert.equal(reopened.messages.length, 2);
  assert.equal(reopened.meta?.model, 'test-model');
  assert.deepEqual(reopened.usage, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2 });
});

test('open skips a corrupt partial trailing line instead of refusing the session', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: message('user', 'hi') });
  appendFileSync(session.file, '{"t":"msg","message":{"role":"assist', 'utf8');
  const reopened = Session.open(session.file);
  assert.equal(reopened.messages.length, 1);
});

test('synthesizeInterruptedResults repairs a transcript ending in unmatched tool calls', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }] },
  ];
  const repair = synthesizeInterruptedResults(messages);
  assert.ok(repair);
  assert.equal(repair.role, 'user');
  const block = repair.content[0] as { type: string; toolCallId: string; isError?: boolean };
  assert.equal(block.type, 'toolResult');
  assert.equal(block.toolCallId, 'tc1');
  assert.equal(block.isError, true);
  // a well-formed transcript needs no repair
  assert.equal(synthesizeInterruptedResults([messages[0]!]), undefined);
});

test('branch copies messages up to the given index into a sibling file', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: message('user', 'one') });
  session.append({ t: 'msg', message: message('assistant', 'two') });
  session.append({ t: 'msg', message: message('user', 'three') });

  const branched = session.branch(1, '/some/project', 'test-model');
  assert.equal(branched.messages.length, 2);
  assert.notEqual(branched.file, session.file);
  assert.equal(join(branched.file, '..'), join(session.file, '..'));
  const reopened = Session.open(branched.file);
  assert.equal(reopened.messages.length, 2);
});
