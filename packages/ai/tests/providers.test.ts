import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AnthropicProvider } from '../src/anthropic.js';
import { LLMClient } from '../src/client.js';
import { OpenAIProvider } from '../src/openai.js';
import { PROVIDER_STREAM_LIMITS } from '../src/sse.js';
import {
  ApiError,
  ProviderProtocolError,
  ProviderTransportError,
  RequestTimeoutError,
  type CompletionRequest,
  type StreamEvent,
} from '../src/types.js';

const request: CompletionRequest = {
  model: 'test-model',
  system: 'test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
};

function streamResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function hangingResponse(onCancel?: () => void, cancelNeverSettles = false): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel?.();
        if (cancelNeverSettles) return new Promise<void>(() => {});
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function chunkedStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function mockFetch(t: TestContext, response: () => Response): void {
  t.mock.method(globalThis, 'fetch', async () => response());
}

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function openAIStream(finishReason: string, content = 'hello'): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}`,
    '',
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function anthropicStream(stopReason: string): string {
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
}

test('OpenAI requires both finish_reason and [DONE]', async (t) => {
  const withoutDone = openAIStream('stop').replace('data: [DONE]\n\n', '');
  mockFetch(t, () => streamResponse(withoutDone));
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('[DONE]'),
  );
});

test('OpenAI rejects [DONE] without a finish_reason', async (t) => {
  mockFetch(t, () => streamResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('finish_reason'),
  );
});

test('OpenAI rejects malformed SSE JSON', async (t) => {
  mockFetch(t, () => streamResponse('data: {not-json}\n\n'));
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('malformed JSON'),
  );
});

test('OpenAI rejects a truncated tool call instead of emitting executable raw arguments', async (t) => {
  const body = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command":' } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  mockFetch(t, () => streamResponse(body));
  const observed: StreamEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of new OpenAIProvider('key', 'https://example.test/v1').stream(request)) {
        observed.push(event);
      }
    })(),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('incomplete JSON'),
  );
  assert.equal(observed.some((event) => event.type === 'tool_call' || event.type === 'done'), false);
});

test('OpenAI preserves max_tokens as a completed protocol stop reason', async (t) => {
  mockFetch(t, () => streamResponse(openAIStream('length')));
  const events = await collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request));
  const done = events.find((event) => event.type === 'done');
  assert.equal(done?.type, 'done');
  if (done?.type === 'done') {
    assert.equal(done.stopReason, 'max_tokens');
    assert.deepEqual(done.usage, { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 });
  }
});

test('OpenAI emits a validated tool call only after terminal protocol markers', async (t) => {
  const chunks = [
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'ba', arguments: '{"command":"' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { name: 'sh', arguments: 'pwd"}' } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`).join('\n')}\ndata: [DONE]\n\n`;
  const bodyWithUsage = body.replace(
    'data: [DONE]',
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]`,
  );
  mockFetch(t, () => streamResponse(bodyWithUsage));
  const events = await collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request));
  assert.deepEqual(events.at(-2), {
    type: 'tool_call',
    call: { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'pwd' } },
  });
  assert.equal(events.at(-1)?.type, 'done');
});

test('OpenAI rejects duplicate tool call IDs before emitting tool events', async (t) => {
  const body = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_duplicate', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
              { index: 1, id: 'call_duplicate', function: { name: 'bash', arguments: '{"command":"ls"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  mockFetch(t, () => streamResponse(body));
  const observed: StreamEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of new OpenAIProvider('key', 'https://example.test/v1').stream(request)) {
        observed.push(event);
      }
    })(),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('duplicate tool call id'),
  );
  assert.equal(observed.some((event) => event.type === 'tool_call' || event.type === 'done'), false);
});

test('OpenAI fails closed when a terminal stream omits usage', async (t) => {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  mockFetch(t, () => streamResponse(body));
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('usage report'),
  );
});

test('OpenAI rejects invalid and internally inconsistent usage counters', async (t) => {
  for (const usage of [
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 7, completion_tokens: 1.5 },
    { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } },
    { prompt_tokens: 7, completion_tokens: 2, total_tokens: 8 },
  ]) {
    mockFetch(t, () => {
      const valid = openAIStream('stop');
      return streamResponse(
        valid.replace(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } },
          }),
          JSON.stringify({ choices: [], usage }),
        ),
      );
    });
    await assert.rejects(
      collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
      ProviderProtocolError,
    );
    t.mock.reset();
  }

  const nonFinite = openAIStream('stop').replace('"prompt_tokens":7', '"prompt_tokens":1e309');
  mockFetch(t, () => streamResponse(nonFinite));
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('finite nonnegative integer'),
  );
});

