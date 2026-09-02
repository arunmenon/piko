import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  encodeMessage,
  NewlineDelimitedJsonReader,
  WORKER_PROTOCOL_VERSION,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js';
import type { SandboxExecRequest, SandboxExecResult, SandboxHandle, SandboxSelfTestChecks } from './types.js';

/**
 * Which worker belongs to which handle. Providers register here on acquire, so
 * the seam stays free of process plumbing and the acquire-time self-test can
 * reach the worker without a provider-specific accessor.
 */
const workerHostsByHandle = new WeakMap<SandboxHandle, ToolWorkerHost>();

export function registerWorkerHost(handle: SandboxHandle, host: ToolWorkerHost): void {
  workerHostsByHandle.set(handle, host);
}

export function workerHostFor(handle: SandboxHandle): ToolWorkerHost | undefined {
  return workerHostsByHandle.get(handle);
}

export function forgetWorkerHost(handle: SandboxHandle): void {
  workerHostsByHandle.delete(handle);
}

/** How long the parent waits for the worker's `ready` line before giving up. */
export const WORKER_READY_TIMEOUT_MS = 15_000;

/** Bytes of worker stderr kept for diagnostics when a sandbox fails to start. */
const STDERR_TAIL_BYTES = 4 * 1024;

interface PendingRequest {
  resolve(response: WorkerResponse): void;
  reject(error: Error): void;
}

/**
 * The parent's end of one sandboxed tool worker. It owns the child process and
 * the newline-delimited JSON conversation with it, and knows nothing about how
 * the sandbox was built: bubblewrap and Seatbelt both hand it an argv.
 */
