/**
 * ADR 0022 acceptance regression, through the sandbox executor.
 *
 * The 2026-09-02 mechanism addendum to ADR 0022 says the containment mechanism
 * is the executor path, not a native addon: under ADR 0018's amendments the
 * five tools' effects run inside a sandboxed worker whose filesystem view is
 * the workspace and nothing else, so a path component swapped to point outside
 * the workspace mid-operation resolves to nothing the worker can reach and the
 * operation fails at the operating-system boundary rather than at a re-check.
 *
 * This file is that claim, executed. It runs the same eight parent-swap attacks
 * as packages/core/tests/containment.test.ts, but every tool call goes through a
 * real acquired executor (Seatbelt on macOS, bubblewrap on Linux) and every
 * swap is performed by this test, in the parent, while the worker is paused
 * inside the shipped implementation.
 *
 * How the swap gets in. In process, a containment barrier is a callback the
 * test registers at a named point of the implementation. Through the executor
 * the tool runs in another process, so the acquire spec asks for the barrier
 * bridge (`containmentBarrierChannel`, never set on the CLI path and never
 * readable from the environment): the worker then announces each barrier it
 * reaches on a dedicated descriptor and blocks until this test writes one line
 * back. The swap happens in between, on the same filesystem the worker is
 * looking at, so what is exercised is a real mid-call parent swap and not a
 * re-creation of one.
 *
 * These tests are not todo. They assert the security property ADR 0022 states:
 * nothing outside the workspace is disclosed, nothing outside the workspace is
 * created, replaced, or removed, and the operation reports a failure rather
 * than a success. The one deliberate exception is the map walk, recorded here
 * and in docs/adr/evidence/0022-containment-test-map.md: map is a survey that
 * skips a directory it cannot open and still reports success, so its clause is
 * asserted as non-disclosure. The in-process file stays exactly as it is; its
 * todo markers remain the honest statement about the path with no provider.
 *
 * Where no provider passes its acquire-time self-test, each test skips with the
 * refusal as its stated reason. Nothing here simulates a sandbox.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  acquireVerifiedExecutor,
  bubblewrapCommandLine,
  bubblewrapProvider,
  buildSandboxSpec,
  createBubblewrapProvider,
  createSeatbeltProvider,
  seatbeltProfile,
  seatbeltProvider,
  workerHostFor,
  type ContainmentBarrierChannel,
  type ContainmentBarrierEvent,
  type SandboxExecutor,
  type SandboxProvider,
} from '../src/executor/index.js';
import type { ContainmentBarrierName, ToolOutput } from '../src/tools/index.js';

/** The provider this platform ships, and why it might not be usable here. */
const platformProvider: SandboxProvider | undefined =
  process.platform === 'linux' ? bubblewrapProvider : process.platform === 'darwin' ? seatbeltProvider : undefined;

const providerSkip: string | undefined =
  platformProvider === undefined
    ? `no sandbox provider is defined for platform ${process.platform}, so ADR 0022's mechanism is not present here`
    : !platformProvider.isAvailable()
      ? `the ${platformProvider.name} sandbox binary is not installed on this host, so there is no executor to contain the attack`
      : undefined;

const OUT_OF_WORKSPACE_SECRET = 'OUT_OF_WORKSPACE_SECRET_MUST_NOT_BE_DISCLOSED';
const MAP_LEAK_MARKER = 'LEAKED_MARKER';
/** Depth of the directory chain the map walk queues as plain path strings. */
const MAP_CHAIN_LEVELS = ['1', '2', '3', '4', '5'];

interface AttackHarness {
  readonly workspaceRoot: string;
  readonly outsideRoot: string;
  readonly executor: SandboxExecutor;
  readonly barrier: ContainmentBarrierChannel;
}

interface AttackOutcome {
  /** The tool's own output, when the worker returned one. */
  readonly output: ToolOutput | undefined;
  /** What the call threw, when it threw instead. */
  readonly thrown: unknown;
}

/**
 * Acquire a real, self-tested sandbox with the barrier bridge on, run one
 * attack against it, and release it. A provider that is missing or that fails
 * its self-test skips the test with that as the stated reason rather than
 * quietly passing something weaker.
 */
