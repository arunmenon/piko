import { RequestTimeoutError } from './types.js';

/** Hard memory-safety ceilings for untrusted provider responses. Character
 * limits are used because the parser and accumulators store JavaScript strings. */
export const PROVIDER_STREAM_LIMITS = Object.freeze({
  sseBufferChars: 2 * 1024 * 1024 + 64 * 1024,
  sseEventDataChars: 2 * 1024 * 1024,
  sseEvents: 50_000,
  errorBodyChars: 64 * 1024,
  assistantOutputChars: 4 * 1024 * 1024,
  toolArgumentsPerCallChars: 1024 * 1024,
  toolArgumentsTotalChars: 4 * 1024 * 1024,
  toolIdentifierChars: 4096,
  toolCalls: 512,
  contentBlocks: 2048,
});

export interface SSELimits {
  maxBufferChars: number;
  maxEventDataChars: number;
  maxEvents: number;
}

const DEFAULT_SSE_LIMITS: SSELimits = {
  maxBufferChars: PROVIDER_STREAM_LIMITS.sseBufferChars,
  maxEventDataChars: PROVIDER_STREAM_LIMITS.sseEventDataChars,
  maxEvents: PROVIDER_STREAM_LIMITS.sseEvents,
};

export class SSELimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSELimitError';
  }
}

export interface SSEEvent {
  event?: string;
  data: string;
}

export interface RequestSignalScope {
  readonly signal?: AbortSignal;
  readonly timedOut: boolean;
  cleanup(): void;
}

/** Combines a caller cancellation signal with a wall-clock request deadline. */
export function createRequestSignalScope(parent?: AbortSignal, timeoutMs?: number): RequestSignalScope {
  if (timeoutMs === undefined) {
    return { signal: parent, timedOut: false, cleanup() {} };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs must be a timer-safe integer in 1..2147483647');
  }

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parent?.reason ?? new Error('aborted'));
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new RequestTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Incremental server-sent-events parser. Feed raw text chunks, get complete events. */
export class SSEParser {
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];
  private dataChars = 0;

  constructor(private readonly limits: SSELimits = DEFAULT_SSE_LIMITS) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
  }

  push(chunk: string): SSEEvent[] {
    if (chunk.length > this.limits.maxBufferChars - this.buffer.length) {
      throw new SSELimitError(`SSE parser buffer exceeded ${this.limits.maxBufferChars} characters`);
    }
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.dataLines.length > 0) {
          events.push({ event: this.eventName, data: this.dataLines.join('\n') });
        }
        this.eventName = undefined;
        this.dataLines = [];
        this.dataChars = 0;
      } else if (line.startsWith('event:')) {
        this.eventName = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).trimStart();
        const added = value.length + (this.dataLines.length > 0 ? 1 : 0);
        if (added > this.limits.maxEventDataChars - this.dataChars) {
          throw new SSELimitError(`SSE event data exceeded ${this.limits.maxEventDataChars} characters`);
        }
        this.dataLines.push(value);
        this.dataChars += added;
      }
      // comments (:) and other fields are ignored
    }
    return events;
  }

  /** Emits a final event left unterminated by a truncated stream (no trailing blank line). */
  flush(): SSEEvent[] {
    if (this.dataLines.length === 0) return [];
    const event: SSEEvent = { event: this.eventName, data: this.dataLines.join('\n') };
    this.eventName = undefined;
    this.dataLines = [];
    this.dataChars = 0;
    return [event];
  }
}

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limits: SSELimits = DEFAULT_SSE_LIMITS,
  /** Called synchronously on the first nonempty raw response chunk, before parsing. */
  onResponseBytes?: () => void,
): AsyncGenerator<SSEEvent, void, void> {
  const parser = new SSEParser(limits);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let eventCount = 0;
  let responseBytesReported = false;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
      if (done) break;
      if (value.byteLength > 0 && !responseBytesReported) {
        responseBytesReported = true;
        onResponseBytes?.();
      }
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (++eventCount > limits.maxEvents) throw new SSELimitError(`SSE event count exceeded ${limits.maxEvents}`);
        yield event;
      }
    }
    for (const event of parser.push(decoder.decode())) {
      if (++eventCount > limits.maxEvents) throw new SSELimitError(`SSE event count exceeded ${limits.maxEvents}`);
      yield event;
    }
    for (const event of parser.flush()) {
      if (++eventCount > limits.maxEvents) throw new SSELimitError(`SSE event count exceeded ${limits.maxEvents}`);
      yield event;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    // Do not await cancellation: a hostile/custom stream can return a promise
    // that never settles, which must not hold timeout completion hostage.
    void reader.cancel().catch(() => {});
  }
}

/** Reads at most maxChars from an HTTP error body and cancels the remainder. */
export async function readTextBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  maxChars = PROVIDER_STREAM_LIMITS.errorBodyChars,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new RangeError('maxChars must be a positive integer');
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail.length > maxChars - text.length) {
          text += tail.slice(0, maxChars - text.length);
          truncated = true;
        } else {
          text += tail;
        }
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.length > maxChars - text.length) {
        text += chunk.slice(0, maxChars - text.length);
        truncated = true;
        break;
      }
      text += chunk;
      if (text.length === maxChars) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
  }
  return truncated ? `${text}\n[truncated]` : text;
}
