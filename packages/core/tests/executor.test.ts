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
import { after, test, type TestContext } from 'node:test';
import {
  acquireVerifiedExecutor,
  bubblewrapCommandLine,
  createBubblewrapProvider,
  createSeatbeltProvider,
  bubblewrapProvider,
  buildSandboxSpec,
  resolveExecutableOnPath,
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

/**
 * Whether the provider's binary is even installed. This is the weaker gate: it
 * decides whether a test that builds its own deliberately weakened sandbox can
 * run at all, and says nothing about whether the real one works here.
 */
const binarySkip: string | false =
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
let sharedExecutor: SandboxExecutor | undefined;
let sandboxProbe: Promise<string | false> | undefined;

/**
 * Acquire one verified sandbox for the whole file, once, and remember why not
 * if it cannot be had. A host where the provider's binary exists but the kernel
 * or the security policy will not let it build a sandbox (a CI runner whose
 * unprivileged user namespaces are capability-restricted, say) is a skip with a
 * stated reason, not a failure: this suite tests piko's executor, not the
 * runner's configuration. Doing it here rather than in a `before` hook also
 * keeps a refusal from cancelling unrelated subtests.
 */
function probeSandbox(): Promise<string | false> {
  sandboxProbe ??= (async () => {
    if (binarySkip !== false) return binarySkip;
    sharedWorkspace = makeWorkspace('pi-executor-ws-');
    const outcome = await acquireVerifiedExecutor(platformProvider!, sharedWorkspace);
    if ('refusal' in outcome) {
      return `no usable ${platformProvider!.name} sandbox on this host: ${outcome.refusal}`;
    }
    sharedExecutor = outcome.executor;
    return false;
  })();
  return sandboxProbe;
}

/**
 * Gate one test on a working sandbox. Returns true when the caller should stop,
 * having already recorded the skip and its reason on the test context.
 */
async function skipWithoutSandbox(t: TestContext): Promise<boolean> {
  const reason = await probeSandbox();
  if (reason === false) return false;
  t.skip(reason);
  return true;
}

async function runInSandbox(tool: string, toolArguments: Record<string, unknown>): Promise<ToolOutput> {
  const executed = await sharedExecutor!.exec({
    tool,
    arguments: toolArguments,
    policy: policyFor(sharedWorkspace!),
    cwd: sharedWorkspace!,
  });
  return executed.result;
}

after(async () => {
  if (sharedExecutor) await sharedExecutor.release().catch(() => undefined);
});

test('the worker runs the five tools with the same results as the in-process tools', async (t) => {
  if (await skipWithoutSandbox(t)) return;
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

test('the workspace is writable through the sandbox', async (t) => {
  if (await skipWithoutSandbox(t)) return;
  const written = await runInSandbox('write', { path: 'writable-proof.txt', content: 'inside\n' });
  assert.equal(written.isError, undefined, textOf(written));
  assert.equal(readFileSync(join(sharedWorkspace!, 'writable-proof.txt'), 'utf8'), 'inside\n');
  const shelled = await runInSandbox('bash', { command: 'printf shell > shell-proof.txt && cat shell-proof.txt' });
  assert.equal(shelled.isError, undefined, textOf(shelled));
  assert.equal(readFileSync(join(sharedWorkspace!, 'shell-proof.txt'), 'utf8'), 'shell');
});

test('a canary outside the workspace is unreadable through read', async (t) => {
  if (await skipWithoutSandbox(t)) return;
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

test('a canary outside the workspace is unreadable through bash', async (t) => {
  if (await skipWithoutSandbox(t)) return;
  const output = await runInSandbox('bash', { command: `cat ${canaryPath}` });
  assert.equal(output.isError, true, `bash read the canary: ${textOf(output)}`);
  assert.ok(!textOf(output).includes('canary-contents-that-must-not-leak'), 'the canary contents must not appear');
});

test('a network connect from bash inside the sandbox fails', async (t) => {
  if (await skipWithoutSandbox(t)) return;
  const output = await runInSandbox('bash', {
    command: 'exec 3<>/dev/tcp/127.0.0.1/22 && echo PI_CONNECTED || echo pi-blocked',
  });
  assert.ok(!textOf(output).includes('PI_CONNECTED'), `a connection succeeded inside the sandbox: ${textOf(output)}`);
  assert.match(textOf(output), /pi-blocked/u);
});

test('a secret in the parent environment is absent inside the sandbox', async (t) => {
  if (await skipWithoutSandbox(t)) return;
  assert.equal(process.env[PARENT_SECRET_NAME], PARENT_SECRET_VALUE, 'the parent really holds the secret');
  const output = await runInSandbox('bash', { command: `printenv ${PARENT_SECRET_NAME} || echo pi-absent` });
  assert.ok(!textOf(output).includes(PARENT_SECRET_VALUE), `the secret leaked into the sandbox: ${textOf(output)}`);
  assert.match(textOf(output), /pi-absent/u);
});

test('the sessions directory is not visible inside the sandbox', async (t) => {
  if (await skipWithoutSandbox(t)) return;
  const listed = await runInSandbox('bash', { command: `ls ${sessionsDirectory}` });
  assert.equal(listed.isError, true, `the session store was listable: ${textOf(listed)}`);
  const read = await runInSandbox('bash', { command: `cat ${sessionMarkerPath}` });
  assert.equal(read.isError, true, `the session journal was readable: ${textOf(read)}`);
  assert.ok(!textOf(read).includes('session-marker'), 'no session journal content may appear');
});

test('the self-test refuses a provider whose sandbox is deliberately broken', { skip: binarySkip }, async () => {
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

/**
 * The fourth self-test check. A profile that starts node but refuses every
 * other binary passes the first three checks and then hosts four working tools
 * and one that always fails, which is worse than no sandbox because it looks
 * like it works. Two rounds of CI reached exactly that state on a hosted macOS
 * runner, so the check exists to turn it into a refusal with a reason.
 */
test(
  'the self-test refuses a sandbox that cannot start a shell',
  { skip: process.platform !== 'darwin' && 'this exec-denial is expressed as a Seatbelt profile' },
  async () => {
    const workspace = makeWorkspace('pi-executor-noexec-');
    const nodeOnlyProvider = createSeatbeltProvider({
      profileFor: (spec, privateTempDir) =>
        seatbeltProfile(spec, privateTempDir).replace(
          /^\(allow process-exec\*.*$/mu,
          `(allow process-exec* (literal "${spec.nodeExecutablePath}"))`,
        ),
    });
    const outcome = await acquireVerifiedExecutor(nodeOnlyProvider, workspace);
    if ('executor' in outcome) {
      await outcome.executor.release();
      assert.fail('a sandbox that cannot start a shell passed the self-test');
    }
    assert.match(outcome.refusal, /does not permit starting a shell/u, outcome.refusal);
    // The reason has to name the paths, or a failure on someone else's machine
    // is unreadable.
    assert.match(outcome.refusal, /parent resolved \//u, outcome.refusal);
    assert.match(outcome.refusal, /EPERM|EACCES|ENOENT/u, outcome.refusal);
    assert.match(outcome.refusal, /node \/.*shell \//u, outcome.refusal);
  },
);

test('selectSandboxExecutor reports no executor when no provider is available', async () => {
  const workspace = makeWorkspace('pi-executor-none-');
  for (const mode of ['auto', 'require'] as const) {
    const selection = await selectSandboxExecutor({ workspaceRoot: workspace, mode, providers: [] });
    assert.equal(selection.executor, undefined);
    assert.match(selection.summary, /no provider available on this host/u);
    assert.equal(selection.summary.includes('\n'), false, 'the summary is one line');
  }
});

test('a working sandbox names the binaries it permitted', async (t) => {
  if (await skipWithoutSandbox(t)) return;
  const selection = await selectSandboxExecutor({
    workspaceRoot: makeWorkspace('pi-executor-summary-'),
    mode: 'auto',
    providers: [platformProvider!],
  });
  assert.ok(selection.executor, selection.summary);
  assert.match(selection.summary, /provider active/u);
  assert.match(selection.summary, /node \/.*shell \//u, selection.summary);
  await selection.executor.release();
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

test('the sandbox spec points at built code and a canonical workspace', { skip: binarySkip }, () => {
  const workspace = makeWorkspace('pi-executor-spec-');
  const spec = buildSandboxSpec(workspace);
  assert.equal(spec.workspaceRoot, workspace);
  assert.match(spec.workerEntryPath, /dist[/\\]executor[/\\]worker\.js$/u);
  assert.ok(spec.workerEntryPath.startsWith(spec.pikoPackageRoot), 'the worker lives under the bound package root');
  assert.equal(spec.environment[PARENT_SECRET_NAME], undefined, 'the worker environment is the sanitized allowlist');
  assert.ok(spec.environment['PATH'], 'the worker still gets a PATH');
  assert.ok(
    spec.executableRealPaths.includes(realpathSync(process.execPath)),
    'the node that runs the worker is named at its resolved path',
  );
});

/**
 * A hosted macOS runner put `bash` at a Homebrew path whose `bin` entry is a
 * symlink into the package tree. Seatbelt judges the resolved target, so a
 * profile built from directory names alone denied the exec and the worker
 * answered `spawn EPERM`. The profile has to name the binaries themselves.
 */
test('the Seatbelt profile names the resolved node and bash binaries', { skip: process.platform !== 'darwin' && 'Seatbelt profiles are generated only on macOS' }, () => {
  const workspace = makeWorkspace('pi-executor-profile-');
  const spec = buildSandboxSpec(workspace);
  const profile = seatbeltProfile(spec, join(workspace, '..', 'private-temp'));

  const nodeRealPath = realpathSync(process.execPath);
  assert.ok(profile.includes(`(literal "${nodeRealPath}")`), `the profile names ${nodeRealPath}`);
  const shellRealPath = realpathSync('/bin/bash');
  assert.ok(profile.includes(`(literal "${shellRealPath}")`), `the profile names ${shellRealPath}`);

  // Naming them is only useful if it is the exec rule that carries them.
  const execRule = profile.split('\n').find((line) => line.startsWith('(allow process-exec'));
  assert.ok(execRule, 'the profile has a process-exec rule');
  assert.ok(execRule.includes(`(literal "${nodeRealPath}")`), 'node is executable at its resolved path');
  assert.ok(execRule.includes(`(literal "${shellRealPath}")`), 'the shell is executable at its resolved path');

  // And the shell the worker will actually find on its PATH, which is not
  // always /bin/bash, has to be there too.
  const pathShell = resolveExecutableOnPath('bash', spec.environment['PATH'] ?? '');
  assert.ok(pathShell, 'this host has a bash on the sanitized PATH');
  assert.ok(execRule.includes(`(literal "${pathShell}")`), `the PATH shell ${pathShell} is executable`);
});