async function withAttackHarness(
  testContext: TestContext,
  prefix: string,
  attack: (harness: AttackHarness) => Promise<void>,
): Promise<void> {
  if (providerSkip !== undefined) {
    testContext.skip(providerSkip);
    return;
  }
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), `pi-containment-exec-${prefix}-ws-`)));
  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), `pi-containment-exec-${prefix}-out-`)));
  const acquired = await acquireVerifiedExecutor(platformProvider!, workspaceRoot, {
    containmentBarrierChannel: true,
  });
  if ('refusal' in acquired) {
    testContext.skip(`no sandbox provider passed its self-test on this host: ${acquired.refusal}`);
    return;
  }
  const barrier = workerHostFor(acquired.handle)?.containmentBarrier;
  assert.ok(barrier, 'the acquired sandbox has no containment barrier channel, so no swap could be timed');
  try {
    await attack({ workspaceRoot, outsideRoot, executor: acquired.executor, barrier });
    // A swap that threw would leave the worker running against an untouched
    // tree, and the attack would look contained because it never happened.
    assert.equal(
      barrier.failure,
      undefined,
      `a barrier handler failed, so the swap did not happen as timed: ${String(barrier.failure)}`,
    );
  } finally {
    await acquired.executor.release();
  }
}

/**
 * The attack itself, performed here in the parent while the worker is paused: a
 * directory component the containment check already validated becomes a symlink
 * to a directory outside the workspace. The real directory stays as
 * `<name>.real` so residue assertions can inspect it.
 */
function swapDirectoryForOutsideSymlink(parentPath: string, outsideRoot: string): void {
  renameSync(parentPath, `${parentPath}.real`);
  symlinkSync(outsideRoot, parentPath, 'dir');
}

/**
 * Perform `swap` the first time the worker reaches `barrierName`, and release
 * every other barrier untouched. Returns a function reporting whether the swap
 * fired, because an attack that never happened proves nothing.
 */
function swapAtBarrier(
  barrier: ContainmentBarrierChannel,
  barrierName: ContainmentBarrierName,
  swap: (event: ContainmentBarrierEvent) => void,
  shouldSwapAt: (event: ContainmentBarrierEvent) => boolean = () => true,
): () => boolean {
  let swapFired = false;
  barrier.onBarrier((event) => {
    if (swapFired || event.barrier !== barrierName || !shouldSwapAt(event)) return;
    swapFired = true;
    swap(event);
  });
  return () => swapFired;
}

async function executeThroughExecutor(
  harness: AttackHarness,
  tool: string,
  toolArguments: Record<string, unknown>,
): Promise<AttackOutcome> {
  try {
    const executed = await harness.executor.exec({
      tool,
      arguments: toolArguments,
      policy: { workspaceRoot: harness.workspaceRoot },
      cwd: harness.workspaceRoot,
    });
    return { output: executed.result, thrown: undefined };
  } catch (error) {
    return { output: undefined, thrown: error };
  }
}

function renderedText(output: ToolOutput | undefined): string {
  if (!output) return '';
  return output.content.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
}

/** Everything the tool could have said, whether it returned it or threw it. */
function everythingReported(outcome: AttackOutcome): string {
  return `${renderedText(outcome.output)}\n${outcome.thrown === undefined ? '' : String(outcome.thrown)}`;
}

/** True when the tool completed without reporting a refusal. */
function reportedSuccess(outcome: AttackOutcome): boolean {
  return outcome.thrown === undefined && outcome.output !== undefined && outcome.output.isError !== true;
}

/**
 * Every regular file and directory under a root, with file contents, as sorted
 * lines. Comparing one of these before and after an attack catches a file
 * created, replaced, or removed outside the workspace in a single assertion.
 */
function snapshotTree(root: string): string[] {
  const lines: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      const relativePath = relative(root, fullPath);
      if (entry.isDirectory()) {
        lines.push(`dir  ${relativePath}`);
        pending.push(fullPath);
      } else if (entry.isSymbolicLink()) {
        lines.push(`link ${relativePath}`);
      } else {
        lines.push(`file ${relativePath} = ${JSON.stringify(readFileSync(fullPath, 'utf8'))}`);
      }
    }
  }
  return lines.sort();
}

/** The security property, stated once: nothing outside the workspace moved. */
function assertNothingChangedOutside(outsideRoot: string, before: readonly string[], outcome: AttackOutcome): void {
  assert.deepEqual(
    snapshotTree(outsideRoot),
    [...before],
    `the sandboxed tool created, replaced, or removed something outside the workspace. Tool reported: ${everythingReported(outcome)}`,
  );
}

