/**
 * ADR 0018: the sandbox worker's bash tool spawns the shell by the absolute
 * path the parent resolved, never the bare name.
 *
 * A hosted macOS runner (macOS 26.5, node under /Users/runner/hostedtoolcache)
 * started `/bin/bash` inside the Seatbelt profile and answered `spawn EPERM`
 * for a bare `bash`: `execvp` walks PATH and continues only on ENOENT, ENOTDIR
 * and EACCES, so a directory the profile denies ends the search rather than
 * being skipped. These tests pin the fix, and none of them needs a sandbox
 * provider: the shell is a fake placed at a known path, so what was spawned is
 * visible in the tool's own output.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bubblewrapCommandLine,
  readShellPathArgument,
  resolveExecutableOnPath,
  resolveWorkerEntryPath,
  seatbeltCommandLine,
  shellPathArguments,
  ToolWorkerHost,
  WORKER_SHELL_PATH_FLAG,
  type SandboxSpec,
} from '../src/executor/index.js';
import { bashTool, createBashTool, sanitizedBashEnvironment } from '../src/tools/bash.js';
import type { ToolContext, ToolOutput } from '../src/tools/types.js';

/** Printed by the fake shell before it hands over to the real one. */
const FAKE_SHELL_MARKER = 'pi-fake-shell-marker';

const realShellPath = resolveExecutableOnPath('bash', process.env['PATH'] ?? '') ?? realpathSync('/bin/bash');

/**
 * A shell that announces itself and then behaves exactly like bash, so a tool
 * call through it still produces output and still reports its working
 * directory. It sits outside every PATH entry, so only a spawn that names its
 * absolute path can reach it.
 */
function writeFakeShell(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-fake-shell-')));
  const fakeShellPath = join(directory, 'fake-bash');
  writeFileSync(fakeShellPath, `#!${realShellPath}\necho ${FAKE_SHELL_MARKER}\nexec ${realShellPath} "$@"\n`, 'utf8');
  chmodSync(fakeShellPath, 0o755);
  return fakeShellPath;
}

function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'pi-worker-shell-')));
}

function inProcessContext(workspaceRoot: string): ToolContext {
  let workingDirectory = workspaceRoot;
  return {
    get cwd() {
      return workingDirectory;
    },
    setCwd(next: string) {
      workingDirectory = next;
    },
    policy: { workspaceRoot, bash: { allowHostExecution: true } },
  };
}

function textOf(output: ToolOutput): string {
  return output.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n');
}

function specFor(workspaceRoot: string, shellExecutablePath: string | undefined): SandboxSpec {
  return {
    workspaceRoot,
    nodeExecutablePath: '/opt/node/bin/node',
    nodeInstallPrefix: '/opt/node',
    pikoPackageRoot: '/opt/piko',
    executableRealPaths: ['/opt/node/bin/node'],
    shellExecutablePath,
    workerEntryPath: '/opt/piko/dist/executor/worker.js',
    environment: { PATH: '/usr/bin:/bin' },
  };
}

test('a bash tool built with a shell path spawns that shell', async () => {
  const fakeShellPath = writeFakeShell();
  const workspace = makeWorkspace();
  const output = await createBashTool({ shellExecutablePath: fakeShellPath }).execute(
    { command: 'echo ran-the-command' },
    inProcessContext(workspace),
  );
  assert.notEqual(output.isError, true, textOf(output));
  assert.match(textOf(output), new RegExp(FAKE_SHELL_MARKER, 'u'), textOf(output));
  assert.match(textOf(output), /ran-the-command/u, textOf(output));
});

test('the host-side bash tool still resolves its shell on PATH', async () => {
  const workspace = makeWorkspace();
  const output = await bashTool.execute({ command: 'echo ran-the-command' }, inProcessContext(workspace));
  assert.match(textOf(output), /ran-the-command/u, textOf(output));
  assert.ok(!textOf(output).includes(FAKE_SHELL_MARKER), 'the default tool must not reach a fake shell');
});

test('both providers carry the resolved shell path to the worker', () => {
  const workspace = makeWorkspace();
  const shellExecutablePath = '/opt/homebrew/Cellar/bash/5.3/bin/bash';
  const spec = specFor(workspace, shellExecutablePath);
  for (const commandLine of [
    seatbeltCommandLine(spec, '(version 1)'),
    bubblewrapCommandLine(spec, join(workspace, 'private-temp')),
  ]) {
    assert.ok(
      commandLine.includes(`${WORKER_SHELL_PATH_FLAG}=${shellExecutablePath}`),
      `the command line names the shell: ${commandLine.join(' ')}`,
    );
    assert.equal(readShellPathArgument(commandLine), shellExecutablePath);
  }

  // A host with no shell at all resolves nothing, and the worker falls back to
  // the bare name rather than being handed an empty flag to spawn.
  const withoutShell = specFor(workspace, undefined);
  assert.deepEqual(shellPathArguments(undefined), []);
  assert.equal(readShellPathArgument(seatbeltCommandLine(withoutShell, '(version 1)')), undefined);
  assert.equal(readShellPathArgument(bubblewrapCommandLine(withoutShell, join(workspace, 'private-temp'))), undefined);
});

/**
 * The worker end of the same fix, driven through the real protocol: it is
 * started here without a sandbox around it, because what is under test is which
 * binary its bash tool spawns and not what a profile permits.
 */
test('the worker bash tool spawns the shell path it was started with', async () => {
  const fakeShellPath = writeFakeShell();
  const workspace = makeWorkspace();
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizedBashEnvironment())) {
    if (value !== undefined) environment[name] = value;
  }
  const host = new ToolWorkerHost(
    [process.execPath, resolveWorkerEntryPath(), ...shellPathArguments(fakeShellPath)],
    { cwd: workspace, environment, providerName: 'test-harness' },
  );
  try {
    await host.awaitReady();
    const executed = await host.execute({
      tool: 'bash',
      arguments: { command: 'echo ran-in-the-worker' },
      policy: { workspaceRoot: workspace, bash: { allowHostExecution: true } },
      cwd: workspace,
    });
    const text = textOf(executed.result);
    assert.match(text, new RegExp(FAKE_SHELL_MARKER, 'u'), text);
    assert.match(text, /ran-in-the-worker/u, text);
  } finally {
    host.kill();
  }
});
