import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';

export interface CliResult {
  status: number | null;
  /** The signal that killed the process, when it did not exit on its own. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningCli {
  child: ChildProcessWithoutNullStreams;
  /** Everything the process has written so far, for tests that must wait on output. */
  readOutput: () => { stdout: string; stderr: string };
  /** Resolves once the process has closed and both streams have been drained. */
  result: Promise<CliResult>;
}

/**
 * Start the CLI and hand back the live process, so a test can signal it while
 * it runs. `keepStdinOpen` leaves the pipe open after the input is written,
 * which is what an interactive REPL needs to stay at its prompt.
 */
export function spawnCli(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; keepStdinOpen?: boolean },
): RunningCli {
  const wantsStdin = options.input !== undefined || options.keepStdinOpen === true;
  const child = spawn(process.execPath, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  if (options.input !== undefined) {
    if (options.keepStdinOpen === true) child.stdin.write(options.input);
    else child.stdin.end(options.input);
  }
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const result = new Promise<CliResult>((resolveRun, rejectRun) => {
    child.on('error', rejectRun);
    child.on('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
  return { child, readOutput: () => ({ stdout, stderr }), result };
}

/**
 * The fake provider runs in this process, so the CLI must be driven
 * asynchronously: a synchronous spawn would block the event loop that has to
 * answer the child's own HTTP request.
 */
export function runCli(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<CliResult> {
  return spawnCli(args, options).result;
}

export interface FakeProvider {
  url: string;
  /** One entry per completion request the CLI actually sent. */
  readonly requests: string[];
  close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible endpoint that asks for one tool call on its first
 * request and answers in prose afterwards. Drives the shutdown tests, which
 * need a real in-flight tool execution to drain.
 */
export function startToolCallProvider(options: {
  tool: string;
  arguments?: Record<string, unknown>;
  reply?: string;
}): Promise<FakeProvider> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(body);
      const wantsTool = !body.includes('toolResult') && !body.includes('tool_call');
      const rows = wantsTool
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${requests.length}`,
                        function: { name: options.tool, arguments: JSON.stringify(options.arguments ?? {}) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { choices: [{ delta: { content: options.reply ?? 'done' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ];
      const payload = `${rows.map((row) => `data: ${JSON.stringify(row)}\n`).join('\n')}\ndata: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(payload);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveServer({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Minimal OpenAI-compatible endpoint that always answers in prose, so a CLI run
 * can be driven end to end without a provider account.
 */
export function startFakeProvider(reply = 'done'): Promise<FakeProvider> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      const rows = [
        { choices: [{ delta: { content: reply } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      const payload = `${rows.map((row) => `data: ${JSON.stringify(row)}\n`).join('\n')}\ndata: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(payload);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveServer({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