/** atomicWriteTextFile names its temporaries `.<basename>.pi-tmp-<pid>-<uuid>`. */
function listTemporaryArtifacts(directoryPath: string): string[] {
  return readdirSync(directoryPath).filter((entryName) => entryName.includes('.pi-tmp-'));
}

test('read.execute through the executor: a parent swapped mid-call discloses nothing outside the workspace', async (testContext) => {
  await withAttackHarness(testContext, 'read', async (harness) => {
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    writeFileSync(join(harness.workspaceRoot, 'sub', 'notes.txt'), 'workspace content\n', 'utf8');
    writeFileSync(join(harness.outsideRoot, 'notes.txt'), `${OUT_OF_WORKSPACE_SECRET}\n`, 'utf8');
    const outsideBefore = snapshotTree(harness.outsideRoot);

    const swapFired = swapAtBarrier(harness.barrier, 'before-open', () =>
      swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot),
    );
    const outcome = await executeThroughExecutor(harness, 'read', { path: 'sub/notes.txt' });

    assert.ok(swapFired(), 'the worker never paused at before-open, so the attack was not performed');
    assert.ok(
      !everythingReported(outcome).includes(OUT_OF_WORKSPACE_SECRET),
      `read disclosed an out-of-workspace file through the swapped parent: ${everythingReported(outcome)}`,
    );
    assert.equal(
      reportedSuccess(outcome),
      false,
      `read reported success across a parent swap: ${everythingReported(outcome)}`,
    );
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
  });
});

test('write.execute through the executor: a parent swapped mid-call creates no file outside the workspace', async (testContext) => {
  await withAttackHarness(testContext, 'write', async (harness) => {
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    const outsideBefore = snapshotTree(harness.outsideRoot);

    const swapFired = swapAtBarrier(harness.barrier, 'before-temp-create', () =>
      swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot),
    );
    const outcome = await executeThroughExecutor(harness, 'write', {
      path: 'sub/created.txt',
      content: 'payload\n',
    });

    assert.ok(swapFired(), 'the worker never paused at before-temp-create, so the attack was not performed');
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
    assert.equal(
      reportedSuccess(outcome),
      false,
      `write reported success across a parent swap: ${everythingReported(outcome)}`,
    );
  });
});