export class ToolWorkerHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader = new NewlineDelimitedJsonReader();
  private readonly pending = new Map<number, PendingRequest>();
  private stderrTail = '';
  private nextRequestId = 1;
  private exitReason: string | undefined;
  private killed = false;
  private readonly onProcessExit: () => void;

  constructor(
    readonly commandLine: readonly string[],
    private readonly options: {
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      /** Named in diagnostics so a denial says which sandbox denied it. */
      readonly providerName?: string;
      /** Runs once when the sandbox is killed, including on process exit. */
      readonly onKilled?: () => void;
    },
  ) {
    const [command, ...commandArguments] = commandLine;
    if (command === undefined) throw new Error('a sandbox command line must name a program');
    this.child = spawn(command, commandArguments, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.on('error', (error) => this.die(`sandbox worker could not start: ${String(error)}`));
    this.child.on('exit', (code, signal) =>
      this.die(`sandbox worker exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`),
    );
    // An idle sandbox must not keep the CLI alive, and must not outlive it
    // either: everything is unref'd here, the answer pipe is re-ref'd only
    // while a request is outstanding, and the exit hook kills the sandbox on
    // the way out.
    this.child.unref();
    for (const stream of [this.child.stdout, this.child.stderr, this.child.stdin]) {
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    this.onProcessExit = () => this.kill();
    process.once('exit', this.onProcessExit);
  }

  /**
   * Hold the event loop open exactly while an answer is outstanding. Without
   * this the parent, having unref'd everything so an idle sandbox costs it
   * nothing, would exit while awaiting a tool result.
   */
  private applyEventLoopHold(): void {
    const answerPipe = this.child.stdout as unknown as { ref?: () => void; unref?: () => void };
    if (this.pending.size > 0) answerPipe.ref?.();
    else answerPipe.unref?.();
  }

  private addPending(id: number, waiting: PendingRequest): void {
    this.pending.set(id, waiting);
    this.applyEventLoopHold();
  }

  private takePending(id: number): PendingRequest | undefined {
    const waiting = this.pending.get(id);
    this.pending.delete(id);
    this.applyEventLoopHold();
    return waiting;
  }

  /** Worker stderr kept for a diagnostic, bounded and never parsed. */
  get diagnostics(): string {
    return this.stderrTail.trim();
  }

  private onStdout(chunk: string): void {
    let lines: string[];
    try {
      lines = this.reader.push(chunk);
    } catch (error) {
      this.die(String(error));
      return;
    }
    for (const line of lines) {
      let message: WorkerResponse;
      try {
        message = JSON.parse(line) as WorkerResponse;
      } catch {
        this.die('sandbox worker wrote a line that is not JSON');
        return;
      }
      const waiting = this.takePending(message.kind === 'ready' ? 0 : message.id);
      waiting?.resolve(message);
    }
  }

  private die(reason: string): void {
    this.exitReason ??= reason;
    const detail = this.diagnostics ? `${reason}: ${this.diagnostics}` : reason;
    const waiters = [...this.pending.values()];
    this.pending.clear();
    this.applyEventLoopHold();
    for (const waiting of waiters) waiting.reject(new Error(detail));
  }

  /** Write one message with no reply expected. Used only for cancellation. */
  private send(message: WorkerRequest): void {
    if (this.exitReason !== undefined) return;
    try {
      this.child.stdin.write(encodeMessage(message), () => undefined);
    } catch {
      // A dead worker needs no cancel; the call it was running already failed.
    }
  }

  private request(message: WorkerRequest, timeoutMs?: number): Promise<WorkerResponse> {
    if (this.exitReason !== undefined) return Promise.reject(new Error(this.exitReason));
    return new Promise<WorkerResponse>((resolveRequest, rejectRequest) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.takePending(message.id);
              rejectRequest(new Error(`sandbox worker did not answer within ${timeoutMs}ms`));
            }, timeoutMs);
      timer?.unref();
      this.addPending(message.id, {
        resolve: (response) => {
          if (timer) clearTimeout(timer);
          resolveRequest(response);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          rejectRequest(error);
        },
      });
      this.child.stdin.write(encodeMessage(message), (error) => {
        if (error) {
          this.takePending(message.id);
          if (timer) clearTimeout(timer);
          rejectRequest(new Error(`sandbox worker stdin failed: ${String(error)}`));
        }
      });
    });
  }

  /** Wait for the handshake. Id 0 is reserved for it and is never a request id. */
  async awaitReady(timeoutMs = WORKER_READY_TIMEOUT_MS): Promise<void> {
    const ready = await new Promise<WorkerResponse>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        this.takePending(0);
        const detail = this.diagnostics ? `: ${this.diagnostics}` : '';
        rejectReady(new Error(`sandbox worker did not report ready within ${timeoutMs}ms${detail}`));
      }, timeoutMs);
      timer.unref();
      this.addPending(0, {
        resolve: (response) => {
          clearTimeout(timer);
          resolveReady(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectReady(error);
        },
      });
    });
    if (ready.kind !== 'ready') throw new Error('sandbox worker sent a result before it was ready');
    if (ready.protocol !== WORKER_PROTOCOL_VERSION) {
      throw new Error(
        `sandbox worker speaks protocol ${ready.protocol}, this piko speaks ${WORKER_PROTOCOL_VERSION}`,
      );
    }
  }

  async selfTest(input: {
    canaryPath: string;
    probePort: number;
    markerName: string;
    shellPath: string | undefined;
    timeoutMs: number;
  }): Promise<SandboxSelfTestChecks> {
    const id = this.nextRequestId++;
    const response = await this.request(
      {
        kind: 'selftest',
        id,
        canaryPath: input.canaryPath,
        probePort: input.probePort,
        markerName: input.markerName,
        shellPath: input.shellPath,
      },
      input.timeoutMs,
    );
    if (response.kind === 'failure') throw new Error(response.error);
    if (response.kind !== 'selftest_result') throw new Error('sandbox worker answered a self-test with a tool result');
    return response.checks;
  }

  async execute(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const id = this.nextRequestId++;
    // Best effort, and deliberately reply-free: the parent has already decided
    // the outcome is unknown, and this only stops the sandbox from doing more
    // work on its behalf. It shares the call's id, so it must not take the
    // call's slot in the pending map.
    const onAbort = (): void => this.send({ kind: 'cancel', id });
    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await this.request({
        kind: 'call',
        id,
        tool: request.tool,
        arguments: request.arguments,
        policy: request.policy,
        cwd: request.cwd,
      });
      if (response.kind === 'failure') throw new Error(this.describeFailure(response.error, request.tool));
      if (response.kind !== 'result') throw new Error('sandbox worker answered a tool call with a self-test result');
      return { result: response.result, cwd: response.cwd, observations: response.observations };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Turn a worker-side failure into something a reader can act on. A child
   * process the sandbox policy refuses arrives as a bare `spawn EPERM` or
   * `spawn EACCES` from node, which names neither the sandbox nor the binary;
   * said plainly it points at the profile that has to permit that executable.
   */
  private describeFailure(workerError: string, toolName: string): string {
    if (!/spawn (EPERM|EACCES)/u.test(workerError)) return workerError;
    const provider = this.options.providerName ?? 'sandbox';
    return (
      `the ${provider} sandbox refused to start a child process for the ${toolName} tool (${workerError}). ` +
      'Its policy has to permit executing that binary at its resolved path, symlinks followed.'
    );
  }

  /** Kill the sandbox. Synchronous so it is usable from a process exit hook. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    process.removeListener('exit', this.onProcessExit);
    this.die('sandbox worker was released');
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already gone
    }
    try {
      this.options.onKilled?.();
    } catch {
      // Cleanup is best effort; a temporary directory that survives is not a
      // reason to fail a release.
    }
  }
}
