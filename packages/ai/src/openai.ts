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

/** Works with any OpenAI-compatible endpoint: OpenAI, Qwen, Moonshot/Kimi, DeepSeek, OpenRouter, vLLM, llama.cpp. */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(buildOpenAIBody(request)),
      signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ApiError(
        `openai: HTTP ${response.status}`,
        response.status,
        body,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }

    const usage: Usage = emptyUsage();
    let text = '';
    const toolCalls: PendingToolCall[] = [];
    const slotByIndex = new Map<number, PendingToolCall>();
    let stopReason: StopReason = 'end_turn';

    for await (const event of sseEvents(response.body, signal)) {
      const raw = event.data.trim();
      if (!raw) continue;
      if (raw === '[DONE]') break;
      let data: Record<string, any>;
      try {
        data = JSON.parse(raw) as Record<string, any>;
      } catch {
        continue; // garbage/keepalive data line
      }
      if (data['usage']) {
        const cached =
          data['usage'].prompt_tokens_details?.cached_tokens ?? data['usage'].prompt_cache_hit_tokens ?? 0;
        // normalize to Anthropic semantics: inputTokens excludes cache reads
        usage.inputTokens = Math.max(0, (data['usage'].prompt_tokens ?? 0) - cached);
        usage.outputTokens = data['usage'].completion_tokens ?? 0;
        usage.cacheReadTokens = cached;
      }
      const choice = data['choices']?.[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
        text += delta.refusal; // surface refusals instead of ending the turn with empty output
        yield { type: 'text_delta', text: delta.refusal };
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        yield { type: 'thinking_delta', text: delta.reasoning_content };
      }
      for (const part of delta.tool_calls ?? []) {
        let entry = typeof part.index === 'number' ? slotByIndex.get(part.index) : toolCalls[toolCalls.length - 1];
        // no index (or a fresh id on the last slot) starts a new call rather than corrupting the previous one
        if (!entry || (part.id && entry.id && part.id !== entry.id)) {
          entry = { id: '', name: '', argumentsJson: '' };
          toolCalls.push(entry);
          if (typeof part.index === 'number') slotByIndex.set(part.index, entry);
        }
        if (part.id) entry.id = part.id;
        if (part.function?.name && !entry.name) entry.name = part.function.name;
        if (part.function?.arguments) entry.argumentsJson += part.function.arguments;
      }
    }

    const blocks: AssistantBlock[] = [];
    if (text.length > 0) blocks.push({ type: 'text', text });
    for (const [index, entry] of toolCalls.entries()) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = entry.argumentsJson ? (JSON.parse(entry.argumentsJson) as Record<string, unknown>) : {};
      } catch {
        parsed = { __raw: entry.argumentsJson };
      }
      const call: ToolCallBlock = {
        type: 'toolCall',
        id: entry.id || `call_${index}`,
        name: entry.name,
        arguments: parsed,
      };
      blocks.push(call);
      yield { type: 'tool_call', call };
    }
    if (toolCalls.length > 0 && stopReason === 'end_turn') stopReason = 'tool_use';

    const message: AssistantMessage = { role: 'assistant', content: blocks };
    yield { type: 'done', message, stopReason, usage };
  }
}
