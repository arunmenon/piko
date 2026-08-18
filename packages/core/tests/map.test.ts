import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mapTool, type ToolContext } from '../src/tools/index.js';

function contextFor(cwd: string): ToolContext {
  return { cwd, setCwd: () => undefined };
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
