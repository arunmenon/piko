export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  mimeType: string;
  /** base64-encoded image data */
  data: string;
}

export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** Anthropic signature — must be replayed verbatim when tools are used with extended thinking */
  signature: string;
  /** present for redacted_thinking blocks, replayed verbatim */
  redactedData?: string;
}

export interface ToolResultBlock {
  type: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextBlock | ImageBlock)[];
  isError?: boolean;
}

export type UserBlock = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantBlock = TextBlock | ToolCallBlock | ThinkingBlock;

export interface UserMessage {
  role: 'user';
  content: UserBlock[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: AssistantBlock[];
}

export type Message = UserMessage | AssistantMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments */
  parameters: Record<string, unknown>;
}

export interface Usage {
  /** uncached input tokens (cache reads/writes are reported separately on every provider) */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: Usage, delta: Usage): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; call: ToolCallBlock }
  | { type: 'done'; message: AssistantMessage; stopReason: StopReason; usage: Usage };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** extended-thinking budget in tokens (Anthropic only; ignored elsewhere) */
  thinkingBudget?: number;
}

export interface Provider {
  readonly name: string;
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get retryable(): boolean {
    if (this.status === undefined) return true; // network-level failure
    return this.status === 429 || this.status >= 500;
  }
}
