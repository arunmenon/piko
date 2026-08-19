import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient, type RunBudget } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { Observer, RuntimeTelemetryEvent } from '../src/telemetry.js';
import type { Tool } from '../src/tools/types.js';

const smallUsage: Usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function clientFor(message: AssistantMessage, stopReason: 'end_turn' | 'tool_use' | 'max_tokens', usage = smallUsage): CompletionClient {
  return {
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', message, stopReason, usage };
    },
  };
}

async function drain(agent: Agent, input = 'go'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(input)) events.push(event);
  return events;
}

test('max_tokens is incomplete and truncated tool calls never execute', async () => {
  let executed = 0;
  const tool: Tool = {
    name: 'danger',
    description: 'side effect',
    parameters: { type: 'object' },
    async execute() {
      executed++;
      return { content: [{ type: 'text', text: 'ran' }] };
    },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'danger', arguments: {} }],
  };
  const agent = new Agent({ client: clientFor(message, 'max_tokens'), model: 'm', systemPrompt: 's', tools: [tool], cwd: '/tmp' });
  const events = await drain(agent);
  assert.equal(executed, 0);
  const terminal = events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(terminal.status, 'incomplete');
  assert.equal(terminal.reason, 'max_tokens');
  assert.match(JSON.stringify(agent.messages.at(-1)), /not run/);
});

test('tool-call budget is enforced before each call in a single model response', async () => {
  let executed = 0;
  const tool: Tool = {
    name: 'write-ish',
    description: 'count executions',
    parameters: { type: 'object' },
    async execute() {
      executed++;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: Array.from({ length: 5 }, (_, index) => ({
      type: 'toolCall' as const,
      id: `c${index}`,
      name: tool.name,
      arguments: {},
    })),
  };
  const agent = new Agent({
    client: clientFor(message, 'tool_use'),
    model: 'm',
    systemPrompt: 's',
    tools: [tool],
    cwd: '/tmp',
    budget: { maxToolCalls: 2 },
  });
  const events = await drain(agent);
  assert.equal(executed, 2);
  const terminal = events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'tool_calls');
  assert.equal(terminal.toolCalls, 2);
  const resultMessage = agent.messages.at(-1)!;
  assert.equal(resultMessage.role, 'user');
  assert.equal(resultMessage.content.filter((block) => block.type === 'toolResult').length, 5);
});

test('provider-reported token budget prevents following tool side effects', async () => {
  let executed = 0;
  const tool: Tool = {
    name: 'danger',
    description: 'side effect',
    parameters: { type: 'object' },
    async execute() {
      executed++;
      return { content: [{ type: 'text', text: 'ran' }] };
    },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'danger', arguments: {} }],
  };
  const agent = new Agent({
    client: clientFor(message, 'tool_use', { ...smallUsage, inputTokens: 100 }),
    model: 'm',
    systemPrompt: 's',
    tools: [tool],
    cwd: '/tmp',
    budget: { maxInputTokens: 100 },
  });
  const events = await drain(agent);
  assert.equal(executed, 0);
  const terminal = events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'input_tokens');
});

test('a final response that overshoots a provider token ceiling is not reported as completed', async () => {
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
  const agent = new Agent({
    client: clientFor(message, 'end_turn', { ...smallUsage, inputTokens: 101 }),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    budget: { maxInputTokens: 100 },
  });
  const terminal = (await drain(agent)).at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'input_tokens');
});

test('wall-time budget aborts a cooperative tool and reports budget exhaustion', async () => {
  const tool: Tool = {
    name: 'wait',
    description: 'wait for cancellation',
    parameters: { type: 'object' },
    execute(_args, context) {
      return new Promise((resolve) => {
        context.signal?.addEventListener(
          'abort',
          () => resolve({ content: [{ type: 'text', text: 'aborted' }], isError: true }),
          { once: true },
        );
      });
    },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'wait', arguments: {} }],
  };
  const agent = new Agent({
    client: clientFor(message, 'tool_use'),
    model: 'm',
    systemPrompt: 's',
    tools: [tool],
    cwd: '/tmp',
    budget: { maxWallTimeMs: 20 },
  });
  const events = await drain(agent);
  const terminal = events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'wall_time');
});

test('wall-time budget returns even when an extension ignores cancellation', async () => {
  const tool: Tool = {
    name: 'ignore-abort',
    description: 'never settles',
    parameters: { type: 'object' },
    execute() {
      return new Promise(() => {});
    },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: tool.name, arguments: {} }],
  };
  const agent = new Agent({
    client: clientFor(message, 'tool_use'),
    model: 'm',
    systemPrompt: 's',
    tools: [tool],
    cwd: '/tmp',
    budget: { maxWallTimeMs: 20 },
  });
  const terminal = await Promise.race([
    drain(agent).then((events) => events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('agent remained hung')), 250)),
  ]);
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'wall_time');
});

test('wall-time budget returns when a custom completion stream ignores cancellation', async () => {
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      await new Promise(() => {});
      yield undefined as never;
    },
  };
  const agent = new Agent({
    client,
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    budget: { maxWallTimeMs: 20 },
  });
  const terminal = await Promise.race([
    drain(agent).then((events) => events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('stream remained hung')), 250)),
  ]);
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'wall_time');
});

test('a hostile observer cannot hold a run open past its wall deadline', async () => {
  const observer: Observer = {
    emit(_event: RuntimeTelemetryEvent) {
      return new Promise(() => {});
    },
    flush() {
      return new Promise(() => {});
    },
    async close() {},
  };
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
  const agent = new Agent({
    client: clientFor(message, 'end_turn'),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    observer,
    budget: { maxWallTimeMs: 20 },
  });
  const terminal = await Promise.race([
    drain(agent).then((events) => events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('observer remained hung')), 250)),
  ]);
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'wall_time');
});

