/**
 * The containment barrier bridge: ADR 0022's test-only seam, extended across
 * the executor boundary.
 *
 * In process, a containment test registers a barrier callback and performs the
 * parent swap from inside the tool call. Through the executor the tool runs in
 * the worker, so the swap has to be performed by the test while the worker is
 * paused. This module is that pause: when, and only when, the parent asks for
 * it in the acquire spec, the worker registers a barrier at every named point
 * that writes one line naming the barrier to a dedicated file descriptor and
 * then blocks until the parent writes one line back. The test performs the swap
 * in between, on the same filesystem the worker is looking at.
 *
 * Three properties this deliberately keeps:
 *
 * - It is never enabled by the environment. The only switch is
 *   `SandboxSpec.containmentBarrierChannel`, which the shipped CLI path never
 *   sets, and which reaches the worker as an argv flag rather than as a
 *   variable the model could learn to set.
 * - Production cost is one boolean check, at worker startup, not per barrier.
 *   Without the flag nothing is registered and `containmentBarriers` stays the
 *   empty map it is today.
 * - The channel carries no data other than the barrier name and the path the
 *   implementation is about to act on, and the acknowledgement is one line. It
 *   is a pause, not a control channel: it cannot change a result.
 */
import { fstatSync, readSync, writeSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { containmentBarriers, CONTAINMENT_BARRIER_NAMES, type ContainmentBarrierName } from '../tools/filesystem.js';

/**
 * The extra descriptor the worker speaks the barrier protocol on. Standard
 * input and output already carry the tool protocol, and standard error is a
 * diagnostic stream the parent keeps only a bounded tail of, so the bridge gets
 * a descriptor of its own.
 */
export const CONTAINMENT_BARRIER_FD = 3;

/** The argv flag that turns the worker-side hook on. Absent in production. */
export const CONTAINMENT_BARRIER_FLAG = '--containment-barrier-channel';

/** What the worker announces when it reaches a barrier. */
export interface ContainmentBarrierEvent {
  readonly barrier: ContainmentBarrierName;
  /** The path the next step of the implementation is about to act on. */
  readonly path: string;
}

/** The single byte sequence the parent writes back to release a paused worker. */
export const CONTAINMENT_BARRIER_ACKNOWLEDGEMENT = 'go\n';

/** How long a paused worker waits for the parent before giving up entirely. */
export const CONTAINMENT_BARRIER_TIMEOUT_MS = 60_000;

/** How long each unsuccessful read sleeps for, if the descriptor is non-blocking. */
const ACKNOWLEDGEMENT_POLL_SLICE_MS = 2;

export function encodeContainmentBarrierEvent(event: ContainmentBarrierEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseContainmentBarrierEvent(line: string): ContainmentBarrierEvent {
  const parsed = JSON.parse(line) as Partial<ContainmentBarrierEvent>;
  if (typeof parsed.barrier !== 'string' || typeof parsed.path !== 'string') {
    throw new Error(`a containment barrier line is missing its barrier or path: ${line}`);
  }
  return { barrier: parsed.barrier as ContainmentBarrierName, path: parsed.path };
}

/**
 * Block until one line arrives on the barrier descriptor. The descriptor the
 * parent hands the worker is a blocking one, so the usual path is a single
 * `readSync` that sleeps in the kernel. The `EAGAIN` branch exists because a
 * non-blocking descriptor is a legal thing to be handed and busy-failing would
 * turn the pause into a spin: it waits, it does not race anything.
 */
function awaitAcknowledgement(fileDescriptor: number): void {
  const chunk = Buffer.alloc(256);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + CONTAINMENT_BARRIER_TIMEOUT_MS;
  let received = '';
  while (!received.includes('\n')) {
    if (Date.now() > deadline) {
      throw new Error(`no containment barrier acknowledgement within ${CONTAINMENT_BARRIER_TIMEOUT_MS}ms`);
    }
    let bytesRead: number;
    try {
      bytesRead = readSync(fileDescriptor, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        Atomics.wait(sleeper, 0, 0, ACKNOWLEDGEMENT_POLL_SLICE_MS);
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) throw new Error('the containment barrier channel closed before the acknowledgement arrived');
    received += chunk.subarray(0, bytesRead).toString('utf8');
  }
}

/**
 * Worker side. Registers a pausing barrier at every named point, so the parent
 * decides which one matters and releases the rest untouched. Called once, at
 * worker startup, only when the argv flag is present.
 */
export function installContainmentBarrierChannel(fileDescriptor: number = CONTAINMENT_BARRIER_FD): void {
  // Fail at startup with a legible reason rather than at the first barrier with
  // a hang: a sandbox launcher that does not pass the descriptor through is a
  // plausible way for this bridge to be unavailable on a platform.
  try {
    fstatSync(fileDescriptor);
  } catch (error) {
    throw new Error(
      `the containment barrier channel is not open on descriptor ${fileDescriptor}: ${String(error)}`,
    );
  }
  for (const barrierName of CONTAINMENT_BARRIER_NAMES) {
    containmentBarriers.set(barrierName, (path: string) => {
      writeSync(fileDescriptor, encodeContainmentBarrierEvent({ barrier: barrierName, path }));
      awaitAcknowledgement(fileDescriptor);
    });
  }
}

/**
 * Parent side. Reads the worker's barrier announcements, runs the test's
 * handler while the worker is still paused, and then releases it. Announcements
 * are handled strictly one at a time: the worker is single-threaded and cannot
 * reach a second barrier before the first is released.
 */
export class ContainmentBarrierChannel {
  private buffered = '';
  private handler: ((event: ContainmentBarrierEvent) => void | Promise<void>) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly seen: ContainmentBarrierEvent[] = [];
  private handlerError: unknown;

  constructor(private readonly stream: Duplex) {
    this.stream.setEncoding('utf8');
    this.stream.on('data', (chunk: string) => this.onData(chunk));
    // A paused worker must not be what keeps the parent's event loop alive.
    (this.stream as unknown as { unref?: () => void }).unref?.();
  }

  /** Every barrier the worker reached, in order, for diagnostics in a test. */
  get barriersReached(): readonly ContainmentBarrierEvent[] {
    return this.seen;
  }

  /** Whatever the handler threw, so a test can fail on it instead of hanging. */
  get failure(): unknown {
    return this.handlerError;
  }

  /**
   * Install the handler run at each barrier while the worker is paused. It is
   * awaited before the worker is released, so a swap performed here is in place
   * for the very next step the implementation takes.
   */
  onBarrier(handler: (event: ContainmentBarrierEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  private onData(chunk: string): void {
    this.buffered += chunk;
    let newlineAt = this.buffered.indexOf('\n');
    while (newlineAt !== -1) {
      const line = this.buffered.slice(0, newlineAt);
      this.buffered = this.buffered.slice(newlineAt + 1);
      if (line.trim().length > 0) this.enqueue(line);
      newlineAt = this.buffered.indexOf('\n');
    }
  }

  private enqueue(line: string): void {
    this.queue = this.queue.then(async () => {
      let event: ContainmentBarrierEvent;
      try {
        event = parseContainmentBarrierEvent(line);
      } catch (error) {
        this.handlerError ??= error;
        this.release();
        return;
      }
      this.seen.push(event);
      try {
        await this.handler?.(event);
      } catch (error) {
        // Record and release anyway: a worker left paused would hang the test
        // rather than fail it, and a hung test says nothing about containment.
        this.handlerError ??= error;
      }
      this.release();
    });
  }

  private release(): void {
    try {
      this.stream.write(CONTAINMENT_BARRIER_ACKNOWLEDGEMENT);
    } catch (error) {
      this.handlerError ??= error;
    }
  }
}
