import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  bashTool,
  defaultToolExecutionPolicy,
  editTool,
  readTool,
  workspaceFoldsPathCase,
  writeTool,
  type ToolContext,
  type ToolExecutionPolicy,
} from '../src/tools/index.js';
import { truncateMiddle } from '../src/truncate.js';
import { EDIT_MAX_FILE_BYTES } from '../src/tools/edit.js';
import { WRITE_MAX_PRECONDITION_BYTES } from '../src/tools/write.js';

function makeContext(
  cwd: string,
  policy: ToolExecutionPolicy = {
    ...defaultToolExecutionPolicy(cwd),
    bash: { allowHostExecution: true },
  },
): ToolContext & { current: () => string } {
  let dir = cwd;
  return {
    get cwd() {
      return dir;
    },
    setCwd(next: string) {
      dir = next;
    },
    policy,
    current: () => dir,
  };
}

const workDir = mkdtempSync(join(tmpdir(), 'pi-tools-'));
const context = makeContext(workDir);

test('write then read roundtrip', async () => {
  const result = await writeTool.execute({ path: 'nested/dir/hello.txt', content: 'line1\nline2\nline3' }, context);
  assert.equal(result.isError, undefined);
  const read = await readTool.execute({ path: 'nested/dir/hello.txt' }, context);
  assert.equal(read.content[0]?.type, 'text');
  assert.match((read.content[0] as { text: string }).text, /line1\nline2\nline3/);
});

test('read with offset and limit reports the window', async () => {
  const read = await readTool.execute({ path: 'nested/dir/hello.txt', offset: 2, limit: 1 }, context);
  const text = (read.content[0] as { text: string }).text;
  assert.match(text, /^line2/);
  assert.match(text, /showing lines 2-2 of 3/);
});

test('edit requires unique match unless replace_all', async () => {
  const editContext = makeContext(workDir);
  const file = join(workDir, 'edit.txt');
  writeFileSync(file, 'aaa bbb aaa', 'utf8');
  const ambiguous = await editTool.execute({ path: 'edit.txt', old_text: 'aaa', new_text: 'xxx' }, editContext);
  assert.equal(ambiguous.isError, true);
  const all = await editTool.execute(
    { path: 'edit.txt', old_text: 'aaa', new_text: 'xxx', replace_all: true },
    editContext,
  );
  assert.equal(all.isError, undefined);
  assert.equal(readFileSync(file, 'utf8'), 'xxx bbb xxx');
  const missing = await editTool.execute({ path: 'edit.txt', old_text: 'zzz', new_text: 'y' }, editContext);
  assert.equal(missing.isError, true);
});

test('edit rejects an oversized file from metadata before reading it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-edit-size-'));
  const file = join(root, 'oversized.txt');
  writeFileSync(file, '');
  truncateSync(file, EDIT_MAX_FILE_BYTES + 1);

  const result = await editTool.execute(
    { path: 'oversized.txt', old_text: 'x', new_text: 'y' },
    makeContext(root),
  );
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /file too large to edit/);
  assert.equal(statSync(file).size, EDIT_MAX_FILE_BYTES + 1);
});

test('replace_all is literal and refuses replacement amplification beyond the file cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-edit-expansion-'));
  const literalFile = join(root, 'literal.txt');
  writeFileSync(literalFile, 'x x');
  const literal = await editTool.execute(
    { path: 'literal.txt', old_text: 'x', new_text: '$&', replace_all: true },
    makeContext(root),
  );
  assert.equal(literal.isError, undefined);
  assert.equal(readFileSync(literalFile, 'utf8'), '$& $&');

  const expansionFile = join(root, 'expansion.txt');
  const original = 'x'.repeat(1_000);
  writeFileSync(expansionFile, original);
  const expansion = await editTool.execute(
    { path: 'expansion.txt', old_text: 'x', new_text: 'z'.repeat(10_001), replace_all: true },
    makeContext(root),
  );
  assert.equal(expansion.isError, true);
  assert.match((expansion.content[0] as { text: string }).text, /edit output would be too large/);
  assert.equal(readFileSync(expansionFile, 'utf8'), original);
});

