import {
  createRequestSignalScope,
  PROVIDER_STREAM_LIMITS,
  readTextBodyLimited,
  SSELimitError,
  sseEvents,
} from './sse.js';
import {
  ApiError,
  ProviderProtocolError,
  ProviderTransportError,
  readUsageCounter,
  type AssistantBlock,
  type AssistantMessage,
  type CompletionRequest,
  type Message,
  type Provider,
  type ProviderAttemptActivity,
  type StopReason,
  type StreamEvent,
  type ToolCallBlock,
  type Usage,
  validateUsageCounters,
} from './types.js';

const DEFAULT_MAX_TOKENS = 8192; // safe across deepseek/qwen/kimi output caps

/** gpt-5 family and o-series reject max_tokens (and non-default temperature) on chat completions */
export function usesCompletionTokensParam(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

function textOf(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Maps the unified message format onto chat-completions messages. Tool results become
 *  role:"tool" messages; thinking blocks are never echoed back (DeepSeek rejects that). */
export function buildOpenAIMessages(request: CompletionRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === 'toolCall');
      const text = textOf(message.content);
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      });
      continue;
    }
    // Tool results must be standalone role:"tool" messages, in call order.
    const rest: Record<string, unknown>[] = [];
    for (const block of message.content) {
      if (block.type === 'toolResult') {
        const imageNote = block.content.some((inner) => inner.type === 'image')
          ? '\n[image content omitted: not supported in tool results by this provider]'
          : '';
        messages.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: textOf(block.content) + imageNote,
        });
      } else if (block.type === 'text') {
        rest.push({ type: 'text', text: block.text });
      } else {
        rest.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
      }
    }
    if (rest.length > 0) {
      const onlyText = rest.every((part) => part['type'] === 'text');
      messages.push({ role: 'user', content: onlyText ? rest.map((part) => part['text']).join('\n') : rest });
    }
  }
  return messages;
}

