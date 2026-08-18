export interface SSEEvent {
  event?: string;
  data: string;
}

/** Incremental server-sent-events parser. Feed raw text chunks, get complete events. */
export class SSEParser {
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];

  push(chunk: string): SSEEvent[] {
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
      } else if (line.startsWith('event:')) {
        this.eventName = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice(5).trimStart());
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
    return [event];
  }
}

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, void> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.flush();
  } finally {
    // cancel (not just releaseLock) so an aborted/early-exited turn doesn't leak the connection
    await reader.cancel().catch(() => {});
  }
}
