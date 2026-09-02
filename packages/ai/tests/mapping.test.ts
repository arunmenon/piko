import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextWindowFor } from '../src/tokens.js';
import { buildAnthropicBody } from '../src/anthropic.js';
import { buildOpenAIBody, buildOpenAIMessages, usesCompletionTokensParam } from '../src/openai.js';
import type { CompletionRequest } from '../src/types.js';

const request: CompletionRequest = {
  model: 'test-model',
  system: 'be terse',
  tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'run ls' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'running' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'file.txt' }] },
        { type: 'text', text: 'now what?' },
      ],
    },
  ],
};

test('contextWindowFor maps model families and defaults conservatively', () => {
  assert.equal(contextWindowFor('claude-sonnet-5'), 200_000);
  assert.equal(contextWindowFor('gpt-4.1-mini'), 1_000_000);
  assert.equal(contextWindowFor('gpt-5.2'), 400_000);
  assert.equal(contextWindowFor('kimi-k3'), 256_000);
  assert.equal(contextWindowFor('some-unknown-model'), 128_000);
});

test('anthropic body: caching breakpoints and tool_use mapping', () => {
  const body = buildAnthropicBody(request) as any;
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  const messages = body.messages;
  assert.equal(messages[1].content[1].type, 'tool_use');
  assert.deepEqual(messages[1].content[1].input, { command: 'ls' });
  assert.equal(messages[2].content[0].type, 'tool_result');
  // incremental cache breakpoint sits on the last block of the last message
  const lastBlocks = messages[2].content;
  assert.equal(lastBlocks[lastBlocks.length - 1].cache_control.type, 'ephemeral');
  assert.equal(messages[0].content[0].cache_control, undefined);
});

test('anthropic body: a configured cache TTL reaches every breakpoint, and no TTL leaves the shape untouched', () => {
  const withTtl = buildAnthropicBody(request, { cacheTtl: '1h' }) as any;
  assert.deepEqual(withTtl.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  const lastBlocks = withTtl.messages[2].content;
  assert.deepEqual(lastBlocks[lastBlocks.length - 1].cache_control, { type: 'ephemeral', ttl: '1h' });

  const fiveMinutes = buildAnthropicBody(request, { cacheTtl: '5m' }) as any;
  assert.deepEqual(fiveMinutes.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });

  // Omitted means the provider default, and the body stays byte-identical to
  // the pre-option shape so an unset profile cannot move the cache key.
  const unset = buildAnthropicBody(request) as any;
  assert.deepEqual(unset.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(JSON.stringify(unset), JSON.stringify(buildAnthropicBody(request, {})));
});

test('openai body ignores the anthropic-only cache TTL profile option', () => {
  // OpenAI caches automatically with no caller control, so the option has no
  // mapping there; the request body must carry no trace of it.
  const body = buildOpenAIBody({ ...request, model: 'gpt-5' });
  assert.doesNotMatch(JSON.stringify(body), /ttl|cache_control/);
});

test('anthropic body: consecutive same-role messages are merged (strict alternation)', () => {
  const body = buildAnthropicBody({
    ...request,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
    ],
  }) as any;
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].content.length, 2);
});

test('anthropic body: thinking blocks are replayed with signature and enable budget', () => {
  const body = buildAnthropicBody({
    ...request,
    thinkingBudget: 2048,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig123' },
          { type: 'text', text: 'answer' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ],
  }) as any;
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(body.max_tokens > 2048, true);
  assert.deepEqual(body.messages[1].content[0], { type: 'thinking', thinking: 'hmm', signature: 'sig123' });
});

test('anthropic body: maxTokens remains a hard cap and safely disables oversized thinking', () => {
  const body = buildAnthropicBody({ ...request, maxTokens: 4096, thinkingBudget: 2048 }) as any;
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 });

  for (const [incompatible, expectedCap] of [
    [buildAnthropicBody({ ...request, maxTokens: 2048, thinkingBudget: 2048 }), 2048],
    [buildAnthropicBody({ ...request, maxTokens: 2048, thinkingBudget: 4096 }), 2048],
    [buildAnthropicBody({ ...request, thinkingBudget: 8192 }), 8192],
  ] as [any, number][]) {
    assert.equal(incompatible.max_tokens, expectedCap);
    assert.equal(incompatible.thinking, undefined);
  }
});

test('openai body: reasoning models get max_completion_tokens and no temperature', () => {
  assert.equal(usesCompletionTokensParam('gpt-5.2'), true);
  assert.equal(usesCompletionTokensParam('o3-mini'), true);
  assert.equal(usesCompletionTokensParam('gpt-4.1-mini'), false);
  assert.equal(usesCompletionTokensParam('qwen3-coder-plus'), false);

  const reasoning = buildOpenAIBody({ ...request, model: 'gpt-5.2', temperature: 0 }) as any;
  assert.equal(reasoning.max_completion_tokens, 8192);
  assert.equal(reasoning.max_tokens, undefined);
  assert.equal(reasoning.temperature, undefined);

  const classic = buildOpenAIBody({ ...request, model: 'gpt-4.1-mini', temperature: 0 }) as any;
  assert.equal(classic.max_tokens, 8192);
  assert.equal(classic.temperature, 0);
});

test('openai messages: tool results become role:tool before the user text', () => {
  const messages = buildOpenAIMessages(request) as any[];
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(messages[2].tool_calls[0].function.name, 'bash');
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'call_1');
  assert.equal(messages[3].content, 'file.txt');
  assert.equal(messages[4].role, 'user');
  assert.equal(messages[4].content, 'now what?');
});
