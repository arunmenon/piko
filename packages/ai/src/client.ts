import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { Profile } from './config.js';
import { ApiError, type CompletionRequest, type Provider, type StreamEvent } from './types.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
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
 * yielding any event (a mid-stream failure would duplicate already-consumed output).
 */
export class LLMClient {
  private readonly provider: Provider;

  constructor(readonly profile: Profile) {
    this.provider = providerFor(profile);
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const event of this.provider.stream(request, signal)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        // only API-level retryable statuses and network failures retry — a local bug
        // (e.g. a parse error) must fail fast, not be re-billed three times
        const retryable =
          error instanceof ApiError ? error.retryable : error instanceof TypeError;
        if (yielded || !retryable || attempt >= MAX_ATTEMPTS - 1) throw error;
        const retryAfterMs = error instanceof ApiError ? error.retryAfterMs : undefined;
        await sleep(Math.max(BACKOFF_MS[attempt] ?? 4000, retryAfterMs ?? 0), signal);
      }
    }
  }
}
