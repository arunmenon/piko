import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfiguredExtensions, loadExtensions } from '../src/extensions.js';

function extensionFile(directory: string, name: string, source: string): string {
  const path = join(directory, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

const validToolSource = (name: string): string => `({
  name: ${JSON.stringify(name)},
  description: "Test extension tool",
  parameters: { type: "object", properties: {} },
  async execute() { return { content: [{ type: "text", text: "ok" }] }; }
})`;

test('loadExtensions supports JavaScript arrays, wrappers, and async factories', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-'));
  extensionFile(directory, 'array.mjs', `export default [${validToolSource('array_tool')}];`);
  extensionFile(
    directory,
    'factory.mjs',
    `export default async () => ({ tools: [${validToolSource('factory_tool')}] });`,
  );

  const tools = await loadExtensions(['array.mjs', 'factory.mjs'], directory);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['array_tool', 'factory_tool'],
  );
});

test('config extension paths are config-relative while explicit CLI paths remain cwd-relative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-extension-origins-'));
  const configDirectory = join(root, 'config');
  const projectDirectory = join(root, 'project');
  mkdirSync(configDirectory);
  mkdirSync(projectDirectory);
  extensionFile(configDirectory, 'relative.mjs', `export default [${validToolSource('from_config')}];`);
  extensionFile(projectDirectory, 'relative.mjs', `export default [${validToolSource('from_cli')}];`);

  const tools = await loadConfiguredExtensions({
    configPaths: ['relative.mjs'],
    configFile: join(configDirectory, 'config.json'),
    cliPaths: ['relative.mjs'],
    cwd: projectDirectory,
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['from_config', 'from_cli'],
  );
});

test('loadExtensions validates every exported tool', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-invalid-'));
  extensionFile(
    directory,
    'invalid.mjs',
    'export default [{ name: "invalid name", description: "x", parameters: { type: "object", properties: {} }, execute() {} }];',
  );
  await assert.rejects(() => loadExtensions(['invalid.mjs'], directory), /extension invalid\.mjs tool at index 0: name/);
});

test('loadExtensions rejects duplicate names across extension modules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-duplicate-'));
  extensionFile(directory, 'first.mjs', `export default [${validToolSource('duplicate')}];`);
  extensionFile(directory, 'second.mjs', `export default [${validToolSource('duplicate')}];`);
  await assert.rejects(
    () => loadExtensions(['first.mjs', 'second.mjs'], directory),
    /extensions: duplicate tool name "duplicate"/,
  );
});

test('loadExtensions applies the aggregate schema byte policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-budget-'));
  extensionFile(directory, 'large.mjs', `export default [${validToolSource('large')}];`);
  await assert.rejects(
    () => loadExtensions(['large.mjs'], directory, { maxSchemaBytes: 50 }),
    /serialized schemas total .*limit 50/,
  );
});

test('TypeScript extension sources fail clearly on the supported Node 20 runtime', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-typescript-'));
  await assert.rejects(
    () => loadExtensions(['extension.ts'], directory),
    /TypeScript source files are not portable.*compile the extension to \.js, \.mjs, or \.cjs first/,
  );
});