test('bash runs commands and persists cwd across calls', async () => {
  const result = await bashTool.execute({ command: 'echo hello && mkdir -p sub && cd sub' }, context);
  assert.match((result.content[0] as { text: string }).text, /hello/);
  assert.equal(realpathSync(context.current()), realpathSync(join(workDir, 'sub')));
  const pwd = await bashTool.execute({ command: 'pwd' }, context);
  assert.match((pwd.content[0] as { text: string }).text, /sub/);
});

test('bash reports nonzero exit as error output', async () => {
  const result = await bashTool.execute({ command: 'echo boom >&2; exit 3' }, context);
  assert.equal(result.isError, true);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /boom/);
  assert.match(text, /exit code 3/);
});

test('bash timeout kills the whole process group (background children included)', async () => {
  const started = Date.now();
  const result = await bashTool.execute({ command: 'sleep 60 & echo started; wait', timeout_seconds: 1 }, context);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6000, `settled in ${elapsed}ms — the promise must not hang on surviving children`);
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /timed out/);
});

test('bash kills background descendants before reporting a successful shell exit', { skip: process.platform === 'win32' }, async () => {
  const result = await bashTool.execute(
    { command: 'sleep 30 >/dev/null 2>&1 & printf "%s" "$!"' },
    makeContext(workDir),
  );
  assert.equal(result.isError, undefined);
  const pid = Number((result.content[0] as { text: string }).text.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else throw error;
    }
  }
  if (alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
  assert.equal(alive, false, `background pid ${pid} survived the tool result`);
});

test('bash abort signal terminates a running command', async () => {
  const controller = new AbortController();
  const abortContext = { ...makeContext(workDir), signal: controller.signal };
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const result = await bashTool.execute({ command: 'sleep 30' }, abortContext);
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /interrupted/);
});

test('write rejects non-string content instead of truncating the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-content-'));
  const localContext = makeContext(root);
  const file = join(root, 'precious.txt');
  writeFileSync(file, 'do not lose me', 'utf8');
  // the throw becomes an isError tool result in the agent loop
  await assert.rejects(() => writeTool.execute({ path: 'precious.txt', content: null }, localContext), /must be a string/);
  assert.equal(readFileSync(file, 'utf8'), 'do not lose me');
});

test('file tools reject parent traversal and absolute paths by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-containment-'));
  const localContext = makeContext(root);
  writeFileSync(join(root, 'inside.txt'), 'inside', 'utf8');

  await assert.rejects(() => readTool.execute({ path: '../outside.txt' }, localContext), /parent path traversal/);
  await assert.rejects(() => readTool.execute({ path: join(root, 'inside.txt') }, localContext), /absolute paths/);
  await assert.rejects(
    () => writeTool.execute({ path: '../new.txt', content: 'escape' }, localContext),
    /parent path traversal/,
  );
});

test('absolute-path opt-in still confines canonical targets to the workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-absolute-'));
  const outside = mkdtempSync(join(tmpdir(), 'pi-absolute-outside-'));
  const insidePath = join(root, 'inside.txt');
  writeFileSync(insidePath, 'inside', 'utf8');
  writeFileSync(join(outside, 'outside.txt'), 'outside', 'utf8');
  const localContext = makeContext(root, {
    ...defaultToolExecutionPolicy(root),
    allowAbsolutePaths: true,
  });

  const result = await readTool.execute({ path: insidePath }, localContext);
  assert.equal((result.content[0] as { text: string }).text, 'inside');
  await assert.rejects(
    () => readTool.execute({ path: join(outside, 'outside.txt') }, localContext),
    /path escapes workspace/,
  );
});

