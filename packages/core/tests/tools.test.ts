import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashTool, editTool, readTool, writeTool, type ToolContext } from '../src/tools/index.js';
import { truncateMiddle } from '../src/truncate.js';

function makeContext(cwd: string): ToolContext & { current: () => string } {
  let dir = cwd;
  return {
    get cwd() {
      return dir;
    },
    setCwd(next: string) {
      dir = next;
    },
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
  const file = join(workDir, 'edit.txt');
  writeFileSync(file, 'aaa bbb aaa', 'utf8');
  const ambiguous = await editTool.execute({ path: file, old_text: 'aaa', new_text: 'xxx' }, context);
  assert.equal(ambiguous.isError, true);
  const all = await editTool.execute({ path: file, old_text: 'aaa', new_text: 'xxx', replace_all: true }, context);
  assert.equal(all.isError, undefined);
  assert.equal(readFileSync(file, 'utf8'), 'xxx bbb xxx');
  const missing = await editTool.execute({ path: file, old_text: 'zzz', new_text: 'y' }, context);
  assert.equal(missing.isError, true);
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
  const file = join(workDir, 'precious.txt');
  writeFileSync(file, 'do not lose me', 'utf8');
  // the throw becomes an isError tool result in the agent loop
  await assert.rejects(() => writeTool.execute({ path: file, content: null }, context), /must be a string/);
  assert.equal(readFileSync(file, 'utf8'), 'do not lose me');
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
