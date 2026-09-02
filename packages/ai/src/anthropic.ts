import {
  createRequestSignalScope,
  PROVIDER_STREAM_LIMITS,
  readTextBodyLimited,
  SSELimitError,
  sseEvents,
} from './sse.js';
import type { AnthropicCacheTtl } from './cache.js';
import {
  ApiError,
  emptyUsage,
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

const ANTHROPIC_VERSION = '2023-06-01';
const CACHE_CONTROL = { cache_control: { type: 'ephemeral' } };

export interface AnthropicProviderOptions {
  /**
   * Cache lifetime for every breakpoint in the request (ADR 0014). Omitted
   * leaves the provider default of five minutes and keeps the body byte-identical
   * to the pre-option shape, so an unset profile cannot move the cache key.
   */
  readonly cacheTtl?: AnthropicCacheTtl;
}

/** `{type: 'ephemeral'}`, plus `ttl` only when a lifetime was configured. */
function cacheControlFor(cacheTtl: AnthropicCacheTtl | undefined): Record<string, unknown> {
  return cacheTtl === undefined ? CACHE_CONTROL : { cache_control: { type: 'ephemeral', ttl: cacheTtl } };
}
const DEFAULT_MAX_TOKENS = 8192; // safe across every supported model (haiku, deepseek-class caps)

function mapBlocks(message: Message): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text });
        break;
      case 'image':
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: block.mimeType, data: block.data },
        });
        break;
      case 'thinking':
        // must be replayed verbatim (signature included) when tools are used with extended thinking
        content.push(
          block.redactedData !== undefined
            ? { type: 'redacted_thinking', data: block.redactedData }
            : { type: 'thinking', thinking: block.thinking, signature: block.signature },
        );
        break;
      case 'toolCall':
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments });
        break;
      case 'toolResult':
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: block.content.map((inner) =>
            inner.type === 'text'
              ? { type: 'text', text: inner.text }
              : { type: 'image', source: { type: 'base64', media_type: inner.mimeType, data: inner.data } },
          ),
          ...(block.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  return content;
}

/** The API requires strict user/assistant alternation; the agent loop can produce
 *  consecutive user messages (tool results at max-turns, then the next input). */
function mergeAdjacent(messages: Message[]): { role: string; content: Record<string, unknown>[] }[] {
  const merged: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of messages) {
    const blocks = mapBlocks(message);
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) previous.content.push(...blocks);
    else merged.push({ role: message.role, content: blocks });
  }
  return merged;
}

/**
 * Builds the request body. Prefix order is tools -> system -> messages; a cache
 * breakpoint on the system block caches tools+system, a second on the last message
 * block extends the cached prefix incrementally each turn.
 */
export function buildAnthropicBody(
  request: CompletionRequest,
  options: AnthropicProviderOptions = {},
): Record<string, unknown> {
  const cacheControl = cacheControlFor(options.cacheTtl);
  const messages = mergeAdjacent(request.messages);
  const last = messages[messages.length - 1];
  const lastBlock = last?.content[last.content.length - 1];
  if (lastBlock) Object.assign(lastBlock, cacheControl);

  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError('maxTokens must be a positive finite integer');
  }
  if (
    request.thinkingBudget !== undefined &&
    (!Number.isSafeInteger(request.thinkingBudget) || request.thinkingBudget < 0)
  ) {
    throw new RangeError('thinkingBudget must be a finite nonnegative integer');
  }
  // maxTokens is a hard cap and may shrink as a run consumes its output budget.
  // If the configured thinking budget no longer fits, omit thinking for this
  // request rather than widening the cap or crashing a later agent iteration.
  const thinking =
    request.thinkingBudget !== undefined && request.thinkingBudget > 0 && request.thinkingBudget < maxTokens;

  return {
    model: request.model,
    max_tokens: maxTokens,
    // extended thinking requires temperature 1 (the default) — omit it entirely
    ...(request.temperature !== undefined && !thinking ? { temperature: request.temperature } : {}),
    ...(thinking ? { thinking: { type: 'enabled', budget_tokens: request.thinkingBudget } } : {}),
    system: [{ type: 'text', text: request.system, ...cacheControl }],
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    // Only meaningful alongside a tool list; an empty list already forbids tool use.
    ...(request.toolChoice === 'none' && request.tools.length > 0 ? { tool_choice: { type: 'none' } } : {}),
    messages,
    stream: true,
  };
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}