test('file tools reject symlink escapes for existing and new targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'pi-symlink-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');
  symlinkSync(outside, join(root, 'escape'), 'dir');
  const localContext = makeContext(root);

  await assert.rejects(() => readTool.execute({ path: 'escape/secret.txt' }, localContext), /path escapes workspace/);
  await assert.rejects(
    () => writeTool.execute({ path: 'escape/new.txt', content: 'escaped' }, localContext),
    /path escapes workspace/,
  );
  await assert.rejects(
    () => editTool.execute({ path: 'escape/secret.txt', old_text: 'secret', new_text: 'changed' }, localContext),
    /path escapes workspace/,
  );
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
});

test('read, write, and edit reject special files without opening them', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-special-'));
  const fifo = join(root, 'named-pipe');
  execFileSync('mkfifo', [fifo]);
  const localContext = makeContext(root);

  const read = await readTool.execute({ path: 'named-pipe' }, localContext);
  assert.equal(read.isError, true);
  assert.match((read.content[0] as { text: string }).text, /regular file/);
  await assert.rejects(
    () => writeTool.execute({ path: 'named-pipe', content: 'blocked' }, localContext),
    /regular file/,
  );
  await assert.rejects(
    () => editTool.execute({ path: 'named-pipe', old_text: 'a', new_text: 'b' }, localContext),
    /regular file/,
  );
});

test('write and edit atomically replace regular files and preserve their mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-atomic-'));
  const path = join(root, 'atomic.txt');
  writeFileSync(path, 'before', 'utf8');
  chmodSync(path, 0o640);
  const localContext = makeContext(root);
  const initialInode = statSync(path).ino;

  await writeTool.execute({ path: 'atomic.txt', content: 'middle' }, localContext);
  const afterWrite = statSync(path);
  assert.notEqual(afterWrite.ino, initialInode, 'write must commit by rename, not truncate in place');
  assert.equal(afterWrite.mode & 0o777, 0o640);

  await editTool.execute({ path: 'atomic.txt', old_text: 'middle', new_text: 'after' }, localContext);
  const afterEdit = statSync(path);
  assert.notEqual(afterEdit.ino, afterWrite.ino, 'edit must commit by rename, not modify in place');
  assert.equal(afterEdit.mode & 0o777, 0o640);
  assert.equal(readFileSync(path, 'utf8'), 'after');
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes('.pi-tmp-')),
    [],
  );
});

test('bash inherits a minimal environment and omits credentials by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-bash-env-'));
  const originalOpenAiKey = process.env['OPENAI_API_KEY'];
  const originalSecret = process.env['PI_TEST_SECRET_TOKEN'];
  process.env['OPENAI_API_KEY'] = 'must-not-reach-tool';
  process.env['PI_TEST_SECRET_TOKEN'] = 'must-not-reach-tool';
  try {
    const result = await bashTool.execute(
      {
        command:
          'printf \'openai=%s secret=%s path=%s\' "${OPENAI_API_KEY:+present}" "${PI_TEST_SECRET_TOKEN:+present}" "${PATH:+present}"',
      },
      makeContext(root),
    );
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /openai= secret= path=present/);
    assert.ok(!text.includes('must-not-reach-tool'));
  } finally {
    if (originalOpenAiKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = originalOpenAiKey;
    if (originalSecret === undefined) delete process.env['PI_TEST_SECRET_TOKEN'];
    else process.env['PI_TEST_SECRET_TOKEN'] = originalSecret;
  }
});

test('bash children carry this process nesting depth plus one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-bash-depth-'));
  const originalDepth = process.env['PI_DEPTH'];
  const readDepth = async (): Promise<string> => {
    const result = await bashTool.execute({ command: `printf '%s' "$PI_DEPTH"` }, makeContext(root));
    return (result.content[0] as { text: string }).text;
  };
  try {
    delete process.env['PI_DEPTH'];
    assert.equal(await readDepth(), '1', 'a root run hands its children depth 1');

    process.env['PI_DEPTH'] = '2';
    assert.equal(await readDepth(), '3');

    // A value the parent process cannot vouch for counts as the root depth
    // rather than being passed through unchanged.
    process.env['PI_DEPTH'] = 'garbage';
    assert.equal(await readDepth(), '1');
  } finally {
    if (originalDepth === undefined) delete process.env['PI_DEPTH'];
    else process.env['PI_DEPTH'] = originalDepth;
  }
});

