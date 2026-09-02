/**
 * ADR 0022 acceptance regression: descriptor-anchored workspace containment.
 *
 * Every parent-swap test in this file performs the real attack against the
 * current tree and asserts the secure outcome the ADR requires: the operation
 * fails closed at the swap barrier, nothing outside the workspace is read,
 * created, replaced, or left behind. The mechanism does not exist yet, so each
 * of these tests fails on the current tree by design and is marked
 * `{ todo: <ADR clause> }` so the suite reports them as todo instead of
 * breaking CI. They flip to passing only when the descriptor-anchored walk
 * lands. See docs/adr/evidence/0022-containment-test-map.md for the clause map.
 *
 * The one non-todo test at the bottom is a positive control: it proves this
 * harness detects a plain, non-race symlink escape today, so a green run means
 * the file really was exercised.
 *
 * Structure. The first describe block is the acceptance regression proper:
 * every one of the eight ADR 0022 attacks runs through `Tool.execute()` on the
 * real read, write, edit, or map tool, with the swap driven from inside that
 * call by a containment barrier (`containmentBarriers` in
 * packages/core/src/tools/filesystem.ts). A barrier is a test-only seam in the
 * shipped implementation: a callback registered under a named point the
 * implementation already passes through, costing one empty-Map lookup in
 * production. It performs the swap and changes nothing else, so what the test
 * exercises is the complete tool path, not a re-creation of it.
 *
 * The second describe block keeps the earlier lower-level supplements, which
 * drive `resolveWorkspacePath` and `atomicWriteTextFile` directly. They
 * localize a failure to a stage once the end-to-end test above has shown the
 * attack lands; they are not the acceptance evidence themselves. They use two
 * deterministic race simulations, never a timing loop:
 *  - "check-then-operation split": call the containment check the tool calls
 *    (`resolveWorkspacePath`), swap a validated parent directory for a symlink
 *    pointing outside the workspace, then run the operation stage against the
 *    checked result. This is the parent-symlink TOCTOU the ADR describes, with
 *    the window opened by hand instead of by a concurrent swap loop.
 *  - "in-flight hook": drive the swap from inside the tool call itself through
 *    a seam the tool already reads (the map tool polls `context.signal`), so
 *    the whole tool runs end to end across the swap.
 * Each supplement states which approach it uses.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  atomicWriteTextFile,
  containmentBarriers,
  defaultToolExecutionPolicy,
  editTool,
  mapTool,
  readTool,
  resolveWorkspacePath,
  ToolPolicyError,
  writeTool,
  type ContainmentBarrierName,
  type ToolContext,
  type ToolOutput,
} from '../src/tools/index.js';

/**
 * ADR 0022's supported matrix is macOS and Linux. Directory symlink swaps are
 * not the Windows attack shape, so these tests skip there rather than sitting
 * as permanent todos on a platform they do not describe.
 */
const windowsSkipReason =
  process.platform === 'win32'
    ? 'ADR 0022 supported matrix is macOS and Linux; directory-symlink swaps are not the Windows attack shape'
    : undefined;

/** todo everywhere the mechanism is owed, skip where the attack does not apply. */
function pendingClause(adrClause: string): { todo: string } | { skip: string } {
  return windowsSkipReason ? { skip: windowsSkipReason } : { todo: adrClause };
}

function platformGate(): Record<string, never> | { skip: string } {
  return windowsSkipReason ? { skip: windowsSkipReason } : {};
}

interface SwapFixture {
  readonly workspaceRoot: string;
  readonly outsideRoot: string;
  readonly toolContext: ToolContext;
}

/**
 * A workspace containing a single validated subdirectory `sub`, plus a
 * directory outside the workspace that the attacker will redirect `sub` to.
 */
function createSwapFixture(prefix: string): SwapFixture {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), `pi-containment-${prefix}-ws-`)));
  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), `pi-containment-${prefix}-out-`)));
  mkdirSync(join(workspaceRoot, 'sub'));
  const toolContext: ToolContext = {
    cwd: workspaceRoot,
    setCwd: () => undefined,
    policy: defaultToolExecutionPolicy(workspaceRoot),
  };
  return { workspaceRoot, outsideRoot, toolContext };
}

