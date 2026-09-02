/**
 * The tool worker: piko's own tool implementations, started as a child process
 * inside an operating-system sandbox and driven over newline-delimited JSON on
 * stdio (ADR 0018 amendments R0-1 and R0-2).
 *
 * Everything in this file runs inside the boundary. Nothing here holds a
 * provider credential, opens a session journal, or decides policy: the control
 * plane stays in the parent process and this end only performs effects.
 *
 * The process writes exactly one thing to stdout, the protocol stream, so the
 * parent can parse it without heuristics. Diagnostics go to stderr.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { bashTool } from '../tools/bash.js';
import { editTool } from '../tools/edit.js';
import { mapTool } from '../tools/map.js';
import { readTool } from '../tools/read.js';
import { writeTool } from '../tools/write.js';
import type { Tool, ToolContext, ToolPolicyObservation } from '../tools/types.js';
import { CONTAINMENT_BARRIER_FLAG, installContainmentBarrierChannel } from './containment-barrier.js';
import {
  encodeMessage,
  NewlineDelimitedJsonReader,
  WORKER_PROTOCOL_VERSION,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js';
import type { SandboxSelfTestChecks } from './types.js';

// ADR 0022's test-only barrier bridge, and the whole of its production cost:
// one boolean check at startup. The flag can only come from the acquire spec,
// never from the environment, and the shipped CLI path never sets it.
if (process.argv.includes(CONTAINMENT_BARRIER_FLAG)) installContainmentBarrierChannel();

const toolsByName = new Map<string, Tool>(
  [readTool, writeTool, editTool, mapTool, bashTool].map((tool) => [tool.name, tool]),
);

/** How long the network probe waits before calling a silent socket a failure. */
const NETWORK_PROBE_TIMEOUT_MS = 2_000;

const inFlight = new Map<number, AbortController>();

function send(message: WorkerResponse): void {
  process.stdout.write(encodeMessage(message));
}

/**
 * The three acquire-time checks, run inside the sandbox because that is the
 * only place they mean anything. Each one is written so that any failure to
 * perform the forbidden action counts as a pass, and only an unambiguous
 * success counts as a failure.
 */
async function runSelfTest(canaryPath: string, probePort: number, markerName: string): Promise<SandboxSelfTestChecks> {
  let canaryReadRefused = true;
  let canaryDetail = 'read refused';
  try {
    const bytes = readFileSync(canaryPath);
    canaryReadRefused = false;
    canaryDetail = `read ${bytes.length} bytes from ${canaryPath}`;
  } catch (error) {
    canaryDetail = `${canaryPath}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`;
  }

  const network = await new Promise<{ refused: boolean; detail: string }>((resolveProbe) => {
    let settled = false;
    const settle = (refused: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({ refused, detail });
    };
    const socket = connect({ host: '127.0.0.1', port: probePort });
    socket.setTimeout(NETWORK_PROBE_TIMEOUT_MS);
    socket.on('connect', () => settle(false, `connected to 127.0.0.1:${probePort}`));
    socket.on('timeout', () => settle(true, `127.0.0.1:${probePort}: timed out`));
    socket.on('error', (error) =>
      settle(true, `127.0.0.1:${probePort}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`),
    );
  });

  const markerValue = process.env[markerName];
  return {
    canaryReadRefused,
    canaryDetail,
    networkConnectRefused: network.refused,
    networkDetail: network.detail,
    parentMarkerAbsent: markerValue === undefined,
    // The value never leaves the worker: reporting it would defeat the check.
    markerDetail: markerValue === undefined ? `${markerName} is absent` : `${markerName} is present`,
  };
}

async function runCall(message: Extract<WorkerRequest, { kind: 'call' }>): Promise<void> {
  const tool = toolsByName.get(message.tool);
  if (!tool) {
    send({ kind: 'failure', id: message.id, error: `sandbox worker cannot run tool "${message.tool}"` });
    return;
  }
  const controller = new AbortController();
  inFlight.set(message.id, controller);
  let workingDirectory = message.cwd;
  const observations: ToolPolicyObservation[] = [];
  const context: ToolContext = {
    get cwd() {
      return workingDirectory;
    },
    setCwd(next: string) {
      workingDirectory = next;
    },
    policy: message.policy,
    signal: controller.signal,
    // Telemetry lives in the parent, so the worker only records what it saw and
    // the parent replays it through its own observer.
    observePolicy: (observation) => {
      observations.push(observation);
    },
  };
  try {
    const result = await tool.execute(message.arguments, context);
    send({ kind: 'result', id: message.id, result, cwd: workingDirectory, observations });
  } catch (error) {
    send({ kind: 'failure', id: message.id, error: String(error) });
  } finally {
    inFlight.delete(message.id);
  }
}

async function handle(message: WorkerRequest): Promise<void> {
  switch (message.kind) {
    case 'call':
      await runCall(message);
      return;
    case 'cancel':
      inFlight.get(message.id)?.abort(new Error('canceled by the parent process'));
      return;
    case 'selftest': {
      const checks = await runSelfTest(message.canaryPath, message.probePort, message.markerName);
      send({ kind: 'selftest_result', id: message.id, checks });
      return;
    }
  }
}

const reader = new NewlineDelimitedJsonReader();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  let lines: string[];
  try {
    lines = reader.push(chunk);
  } catch (error) {
    process.stderr.write(`sandbox worker: ${String(error)}\n`);
    process.exit(1);
  }
  for (const line of lines) {
    let message: WorkerRequest;
    try {
      message = JSON.parse(line) as WorkerRequest;
    } catch (error) {
      process.stderr.write(`sandbox worker: unparseable request (${String(error)})\n`);
      continue;
    }
    void handle(message);
  }
});
// A closed stdin means the parent is gone; there is nobody left to answer.
process.stdin.on('end', () => process.exit(0));

send({ kind: 'ready', protocol: WORKER_PROTOCOL_VERSION, pid: process.pid, cwd: process.cwd() });