test('edit.execute through the executor: a parent swapped mid-call replaces no file outside the workspace', async (testContext) => {
  await withAttackHarness(testContext, 'edit', async (harness) => {
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    writeFileSync(join(harness.workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
    writeFileSync(join(harness.outsideRoot, 'target.txt'), 'victim content\n', 'utf8');
    const outsideBefore = snapshotTree(harness.outsideRoot);

    const swapFired = swapAtBarrier(harness.barrier, 'before-temp-create', () =>
      swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot),
    );
    const outcome = await executeThroughExecutor(harness, 'edit', {
      path: 'sub/target.txt',
      old_text: 'original',
      new_text: 'edited',
    });

    assert.ok(swapFired(), 'the worker never paused at before-temp-create, so the attack was not performed');
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
    assert.equal(
      readFileSync(join(harness.outsideRoot, 'target.txt'), 'utf8'),
      'victim content\n',
      `edit rewrote a file outside the workspace: ${everythingReported(outcome)}`,
    );
    assert.equal(
      reportedSuccess(outcome),
      false,
      `edit reported success across a parent swap: ${everythingReported(outcome)}`,
    );
    assert.ok(
      ['original\n', 'edited\n'].includes(
        readFileSync(join(harness.workspaceRoot, 'sub.real', 'target.txt'), 'utf8'),
      ),
      'the in-workspace file must hold either the original or the edited content, never a partial write',
    );
  });
});

test('map.execute through the executor: a queued directory swapped mid-walk discloses nothing outside the workspace', async (testContext) => {
  await withAttackHarness(testContext, 'map', async (harness) => {
    // The one clause asserted as non-disclosure rather than as a reported
    // failure: the map walk skips a directory it cannot open and reports the
    // rest of the workspace, which is the fail-closed behaviour for a survey.
    let insideDirectory = join(harness.workspaceRoot, 'chain');
    let outsideDirectory = harness.outsideRoot;
    mkdirSync(insideDirectory);
    // Walked before the swap, so their presence in the output is this test's
    // proof of life: an empty map could not leak anything either.
    writeFileSync(join(harness.workspaceRoot, 'benign_root.ts'), 'export const benignRoot = true;\n', 'utf8');
    writeFileSync(join(insideDirectory, 'benign_chain.ts'), 'export const benignChain = true;\n', 'utf8');
    for (const level of MAP_CHAIN_LEVELS) {
      insideDirectory = join(insideDirectory, level);
      outsideDirectory = join(outsideDirectory, level);
      mkdirSync(insideDirectory);
      mkdirSync(outsideDirectory);
      writeFileSync(join(insideDirectory, `benign_${level}.ts`), `export const benign${level} = true;\n`, 'utf8');
      writeFileSync(
        join(outsideDirectory, `leaked_${level}.ts`),
        `export const ${MAP_LEAK_MARKER}_${level} = true;\n`,
        'utf8',
      );
    }
    const outsideBefore = snapshotTree(harness.outsideRoot);

    // The walk queues directories as path strings. The swap fires when the walk
    // is about to open the first queued child, so `chain` has already been
    // validated and walked at the moment it becomes a symlink.
    const firstQueuedChild = join(harness.workspaceRoot, 'chain', MAP_CHAIN_LEVELS[0]!);
    const swapFired = swapAtBarrier(
      harness.barrier,
      'before-map-directory-open',
      () => swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'chain'), harness.outsideRoot),
      (event) => event.path === firstQueuedChild,
    );
    const outcome = await executeThroughExecutor(harness, 'map', { depth: 8 });

    assert.ok(swapFired(), 'the worker never paused at the first queued child, so the attack was not performed');
    assert.ok(
      !everythingReported(outcome).includes(MAP_LEAK_MARKER),
      `the swapped directory redirected the map walk outside the workspace:\n${everythingReported(outcome)}`,
    );
    assert.match(
      everythingReported(outcome),
      /benign_root\.ts/u,
      `the walk reported nothing from inside the workspace, so its silence about the outside proves nothing: ${everythingReported(outcome)}`,
    );
    assert.match(
      everythingReported(outcome),
      /benign_chain\.ts/u,
      `the walk never reached the swapped directory's own contents, so the swap landed too early: ${everythingReported(outcome)}`,
    );
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
  });
});

test('write.execute through the executor: intermediate directory creation through a swapped parent builds nothing outside the workspace', async (testContext) => {
  await withAttackHarness(testContext, 'mkdir', async (harness) => {
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    const outsideBefore = snapshotTree(harness.outsideRoot);

    const swapFired = swapAtBarrier(harness.barrier, 'before-mkdir', () =>
      swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot),
    );
    const outcome = await executeThroughExecutor(harness, 'write', {
      path: 'sub/created/deep/file.txt',
      content: 'payload\n',
    });

    assert.ok(swapFired(), 'the worker never paused at before-mkdir, so the attack was not performed');
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
    assert.equal(
      reportedSuccess(outcome),
      false,
      `write reported success across a parent swap during directory creation: ${everythingReported(outcome)}`,
    );
  });
});

