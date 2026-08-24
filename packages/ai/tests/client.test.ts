import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LLMClient, resolveMaxAttempts } from '../src/client.js';
import { ProviderTransportError, type CompletionRequest, type StreamEvent } from '../src/types.js';

const profile = {
  name: 'test',
  provider: 'openai' as const,
  model: 'test-model',
  apiKey: 'key',
  credentialSource: 'TEST_API_KEY',
  baseUrl: 'https://example.test/v1',
};

const request: CompletionRequest = {
  model: 'test-model',
  system: 'test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
};

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function responseThatFailsAfterBytes(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        // Let the consumer parse the first chunk before failing its next read.
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.error(new TypeError('stream connection reset'));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function responseThatFailsBeforeBytes(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('stream failed before first byte'));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function anthropicEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

test('resolveMaxAttempts validates request values and applies default then configured bound', () => {
  assert.equal(resolveMaxAttempts(undefined), 3);
  assert.equal(resolveMaxAttempts(1), 1);
  assert.equal(resolveMaxAttempts(100), 3);
  assert.equal(resolveMaxAttempts(undefined, 5, 2), 2);
  assert.equal(resolveMaxAttempts(1, 5, 2), 1);

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveMaxAttempts(invalid), /safe integer >= 1/);
  }
});

test('maxAttempts 1 performs exactly one provider HTTP attempt', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('network down');
  });
  const client = new LLMClient(profile, { retryBackoffMs: [0] });
  await assert.rejects(collect(client.stream({ ...request, maxAttempts: 1 })), ProviderTransportError);
  assert.equal(calls, 1);
});

test('request attempts cannot exceed the configured retry bound', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('network down');
  });
  const client = new LLMClient(profile, {
    retryDefaultAttempts: 5,
    retryMaxAttempts: 2,
    retryBackoffMs: [0],
  });
  await assert.rejects(collect(client.stream({ ...request, maxAttempts: 100 })), ProviderTransportError);
  assert.equal(calls, 2);
});

test('invalid request attempt limits fail before the first HTTP request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('should not run');
  });
  const client = new LLMClient(profile);
  await assert.rejects(collect(client.stream({ ...request, maxAttempts: 0 })), RangeError);
  assert.equal(calls, 0);
});

test('OpenAI buffered tool response bytes make a transport failure non-retryable', async (t) => {
  const toolDelta = `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
          ],
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return responseThatFailsAfterBytes(toolDelta);
  });

  const client = new LLMClient(profile, { retryBackoffMs: [0] });
  await assert.rejects(collect(client.stream(request)), ProviderTransportError);
  assert.equal(calls, 1, 'a buffered but possibly billed tool generation must never be replayed');
});

test('Anthropic buffered tool response bytes make a transport failure non-retryable', async (t) => {
  const body = [
    anthropicEvent('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 1 } },
    }),
    anthropicEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
    }),
    anthropicEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
    }),
    anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ].join('');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return responseThatFailsAfterBytes(body);
  });

  const client = new LLMClient(
    { ...profile, provider: 'anthropic', baseUrl: 'https://example.test' },
    { retryBackoffMs: [0] },
  );
  await assert.rejects(collect(client.stream(request)), ProviderTransportError);
  assert.equal(calls, 1, 'a buffered but possibly billed tool generation must never be replayed');
});

test('OpenAI successful response is non-retryable when the body fails before byte one', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return responseThatFailsBeforeBytes();
  });

  const client = new LLMClient(profile, { retryBackoffMs: [0] });
  await assert.rejects(collect(client.stream(request)), ProviderTransportError);
  assert.equal(calls, 1, 'a possibly billed 2xx response must never be replayed');
});

test('Anthropic successful response is non-retryable when the body fails before byte one', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return responseThatFailsBeforeBytes();
  });

  const client = new LLMClient(
    { ...profile, provider: 'anthropic', baseUrl: 'https://example.test' },
    { retryBackoffMs: [0] },
  );
  await assert.rejects(collect(client.stream(request)), ProviderTransportError);
  assert.equal(calls, 1, 'a possibly billed 2xx response must never be replayed');
});