function errorStatus(type: string | undefined): number {
  switch (type) {
    case 'overloaded_error':
      return 529;
    case 'rate_limit_error':
      return 429;
    case 'api_error':
      return 500;
    default:
      return 400; // invalid_request / authentication / permission / billing — never retry
  }
}

interface PendingBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'other';
  text: string;
  toolId: string;
  toolName: string;
  partialJson: string;
  signature: string;
  redactedData?: string;
}

function optionalAnthropicUsageCounter(field: string, value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : readUsageCounter('anthropic', field, value);
}

function anthropicUsageObject(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    throw new ProviderProtocolError('anthropic', `missing required usage object ${path}`);
  }
  validateUsageCounters('anthropic', raw, path);
  return raw as Record<string, unknown>;
}

function addAnthropicChars(current: number, added: number, limit: number, label: string): number {
  if (added > limit - current) {
    throw new ProviderProtocolError('anthropic', `${label} exceeded ${limit} characters`);
  }
  return current + added;
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly options: AnthropicProviderOptions = {},
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
        response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(buildAnthropicBody(request, this.options)),
          signal: scope.signal,
        });
      } catch (error) {
        if (scope.signal?.aborted) throw scope.signal.reason ?? error;
        if (error instanceof Error) {
          throw new ProviderTransportError('anthropic', error.message, { cause: error });
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
          `anthropic: HTTP ${response.status}`,
          response.status,
          body,
          Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        );
      }

      // A successful response with a stream may already represent a billed
      // generation even if the first body read fails. Cross this retry boundary
      // before touching the stream so LLMClient never replays that request.
      attemptActivity?.markResponseActivity();

      const usage: Usage = emptyUsage();
      const blocks: AssistantBlock[] = [];
      const pending = new Map<number, PendingBlock>();
      let stopReason: StopReason = 'other';
      let sawMessageStart = false;
      let sawStopReason = false;
      let sawMessageStop = false;
      let sawOutputUsage = false;
      let sawFinalOutputUsage = false;
      let assistantOutputChars = 0;
      let totalToolArgumentChars = 0;
      let toolCallCount = 0;
      let contentBlockCount = 0;

      try {
        for await (const event of sseEvents(response.body, scope.signal)) {
          if (!event.data.trim()) continue; // comments are removed by the SSE parser
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(event.data);
          } catch (error) {
            throw new ProviderProtocolError('anthropic', 'received malformed JSON in SSE data', { cause: error });
          }
          if (parsedData === null || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
            throw new ProviderProtocolError('anthropic', 'SSE data payload was not a JSON object');
          }
          const data = parsedData as Record<string, any>;
          if (typeof data['type'] !== 'string') {
            throw new ProviderProtocolError('anthropic', 'event payload is missing a type');
          }
          if (event.event && event.event !== data['type']) {
            throw new ProviderProtocolError(
              'anthropic',
              `SSE event ${event.event} did not match payload type ${data['type']}`,
            );
          }
          switch (data['type']) {
            case 'message_start': {
              if (sawMessageStart) throw new ProviderProtocolError('anthropic', 'received duplicate message_start');
              sawMessageStart = true;
              const u = anthropicUsageObject(data['message']?.usage, 'message_start.message.usage');
              usage.inputTokens = readUsageCounter(
                'anthropic',
                'message_start.message.usage.input_tokens',
                u['input_tokens'],
              );
              usage.cacheReadTokens =
                optionalAnthropicUsageCounter(
                  'message_start.message.usage.cache_read_input_tokens',
                  u['cache_read_input_tokens'],
                ) ?? 0;
              usage.cacheWriteTokens =
                optionalAnthropicUsageCounter(
                  'message_start.message.usage.cache_creation_input_tokens',
                  u['cache_creation_input_tokens'],
                ) ?? 0;
              break;
            }
            case 'content_block_start': {
              if (++contentBlockCount > PROVIDER_STREAM_LIMITS.contentBlocks) {
                throw new ProviderProtocolError(
                  'anthropic',
                  `content block count exceeded ${PROVIDER_STREAM_LIMITS.contentBlocks}`,
                );
              }
              if (!Number.isInteger(data['index']) || data['index'] < 0) {
                throw new ProviderProtocolError('anthropic', 'content block is missing a valid index');
              }
              if (pending.has(data['index'])) {
                throw new ProviderProtocolError('anthropic', `content block ${data['index']} started twice`);
              }
              const block = data['content_block'];
              if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
                throw new ProviderProtocolError('anthropic', 'content_block_start is missing its block');
              }
              if (block.type === 'text' && block.text !== undefined && typeof block.text !== 'string') {
                throw new ProviderProtocolError('anthropic', 'text block initial content was not a string');
              }
              if (block.type === 'thinking' && block.thinking !== undefined && typeof block.thinking !== 'string') {
                throw new ProviderProtocolError('anthropic', 'thinking block initial content was not a string');
              }
              if (block.type === 'thinking' && block.signature !== undefined && typeof block.signature !== 'string') {
                throw new ProviderProtocolError('anthropic', 'thinking block signature was not a string');
              }
              if (
                block.type === 'redacted_thinking' &&
                (typeof block.data !== 'string' || block.data.length === 0)
              ) {
                throw new ProviderProtocolError('anthropic', 'redacted thinking data must be a nonempty string');
              }
              if (
                block.type === 'tool_use' &&
                (typeof block.id !== 'string' || typeof block.name !== 'string')
              ) {
                throw new ProviderProtocolError('anthropic', 'tool block is missing a string id or name');
              }
              if (
                block.type === 'tool_use' &&
                (block.id.length > PROVIDER_STREAM_LIMITS.toolIdentifierChars ||
                  block.name.length > PROVIDER_STREAM_LIMITS.toolIdentifierChars)
              ) {
                throw new ProviderProtocolError('anthropic', 'tool block id or name exceeded the identifier limit');
              }
              if (
                block.type === 'tool_use' &&
                block.input !== undefined &&
                (block.input === null || typeof block.input !== 'object' || Array.isArray(block.input))
              ) {
                throw new ProviderProtocolError('anthropic', 'tool block input was not a JSON object');
              }
              if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type)) {
                throw new ProviderProtocolError('anthropic', `unsupported content block type ${block.type}`);
              }
              const type =
                block.type === 'text' || block.type === 'tool_use' || block.type === 'thinking' ? block.type : 'other';
              const initialText =
                block.type === 'text' ? (block.text ?? '') : block.type === 'thinking' ? (block.thinking ?? '') : '';
              const initialSignature = block.type === 'thinking' ? (block.signature ?? '') : '';
              const redactedData = block.type === 'redacted_thinking' ? block.data : undefined;
              assistantOutputChars = addAnthropicChars(
                assistantOutputChars,
                initialText.length + initialSignature.length + (redactedData?.length ?? 0),
                PROVIDER_STREAM_LIMITS.assistantOutputChars,
                'assistant output',
              );

              let initialArguments = '';
              if (block.type === 'tool_use') {
                if (++toolCallCount > PROVIDER_STREAM_LIMITS.toolCalls) {
                  throw new ProviderProtocolError(
                    'anthropic',
                    `tool call count exceeded ${PROVIDER_STREAM_LIMITS.toolCalls}`,
                  );
                }
                initialArguments = block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : '';
                if (initialArguments.length > PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars) {
                  throw new ProviderProtocolError(
                    'anthropic',
                    `tool arguments exceeded ${PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars} characters`,
                  );
                }
                totalToolArgumentChars = addAnthropicChars(
                  totalToolArgumentChars,
                  initialArguments.length,
                  PROVIDER_STREAM_LIMITS.toolArgumentsTotalChars,
                  'total tool arguments',
                );
              }
              pending.set(data['index'], {
                type,
                text: initialText,
                toolId: block.id ?? '',
                toolName: block.name ?? '',
                partialJson: initialArguments,
                signature: initialSignature,
                ...(block.type === 'redacted_thinking'
                  ? { type: 'thinking' as const, redactedData }
                  : {}),
              });
              break;
            }
            case 'content_block_delta': {
              const entry = pending.get(data['index']);
              const delta = data['delta'];
              if (!entry || !delta || typeof delta.type !== 'string') {
                throw new ProviderProtocolError('anthropic', `delta references unopened content block ${data['index']}`);
              }
              if (delta.type === 'text_delta') {
                if (entry.type !== 'text' || typeof delta.text !== 'string') {
                  throw new ProviderProtocolError('anthropic', 'invalid text delta');
                }
                assistantOutputChars = addAnthropicChars(
                  assistantOutputChars,
                  delta.text.length,
                  PROVIDER_STREAM_LIMITS.assistantOutputChars,
                  'assistant output',
                );
                entry.text += delta.text;
                yield { type: 'text_delta', text: delta.text };
              } else if (delta.type === 'input_json_delta') {
                if (entry.type !== 'tool_use' || typeof delta.partial_json !== 'string') {
                  throw new ProviderProtocolError('anthropic', 'invalid tool input delta');
                }
                if (
                  delta.partial_json.length >
                  PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars - entry.partialJson.length
                ) {
                  throw new ProviderProtocolError(
                    'anthropic',
                    `tool arguments exceeded ${PROVIDER_STREAM_LIMITS.toolArgumentsPerCallChars} characters`,
                  );
                }
                totalToolArgumentChars = addAnthropicChars(
                  totalToolArgumentChars,
                  delta.partial_json.length,
                  PROVIDER_STREAM_LIMITS.toolArgumentsTotalChars,
                  'total tool arguments',
                );
                entry.partialJson += delta.partial_json;
              } else if (delta.type === 'thinking_delta') {
                if (entry.type !== 'thinking' || typeof delta.thinking !== 'string') {
                  throw new ProviderProtocolError('anthropic', 'invalid thinking delta');
                }
                assistantOutputChars = addAnthropicChars(
                  assistantOutputChars,
                  delta.thinking.length,
                  PROVIDER_STREAM_LIMITS.assistantOutputChars,
                  'assistant output',
                );
                entry.text += delta.thinking;
                yield { type: 'thinking_delta', text: delta.thinking };
              } else if (delta.type === 'signature_delta') {
                if (entry.type !== 'thinking' || typeof delta.signature !== 'string') {
                  throw new ProviderProtocolError('anthropic', 'invalid thinking signature delta');
                }
                assistantOutputChars = addAnthropicChars(
                  assistantOutputChars,
                  delta.signature.length,
                  PROVIDER_STREAM_LIMITS.assistantOutputChars,
                  'assistant output',
                );
                entry.signature += delta.signature;
              } else {
                throw new ProviderProtocolError('anthropic', `unsupported content delta type ${delta.type}`);
              }
              break;
            }
            case 'content_block_stop': {
              const entry = pending.get(data['index']);
              if (!entry) {
                throw new ProviderProtocolError('anthropic', `stop references unopened content block ${data['index']}`);
              }
              pending.delete(data['index']);
              if (entry.type === 'text') {
                // empty text blocks are rejected on replay — never store one
                if (entry.text.length > 0) blocks.push({ type: 'text', text: entry.text });
              } else if (entry.type === 'thinking') {
                if (entry.redactedData === undefined && entry.signature.length === 0) {
                  throw new ProviderProtocolError('anthropic', 'thinking block completed without a signature');
                }
                blocks.push({
                  type: 'thinking',
                  thinking: entry.text,
                  signature: entry.signature,
                  ...(entry.redactedData !== undefined ? { redactedData: entry.redactedData } : {}),
                });
              } else if (entry.type === 'tool_use') {
                if (!entry.toolId || !entry.toolName) {
                  throw new ProviderProtocolError('anthropic', 'tool block completed without an id or name');
                }
                let parsed: unknown = {};
                try {
                  parsed = entry.partialJson ? JSON.parse(entry.partialJson) : {};
                } catch (error) {
                  throw new ProviderProtocolError(
                    'anthropic',
                    `tool call ${entry.toolId} has incomplete JSON arguments`,
                    { cause: error },
                  );
                }
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  throw new ProviderProtocolError(
                    'anthropic',
                    `tool call ${entry.toolId} arguments must be a JSON object`,
                  );
                }
                blocks.push({
                  type: 'toolCall',
                  id: entry.toolId,
                  name: entry.toolName,
                  arguments: parsed as Record<string, unknown>,
                });
              }
              break;
            }
            case 'message_delta': {
              const rawStopReason = data['delta']?.stop_reason;
              if (rawStopReason !== null && rawStopReason !== undefined) {
                if (typeof rawStopReason !== 'string') {
                  throw new ProviderProtocolError('anthropic', 'stop_reason was not a string');
                }
                stopReason = mapStopReason(rawStopReason);
                sawStopReason = true;
              }
              if (data['usage'] !== undefined && data['usage'] !== null) {
                const u = anthropicUsageObject(data['usage'], 'message_delta.usage');
                const outputTokens = optionalAnthropicUsageCounter(
                  'message_delta.usage.output_tokens',
                  u['output_tokens'],
                );
                if (outputTokens !== undefined) {
                  if (sawOutputUsage && outputTokens < usage.outputTokens) {
                    throw new ProviderProtocolError('anthropic', 'output token usage decreased during the stream');
                  }
                  usage.outputTokens = outputTokens;
                  sawOutputUsage = true;
                  if (rawStopReason !== null && rawStopReason !== undefined) sawFinalOutputUsage = true;
                }
              }
              break;
            }
            case 'error': {
              const type = data['error']?.type as string | undefined;
              throw new ApiError(
                `anthropic: ${type ?? 'error'}: ${data['error']?.message ?? 'stream error'}`,
                errorStatus(type),
              );
            }
            case 'message_stop':
              sawMessageStop = true;
              break;
            case 'ping':
              break;
            default:
              throw new ProviderProtocolError('anthropic', `unsupported event type ${data['type']}`);
          }
          if (sawMessageStop) break;
        }
      } catch (error) {
        if (scope.signal?.aborted) throw scope.signal.reason ?? error;
        if (error instanceof SSELimitError) {
          throw new ProviderProtocolError('anthropic', error.message, { cause: error });
        }
        if (
          error instanceof Error &&
          !(error instanceof ApiError) &&
          !(error instanceof ProviderProtocolError) &&
          !(error instanceof ProviderTransportError)
        ) {
          throw new ProviderTransportError('anthropic', error.message, { cause: error });
        }
        throw error;
      }

      if (scope.signal?.aborted) throw scope.signal.reason ?? new Error('aborted');
      if (!sawMessageStart) throw new ProviderProtocolError('anthropic', 'stream ended without message_start');
      if (!sawMessageStop) throw new ProviderProtocolError('anthropic', 'stream ended before message_stop');
      if (!sawStopReason) throw new ProviderProtocolError('anthropic', 'stream ended without a stop_reason');
      if (!sawFinalOutputUsage) {
        throw new ProviderProtocolError('anthropic', 'stream ended without message_delta.usage.output_tokens');
      }
      if (pending.size > 0) {
        throw new ProviderProtocolError('anthropic', 'message stopped with unfinished content blocks');
      }

      const calls = blocks.filter((block): block is ToolCallBlock => block.type === 'toolCall');
      const seenToolCallIds = new Set<string>();
      for (const call of calls) {
        if (seenToolCallIds.has(call.id)) {
          throw new ProviderProtocolError('anthropic', `duplicate tool call id ${call.id}`);
        }
        seenToolCallIds.add(call.id);
      }
      if (calls.length > 0 && stopReason !== 'tool_use') {
        throw new ProviderProtocolError('anthropic', `received tool calls with stop reason ${stopReason}`);
      }
      if (calls.length === 0 && stopReason === 'tool_use') {
        throw new ProviderProtocolError('anthropic', 'stop_reason announced tool calls but none were completed');
      }
      for (const call of calls) yield { type: 'tool_call', call };

      const message: AssistantMessage = { role: 'assistant', content: blocks };
      yield { type: 'done', message, stopReason, usage };
    } finally {
      scope.cleanup();
    }
  }
}