test('write.execute through the executor: the temporary file never appears outside the workspace after a parent swap', async (testContext) => {
  await withAttackHarness(testContext, 'temp', async (harness) => {
    // `before-rename` is an observation point, not a second attack: it lists the
    // outside directory at the one moment a staged temporary would be visible,
    // from this process, while the worker is paused.
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    writeFileSync(join(harness.workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
    writeFileSync(join(harness.outsideRoot, 'target.txt'), 'victim content\n', 'utf8');
    const outsideBefore = snapshotTree(harness.outsideRoot);

    let swapFired = false;
    let outsideEntriesWhileTemporaryExists: string[] | undefined;
    harness.barrier.onBarrier((event) => {
      if (event.barrier === 'before-temp-create' && !swapFired) {
        swapFired = true;
        swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot);
        return;
      }
      if (event.barrier === 'before-rename') outsideEntriesWhileTemporaryExists = readdirSync(harness.outsideRoot);
    });
    const outcome = await executeThroughExecutor(harness, 'write', {
      path: 'sub/target.txt',
      content: 'payload\n',
    });

    assert.ok(swapFired, 'the worker never paused at before-temp-create, so the attack was not performed');
    // Two shapes count as fail-closed here, and the trace says which happened:
    // the temporary is refused outright (no before-rename), or it is staged and
    // stays inside the walked parent. Only a temporary in the outside directory
    // is a failure.
    const reachedRename = harness.barrier.barriersReached.some((event) => event.barrier === 'before-rename');
    assert.equal(
      reachedRename,
      outsideEntriesWhileTemporaryExists !== undefined,
      'the before-rename observation must run exactly when the write reaches the rename',
    );
    assert.deepEqual(
      (outsideEntriesWhileTemporaryExists ?? []).filter((entryName) => entryName.includes('.pi-tmp-')),
      [],
      `the atomic write staged its temporary file outside the workspace: ${everythingReported(outcome)}`,
    );
    assert.deepEqual(
      listTemporaryArtifacts(harness.outsideRoot),
      [],
      'a temporary file was left outside the workspace',
    );
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
    assert.equal(
      reportedSuccess(outcome),
      false,
      `write reported success across a parent swap before the temporary was staged: ${everythingReported(outcome)}`,
    );
  });
});

test('write.execute through the executor: the rename window commits no out-of-workspace replacement', async (testContext) => {
  await withAttackHarness(testContext, 'rename', async (harness) => {
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    writeFileSync(join(harness.workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
    writeFileSync(join(harness.outsideRoot, 'target.txt'), 'victim content\n', 'utf8');
    const outsideBefore = snapshotTree(harness.outsideRoot);

    const swapFired = swapAtBarrier(harness.barrier, 'before-rename', () =>
      swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot),
    );
    const outcome = await executeThroughExecutor(harness, 'write', {
      path: 'sub/target.txt',
      content: 'payload\n',
    });

    assert.ok(swapFired(), 'the worker never paused at before-rename, so the attack was not performed');
    assert.equal(
      readFileSync(join(harness.outsideRoot, 'target.txt'), 'utf8'),
      'victim content\n',
      `the rename window committed a replacement outside the workspace: ${everythingReported(outcome)}`,
    );
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
    assert.equal(
      reportedSuccess(outcome),
      false,
      `write reported success across a parent swap in the rename window: ${everythingReported(outcome)}`,
    );
    assert.ok(
      ['original\n', 'payload\n'].includes(
        readFileSync(join(harness.workspaceRoot, 'sub.real', 'target.txt'), 'utf8'),
      ),
      'the in-workspace file must hold either the original or the new content, never a partial write',
    );
  });
});

test('write.execute through the executor: a failed swap leaves no temporary file outside the workspace', async (testContext) => {
  await withAttackHarness(testContext, 'cleanup', async (harness) => {
    // The swap makes the rename fail; `before-cleanup` then reports which
    // temporary path the implementation believes it is removing, so this test
    // can name the file rather than guess it.
    mkdirSync(join(harness.workspaceRoot, 'sub'));
    writeFileSync(join(harness.workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
    const outsideBefore = snapshotTree(harness.outsideRoot);

    let swapFired = false;
    let cleanupTarget: string | undefined;
    harness.barrier.onBarrier((event) => {
      if (event.barrier === 'before-rename' && !swapFired) {
        swapFired = true;
        swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot);
        return;
      }
      if (event.barrier === 'before-cleanup') cleanupTarget = event.path;
    });
    const outcome = await executeThroughExecutor(harness, 'write', {
      path: 'sub/target.txt',
      content: 'payload\n',
    });

    assert.ok(swapFired, 'the worker never paused at before-rename, so the attack was not performed');
    assert.deepEqual(
      listTemporaryArtifacts(harness.outsideRoot),
      [],
      'a temporary file was left outside the workspace',
    );
    assertNothingChangedOutside(harness.outsideRoot, outsideBefore, outcome);
    assert.equal(
      reportedSuccess(outcome),
      false,
      `write reported success after a failed rename across a parent swap: ${everythingReported(outcome)}`,
    );
    if (cleanupTarget !== undefined) {
      // The temporary the worker could not unlink is one it staged inside the
      // workspace, and the assertion above already proves nothing outside the
      // workspace was touched. Naming it here keeps the residue visible; the
      // todo test below is where the residue itself is owed.
      assert.ok(
        basename(cleanupTarget).includes('.pi-tmp-'),
        `cleanup reported a path that is not one of the tool's temporaries: ${cleanupTarget}`,
      );
    }
  });
});

test(
  'write.execute through the executor: a failed swap leaves no temporary file inside the workspace either',
  {
    todo:
      'ADR 0022 clause "cleanup after a failed swap leaves no temp file inside or outside the workspace": the executor closes the ' +
      'out-of-workspace half of this clause, and only that half. The cleanup unlink re-traverses the same swapped parent the rename ' +
      'did, so it fails too, and the temporary the write staged inside the workspace before the swap is stranded in the real ' +
      'directory. The sandbox cannot help: both the staging and the stranding happen inside the workspace, which is the one tree the ' +
      'worker may write. Closing it needs a descriptor-relative unlink, or a cleanup that unlinks through the descriptor the temporary ' +
      'was created with instead of through its path.',
  },
  async (testContext) => {
    await withAttackHarness(testContext, 'residue', async (harness) => {
      mkdirSync(join(harness.workspaceRoot, 'sub'));
      writeFileSync(join(harness.workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');

      const swapFired = swapAtBarrier(harness.barrier, 'before-rename', () =>
        swapDirectoryForOutsideSymlink(join(harness.workspaceRoot, 'sub'), harness.outsideRoot),
      );
      const outcome = await executeThroughExecutor(harness, 'write', {
        path: 'sub/target.txt',
        content: 'payload\n',
      });

      assert.ok(swapFired(), 'the worker never paused at before-rename, so the attack was not performed');
      assert.deepEqual(
        listTemporaryArtifacts(join(harness.workspaceRoot, 'sub.real')),
        [],
        `the failed write stranded its temporary inside the workspace: ${everythingReported(outcome)}`,
      );
    });
  },
);

test('negative control: the same swap does disclose the file when the sandbox filesystem view is widened', async (testContext) => {
  // The proof that the eight tests above are not vacuous. This provider is the
  // same worker, the same barrier bridge, and the same swap at the same point,
  // with one thing changed: the sandbox can see the directory outside the
  // workspace. The read then leaks, exactly as it does in process. A provider
  // this weak cannot pass the acquire-time self-test, so it is acquired
  // directly and never through acquireVerifiedExecutor.
  if (providerSkip !== undefined) {
    testContext.skip(providerSkip);
    return;
  }
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pi-containment-exec-control-ws-')));
  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pi-containment-exec-control-out-')));
  mkdirSync(join(workspaceRoot, 'sub'));
  writeFileSync(join(workspaceRoot, 'sub', 'notes.txt'), 'workspace content\n', 'utf8');
  writeFileSync(join(outsideRoot, 'notes.txt'), `${OUT_OF_WORKSPACE_SECRET}\n`, 'utf8');

  const widenedProvider =
    process.platform === 'darwin'
      ? createSeatbeltProvider({
          profileFor: (spec, privateTempDir) =>
            `${seatbeltProfile(spec, privateTempDir)}(allow file-read* (subpath ${JSON.stringify(outsideRoot)}))\n`,
        })
      : createBubblewrapProvider({
          commandLineFor: (spec, privateTempDir) => {
            const argv = bubblewrapCommandLine(spec, privateTempDir);
            const separatorAt = argv.indexOf('--');
            argv.splice(separatorAt, 0, '--ro-bind', outsideRoot, outsideRoot);
            return argv;
          },
        });

  const spec = { ...buildSandboxSpec(workspaceRoot), containmentBarrierChannel: true };
  const handle = await widenedProvider.acquire(spec);
  try {
    const barrier = workerHostFor(handle)?.containmentBarrier;
    assert.ok(barrier, 'the widened sandbox has no containment barrier channel');
    let swapFired = false;
    barrier.onBarrier((event) => {
      if (swapFired || event.barrier !== 'before-open') return;
      swapFired = true;
      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
    });
    const executed = await widenedProvider.exec(handle, {
      tool: 'read',
      arguments: { path: 'sub/notes.txt' },
      policy: { workspaceRoot },
      cwd: workspaceRoot,
    });
    assert.ok(swapFired, 'the worker never paused at before-open, so the control proves nothing');
    assert.equal(barrier.failure, undefined, `a barrier handler failed: ${String(barrier.failure)}`);
    assert.match(
      renderedText(executed.result),
      new RegExp(OUT_OF_WORKSPACE_SECRET, 'u'),
      'the control did not reproduce the escape, so the eight tests above may be passing for the wrong reason',
    );
  } finally {
    await widenedProvider.release(handle);
  }
});
