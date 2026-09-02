import type { ToolOutput, ToolPolicyObservation } from '../tools/types.js';
import type { SandboxSelfTestChecks, SandboxToolPolicy } from './types.js';

/**
 * Wire version of the parent/worker conversation. The parent refuses a worker
 * that announces a different number rather than guessing what it can do.
 */
export const WORKER_PROTOCOL_VERSION = 1;

/** First line the worker writes: it is up, and this is where it started. */
export interface WorkerReadyMessage {
  readonly kind: 'ready';
  readonly protocol: number;
  readonly pid: number;
  readonly cwd: string;
}

/** Run one tool inside the sandbox. */
export interface WorkerCallMessage {
  readonly kind: 'call';
  readonly id: number;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly policy: SandboxToolPolicy;
  readonly cwd: string;
}

/** Ask the worker to abandon an in-flight call because the turn was canceled. */
export interface WorkerCancelMessage {
  readonly kind: 'cancel';
  readonly id: number;
}

/** Prove, from inside, that the boundary is real. */
export interface WorkerSelfTestMessage {
  readonly kind: 'selftest';
  readonly id: number;
  /** A file the parent created outside the workspace. */
  readonly canaryPath: string;
  /** Loopback port of a listener the parent opened. */
  readonly probePort: number;
  /** Name of a variable the parent set in its own environment. */
  readonly markerName: string;
}

export interface WorkerResultMessage {
  readonly kind: 'result';
  readonly id: number;
  readonly result: ToolOutput;
  readonly cwd: string;
  readonly observations: readonly ToolPolicyObservation[];
}

export interface WorkerSelfTestResultMessage {
  readonly kind: 'selftest_result';
  readonly id: number;
  readonly checks: SandboxSelfTestChecks;
}

export interface WorkerFailureMessage {
  readonly kind: 'failure';
  readonly id: number;
  readonly error: string;
}

export type WorkerRequest = WorkerCallMessage | WorkerCancelMessage | WorkerSelfTestMessage;
export type WorkerResponse =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerSelfTestResultMessage
  | WorkerFailureMessage;

/**
 * Longest single protocol line either side will accept. Tool output is already
 * bounded well below this by the tools themselves; the cap exists so a worker
 * that goes wrong cannot make the parent buffer without limit.
 */
export const MAX_PROTOCOL_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Newline-delimited JSON reader. Feed it chunks; it returns the complete lines
 * those chunks closed. It throws when a single line passes the cap, which the
 * caller turns into a dead worker rather than an unbounded buffer.
 */
export class NewlineDelimitedJsonReader {
  private buffered = '';

  push(chunk: string): string[] {
    this.buffered += chunk;
    if (this.buffered.length > MAX_PROTOCOL_LINE_BYTES) {
      this.buffered = '';
      throw new Error(`sandbox worker protocol line exceeded ${MAX_PROTOCOL_LINE_BYTES} bytes`);
    }
    const lines: string[] = [];
    let newlineAt = this.buffered.indexOf('\n');
    while (newlineAt !== -1) {
      const line = this.buffered.slice(0, newlineAt);
      this.buffered = this.buffered.slice(newlineAt + 1);
      if (line.trim().length > 0) lines.push(line);
      newlineAt = this.buffered.indexOf('\n');
    }
    return lines;
  }
}

/** Encode one message as a protocol line. */
export function encodeMessage(message: WorkerRequest | WorkerResponse): string {
  return `${JSON.stringify(message)}\n`;
}
