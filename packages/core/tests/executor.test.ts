/**
 * ADR 0018 acceptance: the tool worker runs the five tools inside a real
 * operating-system sandbox, and the boundary is real.
 *
 * Every test here drives a real provider (bubblewrap on Linux, Seatbelt on
 * macOS) and is skipped with a stated reason where that provider's binary is
 * not installed. Nothing in this file simulates a sandbox.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  acquireVerifiedExecutor,
  bubblewrapCommandLine,
  createBubblewrapProvider,
  createSeatbeltProvider,
  bubblewrapProvider,
  buildSandboxSpec,
  sandboxToolPolicy,
  seatbeltProfile,
  seatbeltProvider,
  selectSandboxExecutor,
  type SandboxExecutor,
  type SandboxProvider,
  type SandboxSpec,
  type SandboxToolPolicy,
} from '../src/executor/index.js';
import {
  bashTool,
  editTool,
  mapTool,
  readTool,
  writeTool,
  type Tool,
  type ToolContext,
  type ToolOutput,
} from '../src/tools/index.js';

/**
 * A secret placed in this process's environment before any sandbox is built, so
 * the "no parent credentials inside" test measures the environment the provider
 * actually constructed rather than one arranged for it.
 */
const PARENT_SECRET_NAME = 'PI_EXECUTOR_TEST_API_KEY';
const PARENT_SECRET_VALUE = 'sk-executor-test-must-not-be-visible';
process.env[PARENT_SECRET_NAME] = PARENT_SECRET_VALUE;

/**
 * A private home for the whole file, so the "sessions directory is not visible"
 * test can create a real session store and assert it is unreachable without
 * touching the developer's own `~/.pi`.
 */
const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'pi-executor-home-')));
const sessionsDirectory = join(testHome, '.pi', 'sessions', 'workspace-0000');
mkdirSync(sessionsDirectory, { recursive: true });
const sessionMarkerPath = join(sessionsDirectory, 'session.jsonl');
writeFileSync(sessionMarkerPath, '{"t":"session-marker"}\n', 'utf8');
process.env['HOME'] = testHome;

/** The provider this platform ships, and why it might not be usable here. */
const platformProvider: SandboxProvider | undefined =
  process.platform === 'linux' ? bubblewrapProvider : process.platform === 'darwin' ? seatbeltProvider : undefined;

const providerSkip: string | false =
  platformProvider === undefined
    ? `no sandbox provider is defined for platform ${process.platform}`
    : !platformProvider.isAvailable()
      ? `the ${platformProvider.name} sandbox binary is not installed on this host`
      : false;

/** One canary file outside every workspace these tests create. */
const canaryDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'pi-executor-canary-')));
const canaryPath = join(canaryDirectory, 'outside.txt');
writeFileSync(canaryPath, 'canary-contents-that-must-not-leak\n', 'utf8');

