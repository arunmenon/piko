import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, type CompletionClient } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { Tool } from '../src/tools/types.js';
import type { AssistantMessage, CompletionRequest, Message, StreamEvent, Usage } from '@pi/ai';

const usage: Usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

function toolCallResponse(name: string, args: Record<string, unknown>, id: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] };
}

function lastText(request: CompletionRequest): string {
  return JSON.stringify(request.messages[request.messages.length - 1]?.content ?? []);
}

/** client driven by a decide() function so scripted behavior can react to the transcript */
function scriptedClient(decide: (request: CompletionRequest, call: number) => AssistantMessage): CompletionClient & {
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    // eslint-disable-next-line require-yield
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requests.push(request);
      const message = decide(request, requests.length);
      const stopReason = message.content.some((block) => block.type === 'toolCall') ? 'tool_use' : 'end_turn';
      yield { type: 'done', message, stopReason, usage };
    },
  };
}

const failingTool: Tool = {
  name: 'boom',
  description: 'always fails',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { content: [{ type: 'text', text: 'exploded' }], isError: true };
  },
};

test('flail guard: identical failing call nudges then stops the turn with a final report', async () => {
  let callId = 0;
  const client = scriptedClient((request) => {
    if (lastText(request).includes('Stopping this turn')) {
      return { role: 'assistant', content: [{ type: 'text', text: 'I could not fix it. Blocked on X.' }] };
    }
    return toolCallResponse('boom', { command: 'same thing' }, `c${++callId}`);
  });
  const agent = new Agent({
    client,
    model: 'fake',
    systemPrompt: 't',
    tools: [failingTool],
    cwd: '/tmp',
  });
  const events: string[] = [];
  for await (const event of agent.run('do the thing')) events.push(event.type);

  assert.ok(events.includes('flail_nudge'), `no nudge in ${events.join(',')}`);
  assert.ok(events.includes('flail_stop'), `no stop in ${events.join(',')}`);
  // identical call: nudge at 2nd failure, stop at 4th, +1 final report round = 5 requests
  assert.equal(client.requests.length, 5);
  const last = agent.messages[agent.messages.length - 1]!;
  assert.equal(last.role, 'assistant');
  assert.match(JSON.stringify(last.content), /Blocked on X/);
});

test('flail guard: consecutive varied failures respect configured thresholds', async () => {
  let callId = 0;
  const client = scriptedClient((request) => {
    if (lastText(request).includes('Stopping this turn')) {
      return { role: 'assistant', content: [{ type: 'text', text: 'final report' }] };
    }
    return toolCallResponse('boom', { attempt: ++callId }, `c${callId}`); // args vary: repeat detector stays quiet
  });
  const agent = new Agent({
    client,
    model: 'fake',
    systemPrompt: 't',
    tools: [failingTool],
    cwd: '/tmp',
    flailGuard: { nudgeAfter: 2, stopAfter: 3 },
  });
  const events: string[] = [];
  for await (const event of agent.run('go')) events.push(event.type);
  assert.ok(events.includes('flail_nudge'));
  assert.ok(events.includes('flail_stop'));
  assert.equal(client.requests.length, 4); // fail, fail->nudge, fail->stop, final report
});

test('flail guard: disabled means no interference', async () => {
  let calls = 0;
  const client = scriptedClient(() => {
    calls++;
    if (calls >= 6) return { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
    return toolCallResponse('boom', { command: 'same thing' }, `c${calls}`);
  });
  const agent = new Agent({
    client,
    model: 'fake',
    systemPrompt: 't',
    tools: [failingTool],
    cwd: '/tmp',
    flailGuard: false,
  });
  const events: string[] = [];
  for await (const event of agent.run('go')) events.push(event.type);
  assert.ok(!events.includes('flail_nudge'));
  assert.ok(!events.includes('flail_stop'));
});

test('offload: old bulky tool results move to disk with a re-readable stub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-offload-'));
  const session = Session.create('/some/project', 'fake', dir);
  const client = scriptedClient(() => ({ role: 'assistant', content: [{ type: 'text', text: 'noted' }] }));
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [], cwd: '/tmp', session });

  const bigText = 'x'.repeat(10_000);
  const seed: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'big' } }] },
    { role: 'user', content: [{ type: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: bigText }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'saw it' }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'user', content: [{ type: 'text', text: 'c' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
    { role: 'user', content: [{ type: 'text', text: 'e' }] },
  ];
  agent.messages.push(...seed);

  const events: string[] = [];
  for await (const event of agent.run('next')) events.push(event.type);
  assert.ok(events.includes('offloaded'), `no offload in ${events.join(',')}`);

  const stubBlock = (agent.messages[2] as { content: { type: string; content?: { type: string; text?: string }[] }[] })
    .content[0] as { content: { type: string; text: string }[] };
  const stubText = stubBlock.content[0]!.text;
  assert.match(stubText, /^\[offloaded: 10,?000-char bash output saved to /);
  const path = stubText.match(/saved to (\S+);/)?.[1];
  assert.ok(path && existsSync(path), 'offload file should exist');
  assert.equal(readFileSync(path!, 'utf8'), bigText);
});

test('steering: mid-turn notes are injected before the next model call', async () => {
  const steerNotes = [['switch to plan B'], []];
  let callId = 0;
  const client = scriptedClient((request, call) => {
    if (call === 1) return toolCallResponse('echo', {}, `c${++callId}`);
    return { role: 'assistant', content: [{ type: 'text', text: 'followed plan B' }] };
  });
  const succeedTool: Tool = {
    name: 'echo',
    description: 's',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [succeedTool], cwd: '/tmp' });
  const events: string[] = [];
  for await (const event of agent.run('go', undefined, () => steerNotes.shift() ?? [])) events.push(event.type);
  assert.ok(events.includes('steered'), `no steered in ${events.join(',')}`);
  const secondRequest = client.requests[1]!;
  assert.match(JSON.stringify(secondRequest.messages), /\[steering\] switch to plan B/);
});