export function buildOpenAIBody(request: CompletionRequest): Record<string, unknown> {
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const reasoningModel = usesCompletionTokensParam(request.model);
  return {
    model: request.model,
    messages: buildOpenAIMessages(request),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          // Only meaningful alongside a tool list; an empty list already forbids tool use.
          ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
        }
      : {}),
    ...(reasoningModel ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(request.temperature !== undefined && !reasoningModel ? { temperature: request.temperature } : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

function optionalUsageCounter(provider: string, field: string, value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : readUsageCounter(provider, field, value);
}

function addOpenAIChars(current: number, added: number, limit: number, label: string): number {
  if (added > limit - current) {
    throw new ProviderProtocolError('openai', `${label} exceeded ${limit} characters`);
  }
  return current + added;
}

/** A non-null usage object may be an incomplete compatibility placeholder. It
 * is validated immediately, but only a self-contained prompt+completion report
 * can satisfy the terminal accounting invariant. */
function parseOpenAIUsage(raw: unknown): Usage | undefined {
  validateUsageCounters('openai', raw);
  const value = raw as Record<string, unknown>;
  const promptTokens = optionalUsageCounter('openai', 'usage.prompt_tokens', value['prompt_tokens']);
  const completionTokens = optionalUsageCounter('openai', 'usage.completion_tokens', value['completion_tokens']);

  const detailsRaw = value['prompt_tokens_details'];
  if (
    detailsRaw !== undefined &&
    detailsRaw !== null &&
    (typeof detailsRaw !== 'object' || Array.isArray(detailsRaw))
  ) {
    throw new ProviderProtocolError('openai', 'usage.prompt_tokens_details must be an object');
  }
  const details = (detailsRaw ?? {}) as Record<string, unknown>;
  const detailsCached = optionalUsageCounter(
    'openai',
    'usage.prompt_tokens_details.cached_tokens',
    details['cached_tokens'],
  );
  const legacyCached = optionalUsageCounter(
    'openai',
    'usage.prompt_cache_hit_tokens',
    value['prompt_cache_hit_tokens'],
  );
  if (detailsCached !== undefined && legacyCached !== undefined && detailsCached !== legacyCached) {
    throw new ProviderProtocolError('openai', 'usage reported conflicting cached token counts');
  }

  // Missing required counters is not converted to zero. A later complete usage
  // chunk may replace a compatibility placeholder; terminal validation requires it.
  if (promptTokens === undefined || completionTokens === undefined) return undefined;

  const cachedTokens = detailsCached ?? legacyCached ?? 0;
  if (cachedTokens > promptTokens) {
    throw new ProviderProtocolError('openai', 'cached tokens exceed prompt tokens');
  }
  const totalTokens = optionalUsageCounter('openai', 'usage.total_tokens', value['total_tokens']);
  if (totalTokens !== undefined && totalTokens !== promptTokens + completionTokens) {
    throw new ProviderProtocolError('openai', 'usage.total_tokens does not equal prompt_tokens + completion_tokens');
  }
  const cacheMissTokens = optionalUsageCounter(
    'openai',
    'usage.prompt_cache_miss_tokens',
    value['prompt_cache_miss_tokens'],
  );
  if (cacheMissTokens !== undefined && cacheMissTokens !== promptTokens - cachedTokens) {
    throw new ProviderProtocolError('openai', 'prompt cache hit/miss counters are inconsistent');
  }
  return {
    inputTokens: promptTokens - cachedTokens,
    outputTokens: completionTokens,
    cacheReadTokens: cachedTokens,
    // Chat Completions exposes cache reads, but no cache-write token counter.
    cacheWriteTokens: 0,
  };
}

/** Works with any OpenAI-compatible endpoint: OpenAI, Qwen, Moonshot/Kimi, DeepSeek, OpenRouter, vLLM, llama.cpp. */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
    attemptActivity?: ProviderAttemptActivity,
  ): AsyncGenerator<StreamEvent, void, void> {
    const scope = createRequestSignalScope(signal, request.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(buildOpenAIBody(request)),
          signal: scope.signal,
        });
      } catch (error) {
        if (scope.signal?.aborted) throw scope.signal.reason ?? error;
        if (error instanceof Error) {
          throw new ProviderTransportError('openai', error.message, { cause: error });
        }
        throw error;
      }
      if (!response.ok || !response.body) {
        const body = await readTextBodyLimited(
          response.body,
          PROVIDER_STREAM_LIMITS.errorBodyChars,
          scope.signal,
        ).catch((error: unknown) => {
          if (scope.signal?.aborted) throw scope.signal.reason ?? error;
          return '';
        });
        if (scope.signal?.aborted) throw scope.signal.reason ?? new Error('aborted');
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new ApiError(
          `openai: HTTP ${response.status}`,
          response.status,
          body,
          Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        );
      }

      // A successful response with a stream may already represent a billed
      // generation even if the first body read fails. Cross this retry boundary
      // before touching the stream so LLMClient never replays that request.
      attemptActivity?.markResponseActivity();

      let usage: Usage | undefined;
      let previousCompleteUsage: Usage | undefined;
      let text = '';
      let assistantOutputChars = 0;
      let totalToolArgumentChars = 0;
      const toolCalls: PendingToolCall[] = [];
      const slotByIndex = new Map<number, PendingToolCall>();
      let stopReason: StopReason = 'other';
      let sawDoneMarker = false;
      let sawFinishReason = false;

      try {
        for await (const event of sseEvents(response.body, scope.signal)) {
          const raw = event.data.trim();
          if (!raw) continue;
          if (raw === '[DONE]') {
            sawDoneMarker = true;
            break;
          }
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(raw);
          } catch (error) {
            throw new ProviderProtocolError('openai', 'received malformed JSON in SSE data', { cause: error });
          }
          if (parsedData === null || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
            throw new ProviderProtocolError('openai', 'SSE data payload was not a JSON object');
          }
          const data = parsedData as Record<string, any>;
          if (data['error']) {
            throw new ApiError(
              `openai: ${data['error'].type ?? 'error'}: ${data['error'].message ?? 'stream error'}`,
              undefined,
              raw,
            );
          }
          if (data['usage'] !== undefined && data['usage'] !== null) {
            const reported = parseOpenAIUsage(data['usage']);
            if (reported && previousCompleteUsage) {
              const reportedInput = reported.inputTokens + reported.cacheReadTokens + reported.cacheWriteTokens;
              const previousInput =
                previousCompleteUsage.inputTokens +
                previousCompleteUsage.cacheReadTokens +
                previousCompleteUsage.cacheWriteTokens;
              if (reportedInput < previousInput || reported.outputTokens < previousCompleteUsage.outputTokens) {
                throw new ProviderProtocolError('openai', 'aggregate token usage decreased during the stream');
              }
            }
            if (reported) previousCompleteUsage = reported;
            usage = reported;
          }
          if (data['choices'] === undefined) {
            continue; // provider metadata chunk (errors were handled above)
          }
          if (!Array.isArray(data['choices'])) {
            throw new ProviderProtocolError('openai', 'choices was not an array');
          }
          if (data['choices'].length === 0) {
            continue; // usage or provider metadata chunk
          }
          const choice = data['choices'][0];
          if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) {
            throw new ProviderProtocolError('openai', 'choice was not an object');
          }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            if (typeof choice.finish_reason !== 'string') {
              throw new ProviderProtocolError('openai', 'finish_reason was not a string');
            }
            const mapped = mapFinishReason(choice.finish_reason);
            if (sawFinishReason && mapped !== stopReason) {
              throw new ProviderProtocolError('openai', 'received conflicting finish reasons');
            }
            sawFinishReason = true;
            stopReason = mapped;
          }
          const delta = choice.delta ?? {};
          if (typeof delta !== 'object' || Array.isArray(delta)) {
            throw new ProviderProtocolError('openai', 'choice delta was not an object');
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            assistantOutputChars = addOpenAIChars(
              assistantOutputChars,
              delta.content.length,
              PROVIDER_STREAM_LIMITS.assistantOutputChars,
              'assistant output',
            );
            text += delta.content;
            yield { type: 'text_delta', text: delta.content };
          }
          if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
            assistantOutputChars = addOpenAIChars(
              assistantOutputChars,
              delta.refusal.length,
              PROVIDER_STREAM_LIMITS.assistantOutputChars,
              'assistant output',
            );
            text += delta.refusal; // surface refusals instead of ending the turn with empty output
            yield { type: 'text_delta', text: delta.refusal };
          }
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            assistantOutputChars = addOpenAIChars(
              assistantOutputChars,
              delta.reasoning_content.length,
              PROVIDER_STREAM_LIMITS.assistantOutputChars,
              'assistant output',
            );
            yield { type: 'thinking_delta', text: delta.reasoning_content };
          }
          if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
            throw new ProviderProtocolError('openai', 'tool_calls delta was not an array');
          }
          for (const part of delta.tool_calls ?? []) {
            if (part === null || typeof part !== 'object' || Array.isArray(part)) {
              throw new ProviderProtocolError('openai', 'tool call delta was not an object');
            }
            if (!Number.isInteger(part.index) || part.index < 0) {
              throw new ProviderProtocolError('openai', 'tool call delta is missing a valid index');
            }
            let entry = slotByIndex.get(part.index);
            if (!entry) {
              if (toolCalls.length >= PROVIDER_STREAM_LIMITS.toolCalls) {
                throw new ProviderProtocolError(
                  'openai',
                  `tool call count exceeded ${PROVIDER_STREAM_LIMITS.toolCalls}`,
                );
              }
              entry = { id: '', name: '', argumentsJson: '' };
              toolCalls.push(entry);
              slotByIndex.set(part.index, entry);
            } else if (part.id && entry.id && part.id !== entry.id) {
              throw new ProviderProtocolError('openai', `tool call index ${part.index} changed id`);
            }
            if (part.id !== undefined) {
              if (typeof part.id !== 'string') throw new ProviderProtocolError('openai', 'tool call id was not a string');
              if (part.id.length > PROVIDER_STREAM_LIMITS.toolIdentifierChars) {
                throw new ProviderProtocolError('openai', 'tool call id exceeded the identifier limit');
              }
              entry.id = part.id;
            }
            if (part.function?.name !== undefined) {
              if (typeof part.function.name !== 'string') {
                throw new ProviderProtocolError('openai', 'tool call name was not a string');
              }
              if (!entry.name || part.function.name.startsWith(entry.name)) entry.name = part.function.name;
              else if (part.function.name !== entry.name) entry.name += part.function.name;
              if (entry.name.length > PROVIDER_STREAM_LIMITS.toolIdentifierChars) {
                throw new ProviderProtocolError('openai', 'tool call name exceeded the identifier limit');
              }
            }
            if (part.function?.arguments !== undefined) {
              if (typeof part.function.arguments !== 'string') {
                throw new ProviderProtocolError('openai', 'tool call arguments delta was not a string');
              }
              if (
                part.function.arguments.length >
                PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars - entry.argumentsJson.length
              ) {
                throw new ProviderProtocolError(
                  'openai',
                  `tool arguments exceeded ${PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars} characters`,
                );
              }
              totalToolArgumentChars = addOpenAIChars(
                totalToolArgumentChars,
                part.function.arguments.length,
                PROVIDER_STREAM_LIMITS.toolArgumentsTotalChars,
                'total tool arguments',
              );
              entry.argumentsJson += part.function.arguments;
            }
          }
        }
      } catch (error) {
        if (scope.signal?.aborted) throw scope.signal.reason ?? error;
        if (error instanceof SSELimitError) {
          throw new ProviderProtocolError('openai', error.message, { cause: error });
        }
        if (
          error instanceof Error &&
          !(error instanceof ApiError) &&
          !(error instanceof ProviderProtocolError) &&
          !(error instanceof ProviderTransportError)
        ) {
          throw new ProviderTransportError('openai', error.message, { cause: error });
        }
        throw error;
      }

      if (scope.signal?.aborted) throw scope.signal.reason ?? new Error('aborted');
      if (!sawDoneMarker) throw new ProviderProtocolError('openai', 'stream ended before the [DONE] marker');
      if (!sawFinishReason) throw new ProviderProtocolError('openai', 'stream ended without a finish_reason');
      if (!usage) {
        throw new ProviderProtocolError(
          'openai',
          'stream ended without a complete usage report (prompt_tokens and completion_tokens)',
        );
      }

      const blocks: AssistantBlock[] = [];
      const seenToolCallIds = new Set<string>();
      if (text.length > 0) blocks.push({ type: 'text', text });
      for (const entry of toolCalls) {
        if (!entry.id) throw new ProviderProtocolError('openai', 'tool call completed without an id');
        if (!entry.name) throw new ProviderProtocolError('openai', 'tool call completed without a name');
        if (seenToolCallIds.has(entry.id)) {
          throw new ProviderProtocolError('openai', `duplicate tool call id ${entry.id}`);
        }
        seenToolCallIds.add(entry.id);
        let parsed: unknown = {};
        try {
          parsed = entry.argumentsJson ? JSON.parse(entry.argumentsJson) : {};
        } catch (error) {
          throw new ProviderProtocolError('openai', `tool call ${entry.id} has incomplete JSON arguments`, {
            cause: error,
          });
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ProviderProtocolError('openai', `tool call ${entry.id} arguments must be a JSON object`);
        }
        const call: ToolCallBlock = {
          type: 'toolCall',
          id: entry.id,
          name: entry.name,
          arguments: parsed as Record<string, unknown>,
        };
        blocks.push(call);
      }
      if (toolCalls.length > 0 && stopReason !== 'tool_use') {
        throw new ProviderProtocolError('openai', `received tool calls with finish reason ${stopReason}`);
      }
      if (toolCalls.length === 0 && stopReason === 'tool_use') {
        throw new ProviderProtocolError('openai', 'finish_reason announced tool calls but none were completed');
      }

      for (const call of blocks.filter((block): block is ToolCallBlock => block.type === 'toolCall')) {
        yield { type: 'tool_call', call };
      }
      const message: AssistantMessage = { role: 'assistant', content: blocks };
      yield { type: 'done', message, stopReason, usage };
    } finally {
      scope.cleanup();
    }
  }
}
