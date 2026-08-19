import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultToolExecutionPolicy, mapTool, type ToolContext } from '../src/tools/index.js';
import {
  MAP_MAX_DIRECTORY_ENTRIES,
  MAP_MAX_SCANNED_BYTES,
  MAP_MAX_VISITED_DIRECTORIES,
} from '../src/tools/map.js';

function contextFor(cwd: string): ToolContext {
  return { cwd, setCwd: () => undefined, policy: defaultToolExecutionPolicy(cwd) };
}

const root = mkdtempSync(join(tmpdir(), 'pi-map-'));
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(
  join(root, 'src', 'main.ts'),
  'export class Engine {}\nexport function start(x: number) {}\nfunction helper() {}\nexport interface Config {}\n',
);
writeFileSync(join(root, 'lib', 'util.py'), 'class Parser:\n  pass\n\ndef parse_all(items):\n  return items\n');
writeFileSync(join(root, 'node_modules', 'junk', 'dep.ts'), 'export function shouldNotAppear() {}\n');
writeFileSync(join(root, 'README.md'), '# not source\n');

test('map extracts top-level symbols across languages and skips vendor dirs', async () => {
  const result = await mapTool.execute({}, contextFor(root));
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /src\/main\.ts \(\d+L\): .*Engine/);
  assert.match(text, /start/);
  assert.match(text, /helper/);
  assert.match(text, /Config/);
  assert.match(text, /lib\/util\.py \(\d+L\): .*Parser/);
  assert.match(text, /parse_all/);
  assert.ok(!text.includes('shouldNotAppear'), 'node_modules must be skipped');
  assert.ok(!text.includes('README.md'), 'non-source files must be skipped');
});

test('map scopes to a subtree via path', async () => {
  const result = await mapTool.execute({ path: 'lib' }, contextFor(root));
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /util\.py/);
  assert.ok(!text.includes('main.ts'));
});

test('map reports an empty subtree gracefully', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'pi-map-empty-'));
  const result = await mapTool.execute({}, contextFor(empty));
  assert.match((result.content[0] as { text: string }).text, /no recognized source files/);
});

test('map neither scopes through nor walks a symlink escape', async () => {
  const mapRoot = mkdtempSync(join(tmpdir(), 'pi-map-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'pi-map-symlink-outside-'));
  writeFileSync(join(outside, 'secret.ts'), 'export const mustNotAppear = true;\n');
  writeFileSync(join(mapRoot, 'safe.ts'), 'export const safe = true;\n');
  symlinkSync(outside, join(mapRoot, 'escape'), 'dir');
  const context = contextFor(mapRoot);

  const result = await mapTool.execute({}, context);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /safe\.ts/);
  assert.ok(!text.includes('mustNotAppear'));
  await assert.rejects(() => mapTool.execute({ path: 'escape' }, context), /path escapes workspace/);
});

test('map bounds scheduled and visited directories without recursive stack growth', async () => {
  const manyDirectories = mkdtempSync(join(tmpdir(), 'pi-map-directory-cap-'));
  for (let index = 0; index < MAP_MAX_VISITED_DIRECTORIES + 8; index++) {
    mkdirSync(join(manyDirectories, `directory-${String(index).padStart(4, '0')}`));
  }

  const result = await mapTool.execute({ depth: 1_000_000 }, contextFor(manyDirectories));
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, new RegExp(`capped at ${MAP_MAX_VISITED_DIRECTORIES} visited directories`));
});

test('map bounds total directory entries even when ignored files dominate the tree', async () => {
  const manyEntries = mkdtempSync(join(tmpdir(), 'pi-map-entry-cap-'));
  for (let index = 0; index < MAP_MAX_DIRECTORY_ENTRIES + 8; index++) {
    writeFileSync(join(manyEntries, `ignored-${String(index).padStart(5, '0')}.txt`), '');
  }

  const result = await mapTool.execute({}, contextFor(manyEntries));
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, new RegExp(`capped at ${MAP_MAX_DIRECTORY_ENTRIES} directory entries`));
});

test('map bounds aggregate source bytes and observes preexisting cancellation', async () => {
  const largeTree = mkdtempSync(join(tmpdir(), 'pi-map-byte-cap-'));
  for (let index = 0; index < Math.ceil(MAP_MAX_SCANNED_BYTES / 1_000_000) + 1; index++) {
    writeFileSync(join(largeTree, `source-${String(index).padStart(2, '0')}.ts`), 'x'.repeat(1_000_000));
  }
  const result = await mapTool.execute({}, contextFor(largeTree));
  assert.match((result.content[0] as { text: string }).text, new RegExp(`capped at ${MAP_MAX_SCANNED_BYTES}`));

  const controller = new AbortController();
  controller.abort();
  const canceled = await mapTool.execute({}, {
    ...contextFor(largeTree),
    signal: controller.signal,
  });
  assert.match((canceled.content[0] as { text: string }).text, /map canceled/);
});