test('Anthropic requires message_stop', async (t) => {
  const withoutStop = anthropicStream('end_turn').replace(
    /event: message_stop\ndata: \{"type":"message_stop"\}\n\n$/,
    '',
  );
  mockFetch(t, () => streamResponse(withoutStop));
  await assert.rejects(
    collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('message_stop'),
  );
});

test('Anthropic rejects malformed SSE JSON', async (t) => {
  mockFetch(t, () => streamResponse('event: message_start\ndata: nope\n\n'));
  await assert.rejects(
    collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('malformed JSON'),
  );
});

test('Anthropic rejects message_stop with an unfinished tool block', async (t) => {
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
    ],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
  mockFetch(t, () => streamResponse(body));
  await assert.rejects(
    collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('unfinished content blocks'),
  );
});

test('Anthropic rejects invalid tool JSON at content_block_stop', async (t) => {
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ];
  const body = `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
  mockFetch(t, () => streamResponse(body));
  await assert.rejects(
    collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('incomplete JSON'),
  );
});

test('Anthropic preserves max_tokens as a completed protocol stop reason', async (t) => {
  mockFetch(t, () => streamResponse(anthropicStream('max_tokens')));
  const events = await collect(new AnthropicProvider('key', 'https://example.test').stream(request));
  const done = events.find((event) => event.type === 'done');
  assert.equal(done?.type, 'done');
  if (done?.type === 'done') assert.equal(done.stopReason, 'max_tokens');
});

test('Anthropic emits a validated tool call after message_stop', async (t) => {
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} } },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
  mockFetch(t, () => streamResponse(body));
  const observed = await collect(new AnthropicProvider('key', 'https://example.test').stream(request));
  assert.deepEqual(observed.at(-2), {
    type: 'tool_call',
    call: { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'pwd' } },
  });
  assert.equal(observed.at(-1)?.type, 'done');
});

test('Anthropic rejects duplicate tool call IDs before emitting tool events', async (t) => {
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_duplicate', name: 'bash', input: {} },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_duplicate', name: 'bash', input: {} },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
  mockFetch(t, () => streamResponse(body));
  const observed: StreamEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of new AnthropicProvider('key', 'https://example.test').stream(request)) {
        observed.push(event);
      }
    })(),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('duplicate tool call id'),
  );
  assert.equal(observed.some((event) => event.type === 'tool_call' || event.type === 'done'), false);
});

test('Anthropic requires signed thinking and validates redacted thinking data', async (t) => {
  const missingSignature = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ];
  const invalidRedacted = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: '' } },
    ],
  ];
  const invalidSignatureType = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 7 } },
    ],
  ];
  for (const events of [missingSignature, invalidRedacted, invalidSignatureType]) {
    const body = `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
    mockFetch(t, () => streamResponse(body));
    await assert.rejects(
      collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
      ProviderProtocolError,
    );
    t.mock.reset();
  }
});

test('Anthropic accepts a completed thinking block with a string signature', async (t) => {
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-value' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = `${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n`).join('\n')}\n`;
  mockFetch(t, () => streamResponse(body));
  const observed = await collect(new AnthropicProvider('key', 'https://example.test').stream(request));
  const done = observed.find((event) => event.type === 'done');
  assert.equal(done?.type, 'done');
  if (done?.type === 'done') {
    assert.deepEqual(done.message.content, [{ type: 'thinking', thinking: 'reasoning', signature: 'signed-value' }]);
  }
});