test('bash policy can explicitly inject environment without inheriting other variables', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-bash-policy-'));
  const localContext = makeContext(root, {
    ...defaultToolExecutionPolicy(root),
    bash: { allowHostExecution: true, environment: { PI_EXPLICIT_VALUE: 'allowed' } },
  });
  const result = await bashTool.execute({ command: `printf '%s' "$PI_EXPLICIT_VALUE"` }, localContext);
  assert.equal((result.content[0] as { text: string }).text, 'allowed');
});

test('bash refuses to persist a cwd outside the stable workspace', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'pi-bash-cwd-'));
  const root = join(parent, 'workspace');
  mkdirSync(root);
  const localContext = makeContext(root);

  const result = await bashTool.execute({ command: 'cd ..' }, localContext);
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /working directory rejected.*path escapes workspace/s);
  assert.equal(realpathSync(localContext.current()), realpathSync(root));
});

test('bash policy blocks host execution before spawning a process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-bash-denied-'));
  const marker = join(root, 'must-not-exist');
  const localContext = makeContext(root, {
    ...defaultToolExecutionPolicy(root),
    bash: { allowHostExecution: false },
  });

  const result = await bashTool.execute({ command: 'touch must-not-exist' }, localContext);
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /host bash execution is disabled/);
  assert.equal(existsSync(marker), false);
});

test('bash is fail-closed when a core consumer omits tool policy', async () => {
  let cwd = workDir;
  const noPolicy: ToolContext = {
    get cwd() {
      return cwd;
    },
    setCwd(next) {
      cwd = next;
    },
  };
  const result = await bashTool.execute({ command: 'touch must-not-run-without-policy' }, noPolicy);
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /disabled by tool policy/);
  assert.equal(existsSync(join(workDir, 'must-not-run-without-policy')), false);
});

const PROTECTED_TARGETS = [
  '.git/config',
  '.git/hooks/pre-commit',
  '.pi/state.json',
  '.agent/commands/go.md',
  '.claude/settings.json',
  'AGENTS.md',
  '.mcp.json',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
];

function makeProtectedWorkspace(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  for (const target of PROTECTED_TARGETS) {
    const path = join(root, target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'original', 'utf8');
  }
  return root;
}

test('write and edit refuse every protected path inside the workspace', async () => {
  const root = makeProtectedWorkspace('pi-protected-');
  const localContext = makeContext(root);

  for (const target of PROTECTED_TARGETS) {
    await assert.rejects(
      () => writeTool.execute({ path: target, content: 'persisted' }, localContext),
      (error: Error) => {
        assert.match(error.message, /protected path refused/);
        assert.ok(error.message.includes(target), `refusal must name ${target}`);
        return true;
      },
      `write must refuse ${target}`,
    );
    await assert.rejects(
      () => editTool.execute({ path: target, old_text: 'original', new_text: 'persisted' }, localContext),
      /protected path refused/,
      `edit must refuse ${target}`,
    );
    assert.equal(readFileSync(join(root, target), 'utf8'), 'original');
  }
});

test('a symlink alias inside the workspace does not launder a protected path', async () => {
  const root = makeProtectedWorkspace('pi-protected-alias-');
  symlinkSync(join(root, '.git'), join(root, 'git-alias'), 'dir');
  symlinkSync(join(root, 'AGENTS.md'), join(root, 'guidance.md'));
  const localContext = makeContext(root);

  await assert.rejects(
    () => writeTool.execute({ path: 'git-alias/hooks/pre-commit', content: 'persisted' }, localContext),
    /protected path refused.*\.git\/ is protected/s,
  );
  await assert.rejects(
    () => writeTool.execute({ path: 'git-alias/hooks/post-merge', content: 'persisted' }, localContext),
    /protected path refused/,
  );
  await assert.rejects(
    () => editTool.execute({ path: 'guidance.md', old_text: 'original', new_text: 'persisted' }, localContext),
    /protected path refused.*AGENTS\.md is protected at the workspace root/s,
  );
  assert.equal(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), 'original');
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'original');
});

