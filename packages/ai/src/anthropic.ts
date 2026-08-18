import { sseEvents } from './sse.js';
import {
  ApiError,
  emptyUsage,
  type AssistantBlock,
  type AssistantMessage,
  type CompletionRequest,
  type Message,
  type Provider,
  type StopReason,
  type StreamEvent,
  type ToolCallBlock,
  type Usage,
} from './types.js';

const ANTHROPIC_VERSION = '2023-06-01';
const CACHE_CONTROL = { cache_control: { type: 'ephemeral' } };
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
export function buildAnthropicBody(request: CompletionRequest): Record<string, unknown> {
  const messages = mergeAdjacent(request.messages);
  const last = messages[messages.length - 1];
  const lastBlock = last?.content[last.content.length - 1];
  if (lastBlock) Object.assign(lastBlock, CACHE_CONTROL);

  const thinking = request.thinkingBudget !== undefined && request.thinkingBudget > 0;
  let maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (thinking && maxTokens <= request.thinkingBudget!) maxTokens = request.thinkingBudget! + 4096;

  return {
    model: request.model,
    max_tokens: maxTokens,
    // extended thinking requires temperature 1 (the default) — omit it entirely
    ...(request.temperature !== undefined && !thinking ? { temperature: request.temperature } : {}),
    ...(thinking ? { thinking: { type: 'enabled', budget_tokens: request.thinkingBudget } } : {}),
    system: [{ type: 'text', text: request.system, ...CACHE_CONTROL }],
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
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

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(buildAnthropicBody(request)),
      signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        `anthropic: HTTP ${response.status}`,
        response.status,
        body,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }

    const usage: Usage = emptyUsage();
    const blocks: AssistantBlock[] = [];
    const pending = new Map<number, PendingBlock>();
    let stopReason: StopReason = 'other';

    for await (const event of sseEvents(response.body, signal)) {
      if (!event.data.trim()) continue; // keepalive/comment filler from proxies
      let data: Record<string, any>;
      try {
        data = JSON.parse(event.data) as Record<string, any>;
      } catch {
        continue; // garbage data line — skip rather than kill (and re-bill) the stream
      }
      switch (data['type']) {
        case 'message_start': {
          const u = data['message']?.usage ?? {};
          usage.inputTokens = u.input_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const block = data['content_block'];
          if (!block) break;
          const type =
            block.type === 'text' || block.type === 'tool_use' || block.type === 'thinking' ? block.type : 'other';
          pending.set(data['index'], {
            type,
            text: '',
            toolId: block.id ?? '',
            toolName: block.name ?? '',
            partialJson: '',
            signature: '',
            ...(block.type === 'redacted_thinking' ? { type: 'thinking' as const, redactedData: block.data ?? '' } : {}),
          });
          break;
        }
        case 'content_block_delta': {
          const entry = pending.get(data['index']);
          const delta = data['delta'];
          if (!entry || !delta) break;
          if (delta.type === 'text_delta') {
            entry.text += delta.text;
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            entry.partialJson += delta.partial_json;
          } else if (delta.type === 'thinking_delta') {
            entry.text += delta.thinking;
            yield { type: 'thinking_delta', text: delta.thinking };
          } else if (delta.type === 'signature_delta') {
            entry.signature += delta.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const entry = pending.get(data['index']);
          if (!entry) break;
          pending.delete(data['index']);
          if (entry.type === 'text') {
            // empty text blocks are rejected on replay — never store one
            if (entry.text.length > 0) blocks.push({ type: 'text', text: entry.text });
          } else if (entry.type === 'thinking') {
            blocks.push({
              type: 'thinking',
              thinking: entry.text,
              signature: entry.signature,
              ...(entry.redactedData !== undefined ? { redactedData: entry.redactedData } : {}),
            });
          } else if (entry.type === 'tool_use') {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = entry.partialJson ? (JSON.parse(entry.partialJson) as Record<string, unknown>) : {};
            } catch {
              parsed = { __raw: entry.partialJson }; // truncated by max_tokens mid-arguments
            }
            const call: ToolCallBlock = { type: 'toolCall', id: entry.toolId, name: entry.toolName, arguments: parsed };
            blocks.push(call);
            yield { type: 'tool_call', call };
          }
          break;
        }
        case 'message_delta': {
          stopReason = mapStopReason(data['delta']?.stop_reason);
          usage.outputTokens = data['usage']?.output_tokens ?? usage.outputTokens;
          break;
        }
        case 'error': {
          const type = data['error']?.type as string | undefined;
          throw new ApiError(`anthropic: ${type ?? 'error'}: ${data['error']?.message ?? 'stream error'}`, errorStatus(type));
        }
        case 'message_stop':
        case 'ping':
          break;
      }
    }

    const message: AssistantMessage = { role: 'assistant', content: blocks };
    yield { type: 'done', message, stopReason, usage };
  }
}