test('Anthropic fails closed when required input or final output usage is missing', async (t) => {
  for (const body of [
    anthropicStream('end_turn').replace('"usage":{"input_tokens":7}', '"usage":{}'),
    anthropicStream('end_turn').replace('"usage":{"output_tokens":2}', '"usage":{}'),
  ]) {
    mockFetch(t, () => streamResponse(body));
    await assert.rejects(
      collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
      (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('usage'),
    );
    t.mock.reset();
  }
});

test('Anthropic rejects invalid required and optional usage counters', async (t) => {
  for (const body of [
    anthropicStream('end_turn').replace('"input_tokens":7', '"input_tokens":1.5'),
    anthropicStream('end_turn').replace(
      '"input_tokens":7',
      '"input_tokens":7,"cache_read_input_tokens":-1',
    ),
    anthropicStream('end_turn').replace('"output_tokens":2', '"output_tokens":"2"'),
  ]) {
    mockFetch(t, () => streamResponse(body));
    await assert.rejects(
      collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
      ProviderProtocolError,
    );
    t.mock.reset();
  }
});

test('provider deadline aborts a hanging response with RequestTimeoutError', async (t) => {
  let canceled = false;
  mockFetch(t, () => hangingResponse(() => (canceled = true)));
  await assert.rejects(
    collect(
      new OpenAIProvider('key', 'https://example.test/v1').stream({
        ...request,
        timeoutMs: 20,
      }),
    ),
    RequestTimeoutError,
  );
  assert.equal(canceled, true);
});

test('timeout completion does not await a hanging reader.cancel implementation', async (t) => {
  mockFetch(t, () => hangingResponse(undefined, true));
  const started = Date.now();
  await assert.rejects(
    collect(
      new OpenAIProvider('key', 'https://example.test/v1').stream({
        ...request,
        timeoutMs: 20,
      }),
    ),
    RequestTimeoutError,
  );
  assert.ok(Date.now() - started < 500);
});

test('HTTP error bodies are truncated to a bounded diagnostic prefix', async (t) => {
  const oversized = 'x'.repeat(PROVIDER_STREAM_LIMITS.errorBodyChars + 1024);
  mockFetch(t, () => new Response(oversized, { status: 500 }));
  let caught: unknown;
  try {
    await collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ApiError);
  assert.ok(caught.body?.endsWith('[truncated]'));
  assert.ok((caught.body?.length ?? Infinity) <= PROVIDER_STREAM_LIMITS.errorBodyChars + 20);
});

test('OpenAI bounds aggregate assistant output across otherwise valid SSE events', async (t) => {
  const part = 'x'.repeat(Math.floor(PROVIDER_STREAM_LIMITS.assistantOutputChars / 3) + 1);
  const chunks = Array.from(
    { length: 3 },
    () => `data: ${JSON.stringify({ choices: [{ delta: { content: part }, finish_reason: null }] })}\n\n`,
  );
  mockFetch(t, () => chunkedStreamResponse(chunks));
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('assistant output exceeded'),
  );
});

test('Anthropic bounds accumulated tool argument JSON before parsing it', async (t) => {
  const start = {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
  };
  const delta = {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: 'x'.repeat(PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars + 1),
    },
  };
  mockFetch(t, () =>
    chunkedStreamResponse([
      `event: content_block_start\ndata: ${JSON.stringify(start)}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`,
    ]),
  );
  await assert.rejects(
    collect(new AnthropicProvider('key', 'https://example.test').stream(request)),
    (error: unknown) => error instanceof ProviderProtocolError && error.message.includes('tool arguments exceeded'),
  );
});

test('network failures are surfaced as typed transport errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('socket closed');
  });
  await assert.rejects(
    collect(new OpenAIProvider('key', 'https://example.test/v1').stream(request)),
    (error: unknown) =>
      error instanceof ProviderTransportError && error.provider === 'openai' && error.message.includes('socket closed'),
  );
});

test('LLMClient deadline covers a hanging response and does not retry it', async (t) => {
  let calls = 0;
  mockFetch(t, () => {
    calls++;
    return hangingResponse();
  });
  const client = new LLMClient({
    name: 'test',
    provider: 'openai',
    model: 'test-model',
    apiKey: 'key',
    baseUrl: 'https://example.test/v1',
  });
  await assert.rejects(collect(client.stream({ ...request, timeoutMs: 20 })), RequestTimeoutError);
  assert.equal(calls, 1);
});

test('caller abort reason is preserved', async (t) => {
  mockFetch(t, () => hangingResponse());
  const controller = new AbortController();
  const reason = new Error('stop now');
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(
    collect(new AnthropicProvider('key', 'https://example.test').stream(request, controller.signal)),
    (error: unknown) => error === reason,
  );
});
