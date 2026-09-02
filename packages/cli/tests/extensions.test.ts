import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfiguredExtensions, loadExtensions, parseExtensionRequest } from '../src/extensions.js';

function extensionFile(directory: string, name: string, source: string): string {
  const path = join(directory, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

  const loaded = await loadExtensions(['array.mjs', 'factory.mjs'], directory);
  assert.deepEqual(
    loaded.tools.map((tool) => tool.name),
    ['array_tool', 'factory_tool'],
  );
  assert.deepEqual(
    loaded.extensions.map((extension) => [extension.path, extension.toolNames, extension.pinned]),
    [
      ['array.mjs', ['array_tool'], false],
      ['factory.mjs', ['factory_tool'], false],
    ],
  );
  for (const extension of loaded.extensions) {
    assert.equal(extension.sha256, digestOf(join(directory, extension.path)));
  }
});

test('config extension paths are config-relative while explicit CLI paths remain cwd-relative', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-extension-origins-'));
  const configDirectory = join(root, 'config');
  const projectDirectory = join(root, 'project');
  mkdirSync(configDirectory);
  mkdirSync(projectDirectory);
  extensionFile(configDirectory, 'relative.mjs', `export default [${validToolSource('from_config')}];`);
  extensionFile(projectDirectory, 'relative.mjs', `export default [${validToolSource('from_cli')}];`);

  const loaded = await loadConfiguredExtensions({
    configPaths: ['relative.mjs'],
    configFile: join(configDirectory, 'config.json'),
    cliPaths: ['relative.mjs'],
    cwd: projectDirectory,
  });

  assert.deepEqual(
    loaded.tools.map((tool) => tool.name),
    ['from_config', 'from_cli'],
  );
  assert.deepEqual(
    loaded.extensions.map((extension) => extension.sha256),
    [digestOf(join(configDirectory, 'relative.mjs')), digestOf(join(projectDirectory, 'relative.mjs'))],
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

test('a pin suffix is read only when it is a full sha256 digest', () => {
  assert.deepEqual(parseExtensionRequest('tools.mjs'), { path: 'tools.mjs' });
  assert.deepEqual(parseExtensionRequest('node_modules/@scope/pack/tools.mjs'), {
    path: 'node_modules/@scope/pack/tools.mjs',
  });
  const digest = 'a'.repeat(64);
  assert.deepEqual(parseExtensionRequest(`tools.mjs@sha256:${digest.toUpperCase()}`), {
    path: 'tools.mjs',
    expectedDigest: digest,
  });
  // too short to be a digest: the whole string stays a path
  assert.deepEqual(parseExtensionRequest('tools.mjs@sha256:abc'), { path: 'tools.mjs@sha256:abc' });
});

test('a matching sha256 pin loads the extension and records it as pinned', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-pin-'));
  const path = extensionFile(directory, 'pinned.mjs', `export default [${validToolSource('pinned_tool')}];`);
  const digest = digestOf(path);

  const loaded = await loadExtensions([`pinned.mjs@sha256:${digest}`], directory);
  assert.deepEqual(
    loaded.tools.map((tool) => tool.name),
    ['pinned_tool'],
  );
  assert.deepEqual(loaded.extensions, [
    { path: 'pinned.mjs', sha256: digest, toolNames: ['pinned_tool'], pinned: true },
  ]);
});

test('a mismatched sha256 pin refuses the extension and names both digests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-extensions-pin-mismatch-'));
  const path = extensionFile(directory, 'swapped.mjs', `export default [${validToolSource('swapped_tool')}];`);
  const digest = digestOf(path);
  const stalePin = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`;

  await assert.rejects(
    () => loadExtensions([`swapped.mjs@sha256:${stalePin}`], directory),
    (error: Error) => {
      assert.match(error.message, /extension swapped\.mjs: sha256 pin mismatch/);
      assert.ok(error.message.includes(stalePin), 'the expected digest is named');
      assert.ok(error.message.includes(digest), 'the digest on disk is named');
      return true;
    },
  );
});