function makeWorkspace(prefix: string): string {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  writeFileSync(join(workspace, 'hello.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
  writeFileSync(join(workspace, 'source.ts'), 'export function tidy(): void {}\n', 'utf8');
  return workspace;
}

function policyFor(workspaceRoot: string): SandboxToolPolicy {
  return { workspaceRoot, bash: { allowHostExecution: true } };
}

/** In-process ToolContext, matching what the worker builds on its side. */
function inProcessContext(workspaceRoot: string): ToolContext {
  let workingDirectory = workspaceRoot;
  return {
    get cwd() {
      return workingDirectory;
    },
    setCwd(next: string) {
      workingDirectory = next;
    },
    policy: policyFor(workspaceRoot),
  };
}

function textOf(output: ToolOutput): string {
  return output.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

let sharedWorkspace: string | undefined;
let sharedExecutorPromise: Promise<SandboxExecutor> | undefined;

/** One sandbox for the whole file: acquiring is the expensive part, not exec. */
function sharedExecutor(): Promise<SandboxExecutor> {
  sharedWorkspace ??= makeWorkspace('pi-executor-ws-');
  sharedExecutorPromise ??= (async () => {
    const outcome = await acquireVerifiedExecutor(platformProvider!, sharedWorkspace!);
    if ('refusal' in outcome) throw new Error(`could not acquire a verified sandbox: ${outcome.refusal}`);
    return outcome.executor;
  })();
  return sharedExecutorPromise;
}

async function runInSandbox(tool: string, toolArguments: Record<string, unknown>): Promise<ToolOutput> {
  const executor = await sharedExecutor();
  const executed = await executor.exec({
    tool,
    arguments: toolArguments,
    policy: policyFor(sharedWorkspace!),
    cwd: sharedWorkspace!,
  });
  return executed.result;
}

after(async () => {
  if (sharedExecutorPromise) await (await sharedExecutorPromise).release().catch(() => undefined);
});

test('the worker runs the five tools with the same results as the in-process tools', { skip: providerSkip }, async () => {
  const hostWorkspace = makeWorkspace('pi-executor-host-');
  const executor = await acquireVerifiedExecutor(platformProvider!, makeWorkspace('pi-executor-sandboxed-'));
  assert.ok(!('refusal' in executor), `sandbox acquire refused: ${'refusal' in executor ? executor.refusal : ''}`);
  const sandboxed = executor.executor;
  const sandboxWorkspace = sandboxed.workspaceRoot;
  try {
    const cases: { tool: Tool; toolArguments: Record<string, unknown> }[] = [
      { tool: readTool, toolArguments: { path: 'hello.txt' } },
      { tool: writeTool, toolArguments: { path: 'nested/created.txt', content: 'written by the tool\n' } },
      { tool: editTool, toolArguments: { path: 'hello.txt', old_text: 'beta', new_text: 'BETA' } },
      { tool: mapTool, toolArguments: { path: '.' } },
      { tool: bashTool, toolArguments: { command: 'pwd; ls; cat hello.txt' } },
    ];
    const hostContext = inProcessContext(hostWorkspace);
    for (const { tool, toolArguments } of cases) {
      const inProcess = await tool.execute(toolArguments, hostContext);
      const inSandbox = await sandboxed.exec({
        tool: tool.name,
        arguments: toolArguments,
        policy: policyFor(sandboxWorkspace),
        cwd: sandboxWorkspace,
      });
      const normalize = (text: string, root: string): string => text.split(root).join('<workspace>');
      assert.equal(
        normalize(textOf(inSandbox.result), sandboxWorkspace),
        normalize(textOf(inProcess), hostWorkspace),
        `${tool.name} produced a different result inside the sandbox`,
      );
      assert.equal(inSandbox.result.isError, inProcess.isError, `${tool.name} disagreed on error status`);
    }
    // The effects landed too, not just the messages describing them.
    assert.equal(readFileSync(join(sandboxWorkspace, 'nested', 'created.txt'), 'utf8'), 'written by the tool\n');
    assert.match(readFileSync(join(sandboxWorkspace, 'hello.txt'), 'utf8'), /BETA/u);
  } finally {
    await sandboxed.release();
  }
});

test('the workspace is writable through the sandbox', { skip: providerSkip }, async () => {
  const written = await runInSandbox('write', { path: 'writable-proof.txt', content: 'inside\n' });
  assert.equal(written.isError, undefined, textOf(written));
  assert.equal(readFileSync(join(sharedWorkspace!, 'writable-proof.txt'), 'utf8'), 'inside\n');
  const shelled = await runInSandbox('bash', { command: 'printf shell > shell-proof.txt && cat shell-proof.txt' });
  assert.equal(shelled.isError, undefined, textOf(shelled));
  assert.equal(readFileSync(join(sharedWorkspace!, 'shell-proof.txt'), 'utf8'), 'shell');
});

test('a canary outside the workspace is unreadable through read', { skip: providerSkip }, async () => {
  // The read tool refuses an out-of-workspace path in piko's own containment
  // check, before the operating system is asked, so this test records the
  // refusal in whichever form it arrives. The bash case below is what proves
  // the operating-system boundary itself.
  let refusal: string;
  try {
    const output = await runInSandbox('read', { path: canaryPath });
    assert.equal(output.isError, true, 'reading an out-of-workspace canary must fail');
    refusal = textOf(output);
  } catch (error) {
    refusal = String(error);
  }
  assert.ok(!refusal.includes('canary-contents-that-must-not-leak'), 'the canary contents must not appear');
  assert.match(refusal, /absolute paths are not allowed|escapes workspace|not accessible/u);
});

test('a canary outside the workspace is unreadable through bash', { skip: providerSkip }, async () => {
  const output = await runInSandbox('bash', { command: `cat ${canaryPath}` });
  assert.equal(output.isError, true, `bash read the canary: ${textOf(output)}`);
  assert.ok(!textOf(output).includes('canary-contents-that-must-not-leak'), 'the canary contents must not appear');
});

test('a network connect from bash inside the sandbox fails', { skip: providerSkip }, async () => {
  const output = await runInSandbox('bash', {
    command: 'exec 3<>/dev/tcp/127.0.0.1/22 && echo PI_CONNECTED || echo pi-blocked',
  });
  assert.ok(!textOf(output).includes('PI_CONNECTED'), `a connection succeeded inside the sandbox: ${textOf(output)}`);
  assert.match(textOf(output), /pi-blocked/u);
});

test('a secret in the parent environment is absent inside the sandbox', { skip: providerSkip }, async () => {
  assert.equal(process.env[PARENT_SECRET_NAME], PARENT_SECRET_VALUE, 'the parent really holds the secret');
  const output = await runInSandbox('bash', { command: `printenv ${PARENT_SECRET_NAME} || echo pi-absent` });
  assert.ok(!textOf(output).includes(PARENT_SECRET_VALUE), `the secret leaked into the sandbox: ${textOf(output)}`);
  assert.match(textOf(output), /pi-absent/u);
});

test('the sessions directory is not visible inside the sandbox', { skip: providerSkip }, async () => {
  const listed = await runInSandbox('bash', { command: `ls ${sessionsDirectory}` });
  assert.equal(listed.isError, true, `the session store was listable: ${textOf(listed)}`);
  const read = await runInSandbox('bash', { command: `cat ${sessionMarkerPath}` });
  assert.equal(read.isError, true, `the session journal was readable: ${textOf(read)}`);
  assert.ok(!textOf(read).includes('session-marker'), 'no session journal content may appear');
});

test('the self-test refuses a provider whose sandbox is deliberately broken', { skip: providerSkip }, async () => {
  const workspace = makeWorkspace('pi-executor-broken-');
  // Each platform's break is the smallest real one: on macOS a profile that
  // grants blanket read, on Linux an argv that keeps the host network namespace.
  const brokenProvider =
    process.platform === 'darwin'
      ? createSeatbeltProvider({
          profileFor: (spec: SandboxSpec, privateTempDir: string) =>
            `${seatbeltProfile(spec, privateTempDir)}(allow file-read*)\n`,
        })
      : createBubblewrapProvider({
          commandLineFor: (spec: SandboxSpec, privateTempDir: string) =>
            bubblewrapCommandLine(spec, privateTempDir).map((argument) =>
              argument === '--unshare-all' ? '--unshare-pid' : argument,
            ),
        });
  const outcome = await acquireVerifiedExecutor(brokenProvider, workspace);
  if ('executor' in outcome) {
    await outcome.executor.release();
    assert.fail('a deliberately broken sandbox passed the self-test');
  }
  assert.match(
    outcome.refusal,
    process.platform === 'darwin' ? /readable inside it/u : /network connection succeeded/u,
    `the refusal should name the check that failed: ${outcome.refusal}`,
  );
});

test('selectSandboxExecutor reports no executor when no provider is available', async () => {
  const workspace = makeWorkspace('pi-executor-none-');
  for (const mode of ['auto', 'require'] as const) {
    const selection = await selectSandboxExecutor({ workspaceRoot: workspace, mode, providers: [] });
    assert.equal(selection.executor, undefined);
    assert.match(selection.summary, /no provider available on this host/u);
    assert.equal(selection.summary.includes('\n'), false, 'the summary is one line');
  }
});

test('selectSandboxExecutor off never looks for a provider', async () => {
  const workspace = makeWorkspace('pi-executor-off-');
  const selection = await selectSandboxExecutor({ workspaceRoot: workspace, mode: 'off' });
  assert.equal(selection.executor, undefined);
  assert.match(selection.summary, /off by --sandbox off/u);
});

test('the worker policy carries containment and never the control plane', () => {
  const projected = sandboxToolPolicy(
    {
      workspaceRoot: '/workspace',
      allowProtectedPaths: true,
      approval: '*',
      bash: { allowHostExecution: false, sandboxedExecution: true },
    },
    '/fallback',
  );
  assert.equal(projected.workspaceRoot, '/workspace');
  assert.equal(projected.allowProtectedPaths, true);
  // The sandboxed gate is what turns the shell on inside the worker; the host
  // gate is a different capability and does not travel.
  assert.equal(projected.bash?.allowHostExecution, true);
  assert.equal('approval' in projected, false, 'approvals stay in the parent');
  assert.equal('executor' in projected, false, 'the executor handle is not serializable');

  const hostOnly = sandboxToolPolicy({ workspaceRoot: '/workspace', bash: { allowHostExecution: true } }, '/fallback');
  assert.equal(hostOnly.bash?.allowHostExecution, false, '--allow-host-bash alone does not enable the sandboxed shell');
});

test('the sandbox spec points at built code and a canonical workspace', { skip: providerSkip }, () => {
  const workspace = makeWorkspace('pi-executor-spec-');
  const spec = buildSandboxSpec(workspace);
  assert.equal(spec.workspaceRoot, workspace);
  assert.match(spec.workerEntryPath, /dist[/\\]executor[/\\]worker\.js$/u);
  assert.ok(spec.workerEntryPath.startsWith(spec.pikoPackageRoot), 'the worker lives under the bound package root');
  assert.equal(spec.environment[PARENT_SECRET_NAME], undefined, 'the worker environment is the sanitized allowlist');
  assert.ok(spec.environment['PATH'], 'the worker still gets a PATH');
});
