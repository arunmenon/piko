import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, chooseKeepBoundary, type CompletionClient } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { AssistantMessage, CompletionRequest, Message, StreamEvent, Usage } from '@pi/ai';

function usage(input: number, output = 10): Usage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as Message;
}

test('chooseKeepBoundary picks a user message without tool results', () => {
  const messages: Message[] = [
    textMessage('user', 'a'.repeat(200_000)), // huge old turn
    textMessage('assistant', 'done'),
    textMessage('user', 'small follow-up'),
    { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }] },
    { role: 'user', content: [{ type: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] }] },
    textMessage('assistant', 'finished'),
  ];
  const boundary = chooseKeepBoundary(messages, 20_000);
  // index 2 is the earliest clean boundary whose tail fits; index 4 (tool results) must never be chosen
  assert.equal(boundary, 2);
});

test('chooseKeepBoundary falls back to the latest boundary for an oversized turn', () => {
  const messages: Message[] = [
    textMessage('user', 'old'),
    textMessage('assistant', 'old answer'),
    textMessage('user', 'x'.repeat(500_000)), // current turn alone exceeds the budget
  ];
  assert.equal(chooseKeepBoundary(messages, 20_000), 2);
});

test('agent auto-compacts when real usage crosses the threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-compact-'));
  const session = Session.create('/some/project', 'fake-model', dir);

  // scripted responses: turn 1 (reports huge context use), then the summarize call,
  // then turn 2's normal answer
  const responses: { text: string; usage: Usage }[] = [
    { text: 'first answer', usage: usage(90_000) },
    { text: 'SUMMARY-OF-EARLIER-WORK', usage: usage(100) },
    { text: 'second answer', usage: usage(500) },
  ];
  const requests: CompletionRequest[] = [];
  const fakeClient: CompletionClient = {
    // eslint-disable-next-line require-yield
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requests.push(request);
      const scripted = responses.shift();
      if (!scripted) throw new Error('no scripted response left');
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: scripted.text }] };
      yield { type: 'text_delta', text: scripted.text };
      yield { type: 'done', message, stopReason: 'end_turn', usage: scripted.usage };
    },
  };

  const agent = new Agent({
    client: fakeClient,
    model: 'fake-model',
    systemPrompt: 'test',
    tools: [],
    cwd: '/some/project',
    session,
    contextWindow: 100_000, // threshold = 100k - 16384; turn 1's 90k+10 crosses it
  });

  // a genuinely large first turn, so the keep-boundary lands after it
  for await (const _event of agent.run(`first input\n${'x'.repeat(120_000)}`)) {
    /* drain */
  }
  const events: string[] = [];
  for await (const event of agent.run('second input')) events.push(event.type);

  assert.ok(events.includes('compacted'), `expected a compacted event, got ${events.join(',')}`);
  // history was rewritten: summary message first, then the kept tail
  const first = agent.messages[0]!;
  assert.equal(first.role, 'user');
  assert.match((first.content[0] as { text: string }).text, /auto-compacted[\s\S]*SUMMARY-OF-EARLIER-WORK/);
  // the summarize call saw the full pre-compaction history
  assert.ok(requests[1]!.messages.length > requests[2]!.messages.length);
  // the compacted state lives in a NEW session file; the original is untouched on disk
  assert.ok(agent.session);
  assert.notEqual(agent.session.file, session.file);
  const original = Session.open(session.file);
  assert.equal(original.messages[0]!.role, 'user');
  const compacted = Session.open(agent.session.file);
  assert.match((compacted.messages[0]!.content[0] as { text: string }).text, /SUMMARY-OF-EARLIER-WORK/);
  // turn 2 was answered normally after compaction
  assert.equal(events.filter((type) => type === 'response_done').length, 1);
});
