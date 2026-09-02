import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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

const readingTool: Tool = {
  name: 'read',
  description: 'always succeeds',
  parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } },
  async execute(args: Record<string, unknown>) {
    return { content: [{ type: 'text', text: `contents of ${String(args['path'])}` }] };
  },
};

function finalReportOn(request: CompletionRequest): AssistantMessage | undefined {
  return lastText(request).includes('Stopping this turn')
    ? { role: 'assistant', content: [{ type: 'text', text: 'final report' }] }
    : undefined;
}

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

test('flail guard stops the remainder of one large failing tool batch before dispatch', async () => {
  let executions = 0;
  const batchTool: Tool = {
    ...failingTool,
    async execute() {
      executions++;
      return { content: [{ type: 'text', text: 'exploded' }], isError: true };
    },
  };
  const client = scriptedClient((request, call) => {
    if (call > 1 || lastText(request).includes('Stopping this turn')) {
      return { role: 'assistant', content: [{ type: 'text', text: 'final report' }] };
    }
    return {
      role: 'assistant',
      content: Array.from({ length: 20 }, (_, index) => ({
        type: 'toolCall' as const,
        id: `batch-${index}`,
        name: 'boom',
        arguments: { command: 'same thing' },
      })),
    };
  });
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [batchTool], cwd: '/tmp' });
  const events: string[] = [];
  for await (const event of agent.run('go')) events.push(event.type);
  assert.equal(executions, 4, 'repeatStopAfter must apply inside one provider batch');
  assert.ok(events.includes('flail_stop'));
  const results = agent.messages.find(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'toolResult'),
  );
  assert.ok(results?.role === 'user');
  assert.equal(results.content.filter((block) => block.type === 'toolResult').length, 20);
  assert.match(JSON.stringify(results.content), /remaining tool batch/);
});

test('flail guard: eleven identical successful reads nudge then stop the turn', async () => {
  let toolCalls = 0;
  const client = scriptedClient((request) => {
    const report = finalReportOn(request);
    if (report) return report;
    if (toolCalls >= 11) return { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
    return toolCallResponse('read', { path: 'src/agent.ts' }, `c${++toolCalls}`);
  });
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [readingTool], cwd: '/tmp' });
  const events: string[] = [];
  for await (const event of agent.run('read the file')) events.push(event.type);

  assert.ok(events.includes('flail_nudge'), `no nudge in ${events.join(',')}`);
  assert.ok(events.includes('flail_stop'), `no stop in ${events.join(',')}`);
  // relaxed successful-repeat thresholds: nudge on the 4th identical success,
  // stop on the 8th, then one final-report round
  assert.equal(client.requests.length, 9);
  assert.equal(toolCalls, 8, 'the guard must stop the loop well before the eleventh read');
  const transcript = JSON.stringify(agent.messages);
  assert.match(transcript, /succeeding but repeating/);
  assert.match(transcript, /Stopping this turn: the same tool call keeps succeeding and repeating/);
  assert.doesNotMatch(transcript, /Several tool calls in a row have failed/);
});

test('flail guard: argument key order cannot hide an identical successful repeat', async () => {
  let toolCalls = 0;
  const client = scriptedClient((request) => {
    const report = finalReportOn(request);
    if (report) return report;
    toolCalls++;
    // same call, two key orders: the canonical signature must collapse them
    const args = toolCalls % 2 === 1 ? { path: 'a.ts', limit: 10 } : { limit: 10, path: 'a.ts' };
    return toolCallResponse('read', args, `c${toolCalls}`);
  });
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [readingTool], cwd: '/tmp' });
  const events: string[] = [];
  for await (const event of agent.run('read the file')) events.push(event.type);
  assert.ok(events.includes('flail_stop'), `no stop in ${events.join(',')}`);
  assert.equal(toolCalls, 8);
});

test('flail guard: an alternating pair of identical calls is detected', async () => {
  let toolCalls = 0;
  const client = scriptedClient((request) => {
    const report = finalReportOn(request);
    if (report) return report;
    toolCalls++;
    return toolCallResponse('read', { path: toolCalls % 2 === 1 ? 'a.ts' : 'b.ts' }, `c${toolCalls}`);
  });
  const agent = new Agent({
    client,
    model: 'fake',
    systemPrompt: 't',
    tools: [readingTool],
    cwd: '/tmp',
    // the identical-success counters are pushed out of the way so the assertion
    // is about the alternating detector and nothing else
    flailGuard: { successNudgeAfter: 50, successStopAfter: 60, alternatingNudgeAfter: 3, alternatingStopAfter: 4 },
  });
  const events: string[] = [];
  for await (const event of agent.run('look around')) events.push(event.type);

  assert.ok(events.includes('flail_nudge'), `no nudge in ${events.join(',')}`);
  assert.ok(events.includes('flail_stop'), `no stop in ${events.join(',')}`);
  assert.equal(toolCalls, 8, 'four A,B cycles is eight calls');
  const transcript = JSON.stringify(agent.messages);
  assert.match(transcript, /alternating between the same two tool calls/);
  assert.match(transcript, /Stopping this turn: the same two tool calls keep alternating/);
});

test('flail guard: a genuinely new call resets the successful-repeat counters', async () => {
  // three identical reads, one different read, three identical reads again:
  // six calls to the same file, but never four in a row without new work
  const paths = ['a.ts', 'a.ts', 'a.ts', 'b.ts', 'a.ts', 'a.ts', 'a.ts'];
  let toolCalls = 0;
  const client = scriptedClient((request) => {
    const report = finalReportOn(request);
    if (report) return report;
    const path = paths[toolCalls];
    if (path === undefined) return { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
    toolCalls++;
    return toolCallResponse('read', { path }, `c${toolCalls}`);
  });
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [readingTool], cwd: '/tmp' });
  const events: string[] = [];
  for await (const event of agent.run('read some files')) events.push(event.type);

  assert.equal(toolCalls, paths.length);
  assert.ok(!events.includes('flail_nudge'), `unexpected nudge in ${events.join(',')}`);
  assert.ok(!events.includes('flail_stop'), `unexpected stop in ${events.join(',')}`);
});

test('flail guard: failure thresholds and wording are unchanged by success tracking', async () => {
  let toolCalls = 0;
  const client = scriptedClient((request) => {
    const report = finalReportOn(request);
    if (report) return report;
    return toolCallResponse('boom', { attempt: ++toolCalls }, `c${toolCalls}`); // args vary: identical-call detectors stay quiet
  });
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [failingTool], cwd: '/tmp' });
  const events: string[] = [];
  for await (const event of agent.run('go')) events.push(event.type);

  assert.ok(events.includes('flail_nudge'));
  assert.ok(events.includes('flail_stop'));
  // defaults are untouched: nudge on the 5th consecutive failure, stop on the 10th
  assert.equal(toolCalls, 10);
  assert.equal(client.requests.length, 11);
  const transcript = JSON.stringify(agent.messages);
  assert.match(transcript, /Several tool calls in a row have failed/);
  assert.match(transcript, /Stopping this turn: repeated tool failures with no progress/);
  assert.doesNotMatch(transcript, /succeeding but repeating/);
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
  const agent = new Agent({ client, model: 'fake', systemPrompt: 't', tools: [], cwd: dir, session });

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
  assert.ok(path && !isAbsolute(path), 'offload reference should be workspace-relative');
  assert.ok(existsSync(join(dir, path!)), 'offload file should exist inside the workspace');
  assert.equal(readFileSync(join(dir, path!), 'utf8'), bigText);
  assert.equal(readFileSync(join(dir, path!, '..', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
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