test('a nested .git directory deeper in the tree is protected too', async () => {
  const root = makeProtectedWorkspace('pi-protected-nested-');
  const nested = join(root, 'packages', 'inner', '.git', 'hooks');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'pre-push'), 'original', 'utf8');
  const localContext = makeContext(root);

  await assert.rejects(
    () => writeTool.execute({ path: 'packages/inner/.git/hooks/pre-push', content: 'persisted' }, localContext),
    /protected path refused/,
  );
  await assert.rejects(
    () => writeTool.execute({ path: 'packages/inner/.claude/settings.json', content: 'persisted' }, localContext),
    /protected path refused/,
  );
  assert.equal(readFileSync(join(nested, 'pre-push'), 'utf8'), 'original');
});

test('ordinary files beside the protected ones stay writable', async () => {
  const root = makeProtectedWorkspace('pi-protected-neighbors-');
  const localContext = makeContext(root);

  for (const target of ['.gitignore', 'AGENTS.notes.md', 'docs/AGENTS.md', 'src/profile.ts']) {
    const result = await writeTool.execute({ path: target, content: 'allowed' }, localContext);
    assert.equal(result.isError, undefined, `write must accept ${target}`);
    assert.equal(readFileSync(join(root, target), 'utf8'), 'allowed');
  }
});

test('--allow-protected-paths style policy opt-out permits the write', async () => {
  const root = makeProtectedWorkspace('pi-protected-optout-');
  const localContext = makeContext(root, {
    ...defaultToolExecutionPolicy(root),
    allowProtectedPaths: true,
  });

  const written = await writeTool.execute({ path: '.git/hooks/pre-commit', content: 'opted in' }, localContext);
  assert.equal(written.isError, undefined);
  assert.equal(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), 'opted in');
  const edited = await editTool.execute(
    { path: 'AGENTS.md', old_text: 'original', new_text: 'opted in' },
    localContext,
  );
  assert.equal(edited.isError, undefined);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'opted in');
});

test('a case-sensitive filesystem keeps .Git writable while .git stays refused', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-protected-case-sensitive-')));
  if (workspaceFoldsPathCase(root)) {
    t.skip('this filesystem folds path case, so .Git and .git are the same directory here');
    return;
  }
  const localContext = makeContext(root);

  // .Git/ is a directory git never reads on this filesystem, so refusing it
  // would be a false refusal (R2 finding 12).
  const written = await writeTool.execute({ path: '.Git/notes.txt', content: 'ordinary notes' }, localContext);
  assert.equal(written.isError, undefined);
  assert.equal(readFileSync(join(root, '.Git', 'notes.txt'), 'utf8'), 'ordinary notes');
  const writtenGuidance = await writeTool.execute({ path: 'agents.md', content: 'ordinary notes' }, localContext);
  assert.equal(writtenGuidance.isError, undefined);

  await assert.rejects(
    () => writeTool.execute({ path: '.git/x', content: 'persisted' }, localContext),
    /protected path refused.*\.git\/ is protected/s,
  );
  await assert.rejects(
    () => writeTool.execute({ path: 'AGENTS.md', content: 'persisted' }, localContext),
    /protected path refused.*AGENTS\.md is protected at the workspace root/s,
  );
  assert.equal(existsSync(join(root, '.git')), false);
});

