import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient } from '../src/agent.js';
import { Session } from '../src/session.js';
import type { Tool } from '../src/tools/types.js';

const usage: Usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

test('invalid tool arguments are durably skipped before tool_started or dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-argument-dispatch-'));
  const session = Session.create(directory, 'model', directory);
  const invalidCalls = [
    { type: 'toolCall' as const, id: 'missing', name: 'strict', arguments: {} },
    { type: 'toolCall' as const, id: 'wrong-type', name: 'strict', arguments: { path: 42 } },
    {
      type: 'toolCall' as const,
      id: 'additional',
      name: 'strict',
      arguments: { path: 'safe.txt', surprise: true },
    },
  ];
  let requestNumber = 0;
  const client: CompletionClient = {
    async *stream(_request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requestNumber++;
      const message: AssistantMessage =
        requestNumber === 1
          ? { role: 'assistant', content: invalidCalls }
          : { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
      yield { type: 'done', message, stopReason: requestNumber === 1 ? 'tool_use' : 'end_turn', usage };
    },
  };
  let executions = 0;
  const tool: Tool = {
    name: 'strict',
    description: 'A side-effecting test tool.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    async execute() {
      executions++;
      return { content: [{ type: 'text', text: 'side effect happened' }] };
    },
  };
  const agent = new Agent({ client, model: 'model', systemPrompt: 's', tools: [tool], cwd: directory, session });
  const events: AgentEvent[] = [];
  for await (const event of agent.run('go')) events.push(event);

  assert.equal(executions, 0);
  assert.equal(events.filter((event) => event.type === 'tool_start').length, 0);
  assert.equal(events.filter((event) => event.type === 'tool_end').length, 0);

  const reopened = Session.open(session.file);
  assert.equal(reopened.toolExecutions.length, 3);
  assert.ok(reopened.toolExecutions.every((execution) => execution.status === 'skipped'));
  assert.ok(reopened.toolExecutions.every((execution) => execution.startedAt === undefined));
  assert.match(reopened.toolExecutions[0]?.reason ?? '', /required property is missing/);
  assert.match(reopened.toolExecutions[1]?.reason ?? '', /expected string/);
  assert.match(reopened.toolExecutions[2]?.reason ?? '', /additional property is not allowed/);

  const resultMessage = agent.messages.find(
    (message) => message.role === 'user' && message.content.some((block) => block.type === 'toolResult'),
  );
  assert.ok(resultMessage?.role === 'user');
  assert.equal(resultMessage.content.filter((block) => block.type === 'toolResult').length, 3);
  assert.match(JSON.stringify(resultMessage), /not run: tool \\"strict\\" arguments invalid/);
});