test('tool output is bounded before it enters conversation context', async () => {
  const tool: Tool = {
    name: 'huge',
    description: 'return a huge extension result',
    parameters: { type: 'object' },
    async execute() {
      return { content: [{ type: 'text', text: 'x'.repeat(100_000) }] };
    },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'huge', arguments: {} }],
  };
  const agent = new Agent({
    client: clientFor(message, 'tool_use'),
    model: 'm',
    systemPrompt: 's',
    tools: [tool],
    cwd: '/tmp',
    maxIterations: 1,
    budget: { maxToolOutputBytes: 256 },
  });
  await drain(agent);
  const resultMessage = agent.messages.at(-1)!;
  assert.equal(resultMessage.role, 'user');
  const resultBlock = resultMessage.content.find((block) => block.type === 'toolResult');
  assert.ok(resultBlock?.type === 'toolResult');
  const retainedBytes = Buffer.byteLength(JSON.stringify(resultBlock.content));
  assert.ok(retainedBytes <= 256, `bounded result was still ${retainedBytes} serialized bytes`);
  const result = JSON.stringify(resultMessage);
  assert.match(result, /tool output capped/);
});

test('run budgets reject fractional counts, timer overflow, and unusably small tool caps', async () => {
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
  for (const budget of [
    { maxToolCalls: 1.5 },
    { maxWallTimeMs: 2_147_483_648 },
    { maxToolOutputBytes: 1 },
  ]) {
    const agent = new Agent({ client: clientFor(message, 'end_turn'), model: 'm', systemPrompt: 's', tools: [], cwd: '/tmp', budget });
    await assert.rejects(async () => drain(agent), /invalid run budget/);
  }
});

test('undefined partial-budget fields cannot erase mandatory defaults', async () => {
  let requests = 0;
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      requests++;
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: `call-${requests}`, name: 'noop', arguments: {} }],
      };
      yield { type: 'done', message, stopReason: 'tool_use', usage: smallUsage };
    },
  };
  const tool: Tool = {
    name: 'noop',
    description: 'no-op',
    parameters: { type: 'object', additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const agent = new Agent({
    client,
    model: 'm',
    systemPrompt: 's',
    tools: [tool],
    cwd: '/tmp',
    maxIterations: 2,
    budget: { maxModelRequests: undefined } as Partial<RunBudget>,
  });
  const terminal = (await drain(agent)).at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(requests, 2);
  assert.equal(terminal.status, 'budget_exceeded');
  assert.equal(terminal.reason, 'model_requests');
});

test('known context windows impose a per-request output cap and disable oversized thinking', async () => {
  let captured: CompletionRequest | undefined;
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
  const client: CompletionClient = {
    async *stream(request): AsyncGenerator<StreamEvent, void, void> {
      captured = request;
      yield { type: 'done', message, stopReason: 'end_turn', usage: smallUsage };
    },
  };
  const agent = new Agent({
    client,
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    contextWindow: 4_096,
    thinkingBudget: 8_000,
  });
  await drain(agent, 'x'.repeat(8_000));
  assert.ok(captured);
  assert.equal(captured.maxAttempts, 1);
  assert.ok((captured.maxTokens ?? Number.POSITIVE_INFINITY) < 4_096);
  assert.equal(captured.thinkingBudget, undefined);
});

test('the documented 8192 thinking budget is enabled when context headroom permits', async () => {
  let captured: CompletionRequest | undefined;
  const client: CompletionClient = {
    async *stream(request): AsyncGenerator<StreamEvent, void, void> {
      captured = request;
      yield {
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        stopReason: 'end_turn',
        usage: smallUsage,
      };
    },
  };
  const agent = new Agent({
    client,
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    contextWindow: 128_000,
    thinkingBudget: 8_192,
  });
  await drain(agent);
  assert.equal(captured?.thinkingBudget, 8_192);
  assert.ok((captured?.maxTokens ?? 0) > 8_192);
});

test('thinking-only end_turn and tool_use-without-calls are not successful answers', async () => {
  const thinkingOnly: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'internal', signature: 'signed' }],
  };
  const thinkingTerminal = (
    await drain(new Agent({ client: clientFor(thinkingOnly, 'end_turn'), model: 'm', systemPrompt: 's', tools: [], cwd: '/tmp' }))
  ).at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(thinkingTerminal.status, 'incomplete');
  assert.equal(thinkingTerminal.reason, 'empty_response');

  const textWithoutCall: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'no call' }] };
  const client: CompletionClient = {
    async *stream(): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', message: textWithoutCall, stopReason: 'tool_use', usage: smallUsage };
    },
  };
  const toolUseTerminal = (
    await drain(new Agent({ client, model: 'm', systemPrompt: 's', tools: [], cwd: '/tmp' }))
  ).at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(toolUseTerminal.status, 'incomplete');
  assert.equal(toolUseTerminal.reason, 'provider_stop');
});

test('a terminal journal failure downgrades an otherwise completed run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-terminal-persist-'));
  const session = Session.create('/project', 'm', dir);
  const original = session.setRunStatus.bind(session);
  session.setRunStatus = (status, reason) => {
    if (status === 'completed') throw new Error('injected terminal fsync failure');
    original(status, reason);
  };
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
  const agent = new Agent({
    client: clientFor(message, 'end_turn'),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/project',
    session,
  });
  const terminal = (await drain(agent)).at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
  assert.equal(terminal.status, 'incomplete');
  assert.equal(terminal.reason, 'persistence');
});