test('a case-insensitive filesystem refuses every spelling of a protected path', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-protected-case-folding-')));
  if (!workspaceFoldsPathCase(root)) {
    t.skip('this filesystem is case-sensitive, so .Git is a different directory here');
    return;
  }
  const localContext = makeContext(root);

  for (const target of ['.Git/notes.txt', '.git/x', 'Agents.md', 'AGENTS.md']) {
    await assert.rejects(
      () => writeTool.execute({ path: target, content: 'persisted' }, localContext),
      /protected path refused/,
      `write must refuse ${target} on a case-insensitive filesystem`,
    );
  }
  assert.equal(existsSync(join(root, '.Git')), false);
});

test('reads of protected paths stay allowed', async () => {
  const root = makeProtectedWorkspace('pi-protected-read-');
  const localContext = makeContext(root);

  const result = await readTool.execute({ path: '.git/config' }, localContext);
  assert.equal(result.isError, undefined);
  assert.equal((result.content[0] as { text: string }).text, 'original');
});

test('write honors an expected_sha256 precondition', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-write-precondition-')));
  const localContext = makeContext(root);
  const path = join(root, 'resumable.txt');
  writeFileSync(path, 'planned state', 'utf8');
  const currentDigest = createHash('sha256').update('planned state').digest('hex');

  const matched = await writeTool.execute(
    { path: 'resumable.txt', content: 'next state', expected_sha256: currentDigest },
    localContext,
  );
  assert.equal(matched.isError, undefined);
  assert.equal(readFileSync(path, 'utf8'), 'next state');

  const mismatched = await writeTool.execute(
    { path: 'resumable.txt', content: 'clobbered', expected_sha256: currentDigest },
    localContext,
  );
  assert.equal(mismatched.isError, true);
  const mismatchText = (mismatched.content[0] as { text: string }).text;
  assert.match(mismatchText, /expected_sha256 mismatch for resumable\.txt/);
  assert.ok(mismatchText.includes(currentDigest), 'the refusal names the expected digest');
  assert.ok(
    mismatchText.includes(createHash('sha256').update('next state').digest('hex')),
    'the refusal names the digest actually found',
  );
  assert.equal(readFileSync(path, 'utf8'), 'next state');

  const missing = await writeTool.execute(
    { path: 'gone.txt', content: 'recreated', expected_sha256: currentDigest },
    localContext,
  );
  assert.equal(missing.isError, true);
  assert.match((missing.content[0] as { text: string }).text, /does not exist/);
  assert.equal(existsSync(join(root, 'gone.txt')), false);
});

test('the expected_sha256 precondition refuses a file over its hashing ceiling', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-write-precondition-bound-')));
  const localContext = makeContext(root);
  const path = join(root, 'oversized.bin');
  writeFileSync(path, 'head', 'utf8');
  // Sparse: the point is the declared size the precondition must refuse to read.
  truncateSync(path, WRITE_MAX_PRECONDITION_BYTES + 1);

  const refused = await writeTool.execute(
    {
      path: 'oversized.bin',
      content: 'replacement',
      expected_sha256: createHash('sha256').update('head').digest('hex'),
    },
    localContext,
  );
  assert.equal(refused.isError, true);
  const refusalText = (refused.content[0] as { text: string }).text;
  assert.match(refusalText, /expected_sha256 cannot be checked for oversized\.bin/);
  assert.ok(refusalText.includes(String(WRITE_MAX_PRECONDITION_BYTES)), 'the refusal names the limit');
  assert.equal(statSync(path).size, WRITE_MAX_PRECONDITION_BYTES + 1, 'the refusal must not have written the file');
});

test('truncateMiddle keeps head and tail with a marker', () => {
  const text = 'a'.repeat(20_000) + 'MIDDLE' + 'b'.repeat(20_000);
  const truncated = truncateMiddle(text, 10_000);
  assert.ok(truncated.length < 11_000);
  assert.match(truncated, /chars truncated/);
  assert.ok(truncated.startsWith('aaa'));
  assert.ok(truncated.endsWith('bbb'));
  assert.ok(!truncated.includes('MIDDLE'));
});