/**
 * The attack itself: a directory component that the containment check already
 * validated becomes a symlink to a directory outside the workspace. The real
 * directory is kept as `<name>.real` so residue assertions can inspect it.
 */
function swapDirectoryForOutsideSymlink(parentPath: string, outsideRoot: string): void {
  renameSync(parentPath, `${parentPath}.real`);
  symlinkSync(outsideRoot, parentPath, 'dir');
}

function captureThrownError(operation: () => void): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function describeError(error: unknown): string {
  if (error === undefined) return 'no error (the operation completed)';
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `${error.constructor.name}${code ? ` [${code}]` : ''}: ${error.message}`;
  }
  return String(error);
}

/** atomicWriteTextFile names its temporaries `.<basename>.pi-tmp-<pid>-<uuid>`. */
function listTemporaryArtifacts(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) return [];
  return readdirSync(directoryPath).filter((entryName) => entryName.includes('.pi-tmp-'));
}

/**
 * Open and read a checked path exactly the way read.ts opens it: O_RDONLY plus
 * O_NOFOLLOW, which guards the final component only.
 */
function readCheckedPathTheWayReadToolDoes(checkedPath: string): string {
  const descriptor = openSync(checkedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

const OUT_OF_WORKSPACE_SECRET = 'OUT_OF_WORKSPACE_SECRET_MUST_NOT_BE_DISCLOSED';

/** Depth of the directory chain the map walk queues as plain path strings. */
const MAP_CHAIN_LEVELS = ['1', '2', '3', '4', '5'];
/**
 * The map walk reads `context.signal.aborted` once before the loop and once per
 * queued directory and per directory entry. With the tree the supplement builds
 * below, the swap window (the top of the chain is queued but not yet opened)
 * spans accesses 4 through 25, so the swap fires at 12, comfortably inside it.
 */
const MAP_SWAP_AT_SIGNAL_ACCESS = 12;
const MAP_LEAK_MARKER = 'LEAKED_MARKER';

interface AttackOutcome {
  /** The tool's own output, when it returned one. */
  readonly output: ToolOutput | undefined;
  /** What the tool threw, when it threw instead. */
  readonly thrown: unknown;
}

/**
 * Run one real `Tool.execute()` with barriers registered at the named points of
 * the shipped implementation, and always clear the registry afterwards so a
 * swap cannot leak into the next test. Both a returned output and a thrown
 * error are outcomes worth asserting on: fail-closed may take either shape.
 */
async function runToolWithBarriers(
  barriers: Partial<Record<ContainmentBarrierName, (path: string) => void>>,
  execute: () => Promise<ToolOutput>,
): Promise<AttackOutcome> {
  for (const [barrierName, barrier] of Object.entries(barriers)) {
    containmentBarriers.set(barrierName as ContainmentBarrierName, barrier!);
  }
  try {
    return { output: await execute(), thrown: undefined };
  } catch (error) {
    return { output: undefined, thrown: error };
  } finally {
    containmentBarriers.clear();
  }
}

function renderedText(output: ToolOutput | undefined): string {
  if (!output) return '';
  return output.content.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n');
}

/** True when the tool completed without reporting a refusal. */
function reportedSuccess(outcome: AttackOutcome): boolean {
  return outcome.thrown === undefined && outcome.output !== undefined && outcome.output.isError !== true;
}

function assertNoTemporaryResidue(directoryPaths: readonly string[]): void {
  for (const directoryPath of directoryPaths) {
    assert.deepEqual(
      listTemporaryArtifacts(directoryPath),
      [],
      `a temporary file was left behind in ${directoryPath}`,
    );
  }
}

describe('ADR 0022 acceptance regression: complete tool paths across a parent swap', () => {
  test(
    'read.execute: a parent swapped mid-call must not disclose an out-of-workspace file',
    pendingClause('ADR 0022: parent-swap during read fails closed; no host file disclosed'),
    async () => {
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-read');
      writeFileSync(join(workspaceRoot, 'sub', 'notes.txt'), 'workspace content\n', 'utf8');
      writeFileSync(join(outsideRoot, 'notes.txt'), `${OUT_OF_WORKSPACE_SECRET}\n`, 'utf8');

      let swapFired = false;
      const outcome = await runToolWithBarriers(
        {
          'before-open': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
        },
        () => readTool.execute({ path: 'sub/notes.txt' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.ok(
        !renderedText(outcome.output).includes(OUT_OF_WORKSPACE_SECRET),
        `read disclosed an out-of-workspace file through the swapped parent: ${renderedText(outcome.output)}`,
      );
      if (reportedSuccess(outcome)) {
        assert.match(
          renderedText(outcome.output),
          /workspace content/,
          'a read that reports success must have read the in-workspace file',
        );
      }
    },
  );

  test(
    'write.execute: a parent swapped mid-call must not create a file outside the workspace',
    pendingClause('ADR 0022: parent-swap during write fails closed; no out-of-workspace file created'),
    async () => {
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-write');

      let swapFired = false;
      const outcome = await runToolWithBarriers(
        {
          'before-temp-create': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
        },
        () => writeTool.execute({ path: 'sub/created.txt', content: 'payload\n' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.deepEqual(
        readdirSync(outsideRoot),
        [],
        `write created an entry outside the workspace (${describeError(outcome.thrown)})`,
      );
      if (reportedSuccess(outcome)) {
        assert.equal(
          readFileSync(join(workspaceRoot, 'sub.real', 'created.txt'), 'utf8'),
          'payload\n',
          'a write that reports success must have written the in-workspace file',
        );
      }
    },
  );

  test(
    'edit.execute: a parent swapped mid-call must not replace an out-of-workspace file',
    pendingClause('ADR 0022: parent-swap during edit fails closed; temp files cleaned up'),
    async () => {
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-edit');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
      writeFileSync(join(outsideRoot, 'target.txt'), 'victim content\n', 'utf8');

      let swapFired = false;
      const outcome = await runToolWithBarriers(
        {
          'before-temp-create': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
        },
        () => editTool.execute({ path: 'sub/target.txt', old_text: 'original', new_text: 'edited' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.equal(
        readFileSync(join(outsideRoot, 'target.txt'), 'utf8'),
        'victim content\n',
        `edit rewrote a file outside the workspace (${describeError(outcome.thrown)})`,
      );
      assertNoTemporaryResidue([outsideRoot, workspaceRoot, join(workspaceRoot, 'sub.real')]);
      assert.ok(
        ['original\n', 'edited\n'].includes(readFileSync(join(workspaceRoot, 'sub.real', 'target.txt'), 'utf8')),
        'the in-workspace file must hold either the original or the edited content, never a partial write',
      );
    },
  );

  test(
    'map.execute: a queued directory swapped mid-walk must not redirect the traversal outside the workspace',
    pendingClause(
      'ADR 0022: parent-swap during map traversal fails closed; a swapped queued directory cannot redirect the walk',
    ),
    async () => {
      const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pi-containment-e2e-map-ws-')));
      const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pi-containment-e2e-map-out-')));
      let insideDirectory = join(workspaceRoot, 'chain');
      let outsideDirectory = outsideRoot;
      mkdirSync(insideDirectory);
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
      const toolContext: ToolContext = {
        cwd: workspaceRoot,
        setCwd: () => undefined,
        policy: defaultToolExecutionPolicy(workspaceRoot),
      };

      // The walk queues directories as path strings. The swap fires when the
      // walk is about to open the first queued child, so `chain` has already
      // been validated and walked when it becomes a symlink.
      const firstQueuedChild = join(workspaceRoot, 'chain', MAP_CHAIN_LEVELS[0]!);
      let swapFired = false;
      const outcome = await runToolWithBarriers(
        {
          'before-map-directory-open': (directoryPath: string) => {
            if (swapFired || directoryPath !== firstQueuedChild) return;
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'chain'), outsideRoot);
          },
        },
        () => mapTool.execute({ depth: 8 }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.ok(
        !renderedText(outcome.output).includes(MAP_LEAK_MARKER),
        `the swapped directory redirected the map walk outside the workspace:\n${renderedText(outcome.output)}`,
      );
    },
  );

  test(
    'write.execute: intermediate directory creation through a swapped parent must not build directories outside the workspace',
    pendingClause('ADR 0022: parent-swap during intermediate directory creation (write to a new nested path) fails closed'),
    async () => {
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-mkdir');

      let swapFired = false;
      const outcome = await runToolWithBarriers(
        {
          'before-mkdir': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
        },
        () => writeTool.execute({ path: 'sub/created/deep/file.txt', content: 'payload\n' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.deepEqual(
        readdirSync(outsideRoot),
        [],
        `write built a directory tree outside the workspace (${describeError(outcome.thrown)})`,
      );
    },
  );

  test(
    'write.execute: the temporary file must stay inside the walked parent after a parent swap',
    pendingClause('ADR 0022: temporary-file placement for atomic writes stays inside the walked parent'),
    async () => {
      // The `before-rename` barrier is an observation point, not a second
      // attack: it lists the outside directory at the moment the temporary
      // exists, which is the only moment its placement is visible.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-temp');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
      writeFileSync(join(outsideRoot, 'target.txt'), 'victim content\n', 'utf8');

      let swapFired = false;
      let outsideEntriesWhileTemporaryExists: string[] | undefined;
      const outcome = await runToolWithBarriers(
        {
          'before-temp-create': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
          'before-rename': () => {
            outsideEntriesWhileTemporaryExists = readdirSync(outsideRoot);
          },
        },
        () => writeTool.execute({ path: 'sub/target.txt', content: 'payload\n' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.deepEqual(
        (outsideEntriesWhileTemporaryExists ?? []).filter((entryName) => entryName.includes('.pi-tmp-')),
        [],
        `the atomic write staged its temporary file outside the workspace (${describeError(outcome.thrown)})`,
      );
      assertNoTemporaryResidue([outsideRoot, workspaceRoot, join(workspaceRoot, 'sub.real')]);
    },
  );

  test(
    'write.execute: the rename window must not commit an out-of-workspace replacement',
    pendingClause('ADR 0022: swap between temp create and rename fails closed'),
    async () => {
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-rename');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
      writeFileSync(join(outsideRoot, 'target.txt'), 'victim content\n', 'utf8');

      let swapFired = false;
      const outcome = await runToolWithBarriers(
        {
          'before-rename': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
        },
        () => writeTool.execute({ path: 'sub/target.txt', content: 'payload\n' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assert.equal(
        readFileSync(join(outsideRoot, 'target.txt'), 'utf8'),
        'victim content\n',
        `the rename window committed a replacement outside the workspace (${describeError(outcome.thrown)})`,
      );
      assertNoTemporaryResidue([outsideRoot, workspaceRoot, join(workspaceRoot, 'sub.real')]);
      assert.ok(
        ['original\n', 'payload\n'].includes(readFileSync(join(workspaceRoot, 'sub.real', 'target.txt'), 'utf8')),
        'the in-workspace file must hold either the original or the new content, never a partial write',
      );
    },
  );

  test(
    'write.execute: a failed swap must leave no temporary file inside or outside the workspace',
    pendingClause('ADR 0022: cleanup after a failed swap leaves no temp file inside or outside the workspace'),
    async () => {
      // The swap makes the rename fail; `before-cleanup` then reports which
      // temporary path the implementation believes it is removing, so the test
      // can check that this exact file is gone rather than guessing its name.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('e2e-cleanup');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');

      let swapFired = false;
      let cleanupTarget: string | undefined;
      const outcome = await runToolWithBarriers(
        {
          'before-rename': () => {
            swapFired = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
          },
          'before-cleanup': (temporaryPath: string) => {
            cleanupTarget = temporaryPath;
          },
        },
        () => writeTool.execute({ path: 'sub/target.txt', content: 'payload\n' }, toolContext),
      );

      assert.ok(swapFired, 'the in-flight swap never fired, so the attack was not performed');
      assertNoTemporaryResidue([outsideRoot, workspaceRoot, join(workspaceRoot, 'sub.real')]);
      assert.deepEqual(readdirSync(outsideRoot), [], 'the failed write created an entry outside the workspace');
      if (cleanupTarget !== undefined) {
        assert.equal(
          readdirSync(join(workspaceRoot, 'sub.real')).includes(basename(cleanupTarget)),
          false,
          `cleanup reported removing ${cleanupTarget} but that file is still in the workspace (${describeError(outcome.thrown)})`,
        );
      }
    },
  );
});

describe('lower-level supplements: single-stage checks behind the end-to-end attacks above', () => {
  test(
    'read: a parent swapped after the containment check must not disclose an out-of-workspace file',
    pendingClause('ADR 0022: parent-swap during read fails closed; no host file disclosed'),
    async () => {
      // Race simulation: check-then-operation split. resolveWorkspacePath is the
      // exact containment check read.ts performs; the swap lands between it and
      // the open, which is where read.ts re-traverses the returned path string.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('read');
      writeFileSync(join(workspaceRoot, 'sub', 'notes.txt'), 'workspace content\n', 'utf8');
      writeFileSync(join(outsideRoot, 'notes.txt'), `${OUT_OF_WORKSPACE_SECRET}\n`, 'utf8');

      const checkedPath = resolveWorkspacePath(toolContext, 'sub/notes.txt');
      assert.equal(checkedPath, join(workspaceRoot, 'sub', 'notes.txt'));

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);

      // Anchor: a swap observed before the check is already refused today.
      await assert.rejects(
        () => readTool.execute({ path: 'sub/notes.txt' }, toolContext),
        /path escapes workspace/,
      );

      // The clause under test: the checked result must not remain re-traversable.
      let disclosedContent = '';
      const thrownError = captureThrownError(() => {
        disclosedContent = readCheckedPathTheWayReadToolDoes(checkedPath);
      });
      assert.ok(
        !disclosedContent.includes(OUT_OF_WORKSPACE_SECRET),
        'the swapped parent disclosed an out-of-workspace file through the checked path',
      );
      assert.ok(
        thrownError !== undefined,
        `expected the read to fail closed at the swap barrier, got ${describeError(thrownError)}`,
      );
    },
  );

  test(
    'write: a parent swapped after the containment check must not create a file outside the workspace',
    pendingClause('ADR 0022: parent-swap during write fails closed; no out-of-workspace file created'),
    async () => {
      // Race simulation: check-then-operation split. resolveWorkspacePath then
      // atomicWriteTextFile are write.ts's own check and operation stages.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('write');
      const checkedPath = resolveWorkspacePath(toolContext, 'sub/created.txt', { mustExist: false });

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);

      const thrownError = captureThrownError(() => atomicWriteTextFile(checkedPath, 'payload'));
      assert.ok(
        thrownError instanceof ToolPolicyError,
        `expected the write to fail closed at the swap barrier, got ${describeError(thrownError)}`,
      );
      assert.equal(
        existsSync(join(outsideRoot, 'created.txt')),
        false,
        'the swapped parent let the write create a file outside the workspace',
      );
      assert.deepEqual(listTemporaryArtifacts(outsideRoot), [], 'a temporary file was left outside the workspace');
    },
  );

  test(
    'edit: a parent swapped after the containment check must not replace an out-of-workspace file',
    pendingClause('ADR 0022: parent-swap during edit fails closed; temp files cleaned up'),
    async () => {
      // Race simulation: check-then-operation split. edit.ts checks the path,
      // reads the file, then commits through atomicWriteTextFile; the swap lands
      // in the window before that commit.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('edit');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
      writeFileSync(join(outsideRoot, 'target.txt'), 'victim content\n', 'utf8');

      const checkedPath = resolveWorkspacePath(toolContext, 'sub/target.txt');

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);

      const thrownError = captureThrownError(() => atomicWriteTextFile(checkedPath, 'edited\n'));
      assert.ok(
        thrownError instanceof ToolPolicyError,
        `expected the edit commit to fail closed at the swap barrier, got ${describeError(thrownError)}`,
      );
      assert.equal(
        readFileSync(join(outsideRoot, 'target.txt'), 'utf8'),
        'victim content\n',
        'the swapped parent let the edit rewrite a file outside the workspace',
      );
      assert.deepEqual(listTemporaryArtifacts(outsideRoot), [], 'a temporary file was left outside the workspace');
    },
  );

  test(
    'map: a queued directory swapped mid-walk must not redirect the traversal outside the workspace',
    pendingClause('ADR 0022: parent-swap during map traversal fails closed; a swapped queued directory cannot redirect the walk'),
    async () => {
      // Race simulation: in-flight hook. map.ts polls context.signal during the
      // walk, so the swap happens inside a single mapTool.execute call, after the
      // chain has been queued as path strings and before those strings are opened.
      const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pi-containment-map-ws-')));
      const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pi-containment-map-out-')));
      let insideDirectory = join(workspaceRoot, 'chain');
      let outsideDirectory = outsideRoot;
      mkdirSync(insideDirectory);
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

      let signalAccesses = 0;
      let swapPerformed = false;
      const walkSignal = new AbortController().signal;
      Object.defineProperty(walkSignal, 'aborted', {
        configurable: true,
        get(): boolean {
          signalAccesses++;
          if (signalAccesses === MAP_SWAP_AT_SIGNAL_ACCESS && !swapPerformed) {
            swapPerformed = true;
            swapDirectoryForOutsideSymlink(join(workspaceRoot, 'chain'), outsideRoot);
          }
          return false;
        },
      });

      const toolContext: ToolContext = {
        cwd: workspaceRoot,
        setCwd: () => undefined,
        policy: defaultToolExecutionPolicy(workspaceRoot),
        signal: walkSignal,
      };

      const result = await mapTool.execute({ depth: 8 }, toolContext);
      const renderedMap = (result.content[0] as { text: string }).text;

      assert.ok(swapPerformed, 'the in-flight swap never fired; re-derive MAP_SWAP_AT_SIGNAL_ACCESS');
      assert.ok(
        !renderedMap.includes(MAP_LEAK_MARKER),
        `the swapped directory redirected the map walk outside the workspace:\n${renderedMap}`,
      );
    },
  );

  test(
    'write: intermediate directory creation through a swapped parent must not build directories outside the workspace',
    pendingClause('ADR 0022: parent-swap during intermediate directory creation (write to a new nested path) fails closed'),
    async () => {
      // Race simulation: check-then-operation split. write.ts checks the path with
      // mustExist:false and then runs mkdirSync(dirname(path), {recursive:true})
      // against the returned string; the swap lands between those two stages.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('mkdir');
      const checkedPath = resolveWorkspacePath(toolContext, 'sub/created/deep/file.txt', { mustExist: false });

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);

      const thrownError = captureThrownError(() => mkdirSync(dirname(checkedPath), { recursive: true }));
      assert.ok(
        thrownError instanceof ToolPolicyError,
        `expected intermediate directory creation to fail closed at the swap barrier, got ${describeError(thrownError)}`,
      );
      assert.equal(
        existsSync(join(outsideRoot, 'created')),
        false,
        'the swapped parent let mkdir build a directory tree outside the workspace',
      );
    },
  );

  test(
    'atomic write: the temporary file must stay inside the walked parent after a parent swap',
    pendingClause('ADR 0022: temporary-file placement for atomic writes stays inside the walked parent'),
    async () => {
      // Race simulation: check-then-operation split. The outside directory is made
      // unwritable, so on the current tree the temp create fails with EACCES *in
      // that directory*, which is itself the proof the temporary was placed
      // outside the workspace. Fail-closed means a containment refusal instead.
      // (A run as root would defeat the unwritable directory; the assertion on the
      // error type still holds because the refusal must precede the open.)
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('temp');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
      writeFileSync(join(outsideRoot, 'target.txt'), 'victim content\n', 'utf8');

      const checkedPath = resolveWorkspacePath(toolContext, 'sub/target.txt');

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);
      chmodSync(outsideRoot, 0o500);
      let thrownError: unknown;
      try {
        thrownError = captureThrownError(() => atomicWriteTextFile(checkedPath, 'payload\n'));
      } finally {
        chmodSync(outsideRoot, 0o700);
      }

      assert.ok(
        thrownError instanceof ToolPolicyError,
        `expected the temporary file to be refused at the swap barrier, got ${describeError(thrownError)}`,
      );
      assert.deepEqual(
        readdirSync(outsideRoot).sort(),
        ['target.txt'],
        'the atomic write touched the directory outside the workspace',
      );
    },
  );

  test(
    'atomic write: the rename window must not commit an out-of-workspace replacement',
    pendingClause('ADR 0022: swap between temp create and rename fails closed'),
    async () => {
      // Race simulation: check-then-operation split. The swap is in place before
      // atomicWriteTextFile runs, so its temp-create and rename both act on the
      // redirected parent; the rename is the step that commits the escape.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('rename');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');
      writeFileSync(join(outsideRoot, 'target.txt'), 'victim content\n', 'utf8');

      const checkedPath = resolveWorkspacePath(toolContext, 'sub/target.txt');

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);

      const thrownError = captureThrownError(() => atomicWriteTextFile(checkedPath, 'payload\n'));
      assert.ok(
        thrownError instanceof ToolPolicyError,
        `expected the rename to fail closed at the swap barrier, got ${describeError(thrownError)}`,
      );
      assert.equal(
        readFileSync(join(outsideRoot, 'target.txt'), 'utf8'),
        'victim content\n',
        'the rename window committed a replacement outside the workspace',
      );
      assert.equal(
        readFileSync(join(workspaceRoot, 'sub.real', 'target.txt'), 'utf8'),
        'original\n',
        'the in-workspace file must be untouched when the write fails closed',
      );
    },
  );

  test(
    'atomic write: a failed swap must leave no temporary file inside or outside the workspace',
    pendingClause('ADR 0022: cleanup after a failed swap leaves no temp file inside or outside the workspace'),
    async () => {
      // Race simulation: check-then-operation split, same shape as the rename
      // window, asserting on residue rather than on the committed bytes.
      const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('cleanup');
      writeFileSync(join(workspaceRoot, 'sub', 'target.txt'), 'original\n', 'utf8');

      const checkedPath = resolveWorkspacePath(toolContext, 'sub/target.txt');

      swapDirectoryForOutsideSymlink(join(workspaceRoot, 'sub'), outsideRoot);

      const thrownError = captureThrownError(() => atomicWriteTextFile(checkedPath, 'payload\n'));
      assert.ok(
        thrownError instanceof ToolPolicyError,
        `expected the write to fail closed at the swap barrier, got ${describeError(thrownError)}`,
      );
      assert.deepEqual(listTemporaryArtifacts(outsideRoot), [], 'a temporary file was left outside the workspace');
      assert.deepEqual(listTemporaryArtifacts(workspaceRoot), [], 'a temporary file was left in the workspace root');
      assert.deepEqual(
        listTemporaryArtifacts(join(workspaceRoot, 'sub.real')),
        [],
        'a temporary file was left in the real workspace directory',
      );
      assert.deepEqual(readdirSync(outsideRoot), [], 'the failed write created an entry outside the workspace');
    },
  );
});

test(
  'positive control: a plain symlink escape out of the workspace is refused today',
  platformGate(),
  async () => {
    // Not a race: the symlink is in place before the containment check runs, so
    // the current tree already refuses it. This test is the harness's own proof
    // of life; it must stay green while the todo tests above stay red.
    const { workspaceRoot, outsideRoot, toolContext } = createSwapFixture('control');
    writeFileSync(join(outsideRoot, 'notes.txt'), `${OUT_OF_WORKSPACE_SECRET}\n`, 'utf8');
    symlinkSync(outsideRoot, join(workspaceRoot, 'escape'), 'dir');

    await assert.rejects(
      () => readTool.execute({ path: 'escape/notes.txt' }, toolContext),
      /path escapes workspace/,
    );
    await assert.rejects(
      () => writeTool.execute({ path: 'escape/created.txt', content: 'payload' }, toolContext),
      /path escapes workspace/,
    );
    assert.equal(existsSync(join(outsideRoot, 'created.txt')), false);
    assert.throws(() => resolveWorkspacePath(toolContext, 'escape/notes.txt'), ToolPolicyError);
  },
);
