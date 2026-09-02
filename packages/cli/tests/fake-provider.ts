import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
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
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', rejectRun);
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

export interface FakeProvider {
  url: string;
  /** One entry per completion request the CLI actually sent. */
  readonly requests: string[];
  close: () => Promise<void>;
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
