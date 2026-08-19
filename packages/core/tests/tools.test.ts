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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bashTool,
  defaultToolExecutionPolicy,
  editTool,
  readTool,
  writeTool,
  type ToolContext,
  type ToolExecutionPolicy,
} from '../src/tools/index.js';
import { truncateMiddle } from '../src/truncate.js';
import { EDIT_MAX_FILE_BYTES } from '../src/tools/edit.js';

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

test('truncateMiddle keeps head and tail with a marker', () => {
  const text = 'a'.repeat(20_000) + 'MIDDLE' + 'b'.repeat(20_000);
  const truncated = truncateMiddle(text, 10_000);
  assert.ok(truncated.length < 11_000);
  assert.match(truncated, /chars truncated/);
  assert.ok(truncated.startsWith('aaa'));
  assert.ok(truncated.endsWith('bbb'));
  assert.ok(!truncated.includes('MIDDLE'));
});
