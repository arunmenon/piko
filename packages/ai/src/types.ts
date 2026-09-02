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
  /**
   * Set to 'none' to forbid tool use for one request while still sending the
   * tool list. Dropping the tools instead would change the cached prefix, so a
   * request that must not call tools (the compaction summarizer) keeps the
   * prefix byte-identical and disables the tools here.
   */
  toolChoice?: 'none';
  /** extended-thinking budget in tokens (Anthropic only; ignored elsewhere) */
  thinkingBudget?: number;
  /**
   * Wall-clock deadline for this completion, including retries and streaming.
   * A timeout rejects with {@link RequestTimeoutError}; it is never reported as
   * a successful or retryable completion.
   */
  timeoutMs?: number;
  /**
   * Maximum provider HTTP attempts for this logical completion. The client
   * validates this value and clamps it to its configured retry bound.
   */
  maxAttempts?: number;
}

/**
 * Internal per-attempt signal used by retrying clients. Bundled providers mark
 * it as soon as they receive a successful HTTP response with a body, before the
 * first body read, so a possibly billed/side-effecting generation is never replayed.
 */
export interface ProviderAttemptActivity {
  markResponseActivity(): void;
}

export interface Provider {
  readonly name: string;
  stream(
    request: CompletionRequest,
    signal?: AbortSignal,
    attemptActivity?: ProviderAttemptActivity,
  ): AsyncGenerator<StreamEvent, void, void>;
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

/** The provider returned a syntactically or structurally invalid stream. */
export class ProviderProtocolError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${provider}: protocol error: ${message}`, options);
    this.name = 'ProviderProtocolError';
  }
}

/** The HTTP connection failed before the provider produced a valid terminal event. */
export class ProviderTransportError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${provider}: transport error: ${message}`, options);
    this.name = 'ProviderTransportError';
  }
}

/** The completion exceeded its configured wall-clock deadline. */
export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`completion timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** Reads one provider-reported token counter without allowing coercion or precision loss. */
export function readUsageCounter(provider: string, field: string, value: unknown): number {
  if (value === undefined || value === null) {
    throw new ProviderProtocolError(provider, `missing required usage counter ${field}`);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderProtocolError(provider, `usage counter ${field} must be a finite nonnegative integer`);
  }
  return value;
}

/** Validates every token-shaped counter in a provider usage object, including nested detail fields. */
export function validateUsageCounters(provider: string, value: unknown, path = 'usage'): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderProtocolError(provider, `${path} must be an object`);
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key.endsWith('_tokens') && child !== undefined && child !== null) {
      readUsageCounter(provider, childPath, child);
    } else if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      validateUsageCounters(provider, child, childPath);
    }
  }
}
