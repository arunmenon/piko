import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { Profile } from './config.js';
import { createRequestSignalScope } from './sse.js';
import {
  ApiError,
  ProviderTransportError,
  type CompletionRequest,
  type Provider,
  type StreamEvent,
} from './types.js';

export interface RetryPolicy {
  readonly defaultAttempts: number;
  readonly maxAttempts: number;
  readonly backoffMs: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  defaultAttempts: 3,
  maxAttempts: 3,
  backoffMs: Object.freeze([1000, 2000, 4000] as const),
});

export interface LLMClientOptions {
  /** Attempts used when CompletionRequest.maxAttempts is absent. */
  retryDefaultAttempts?: number;
  /** Trusted client-side ceiling that requests cannot increase. */
  retryMaxAttempts?: number;
  /** Delay before retry 2, retry 3, and so on. Primarily useful for embedding/tests. */
  retryBackoffMs?: readonly number[];
}

function positiveAttemptCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a safe integer >= 1`);
  return value;
}

/** Resolves request intent against the trusted client default and upper bound. */
export function resolveMaxAttempts(
  requested: number | undefined,
  configuredDefault: number = DEFAULT_RETRY_POLICY.defaultAttempts,
  configuredBound: number = DEFAULT_RETRY_POLICY.maxAttempts,
): number {
  const fallback = positiveAttemptCount(configuredDefault, 'retryDefaultAttempts');
  const bound = positiveAttemptCount(configuredBound, 'retryMaxAttempts');
  const desired =
    requested === undefined ? fallback : positiveAttemptCount(requested, 'CompletionRequest.maxAttempts');
  return Math.min(desired, bound);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function providerFor(profile: Profile): Provider {
  if (profile.provider === 'anthropic') {
    return new AnthropicProvider(profile.apiKey, profile.baseUrl ?? 'https://api.anthropic.com');
  }
  return new OpenAIProvider(profile.apiKey, profile.baseUrl ?? 'https://api.openai.com/v1');
}

/**
 * Streams a completion with retries. A request is only retried if it failed before
 * a successful response with a body or any public events. Bundled adapters buffer
 * tool calls until terminal validation, so public-yield tracking alone is not a safe
 * boundary.
 */
export class LLMClient {
  private readonly provider: Provider;
  private readonly retryDefaultAttempts: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBackoffMs: readonly number[];

  constructor(readonly profile: Profile, options: LLMClientOptions = {}) {
    this.provider = providerFor(profile);
    this.retryDefaultAttempts = options.retryDefaultAttempts ?? DEFAULT_RETRY_POLICY.defaultAttempts;
    this.retryMaxAttempts = options.retryMaxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
    // Validate trusted configuration eagerly rather than during a billed request.
    resolveMaxAttempts(undefined, this.retryDefaultAttempts, this.retryMaxAttempts);
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_POLICY.backoffMs;
    if (
      this.retryBackoffMs.length === 0 ||
      this.retryBackoffMs.some(
        (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 2_147_483_647,
      )
    ) {
      throw new RangeError('retryBackoffMs must contain finite nonnegative timer-safe integers');
    }
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    const maxAttempts = resolveMaxAttempts(
      request.maxAttempts,
      this.retryDefaultAttempts,
      this.retryMaxAttempts,
    );
    // The deadline wraps all retries and backoff, rather than restarting for
    // every attempt. Providers also enforce timeoutMs when used directly.
    const scope = createRequestSignalScope(signal, request.timeoutMs);
    const providerRequest = { ...request, timeoutMs: undefined, maxAttempts: undefined };
    try {
      for (let attempt = 0; ; attempt++) {
        let yielded = false;
        let responseActivity = false;
        try {
          for await (const event of this.provider.stream(providerRequest, scope.signal, {
            markResponseActivity() {
              responseActivity = true;
            },
          })) {
            yielded = true;
            yield event;
          }
          return;
        } catch (error) {
          if (scope.signal?.aborted) throw scope.signal.reason ?? error;
          // Only provider-declared transport/API failures are retried. Protocol
          // failures are deterministic and must fail fast rather than re-bill.
          const retryable =
            error instanceof ApiError
              ? error.retryable
              : error instanceof ProviderTransportError || error instanceof TypeError;
          if (yielded || responseActivity || !retryable || attempt >= maxAttempts - 1) throw error;
          const retryAfterMs = error instanceof ApiError ? error.retryAfterMs : undefined;
          const configuredBackoff =
            this.retryBackoffMs[attempt] ?? this.retryBackoffMs[this.retryBackoffMs.length - 1]!;
          await sleep(Math.max(configuredBackoff, retryAfterMs ?? 0), scope.signal);
        }
      }
    } finally {
      scope.cleanup();
    }
  }
}
