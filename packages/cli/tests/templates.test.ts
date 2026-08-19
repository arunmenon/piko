import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  TEMPLATE_MAX_DIRECTORY_ENTRIES,
  TEMPLATE_MAX_FILE_BYTES,
  TEMPLATE_MAX_TOTAL_BYTES,
  loadTemplates,
} from '../src/templates.js';

function directory(root: string, ...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

test('global templates load by default while project templates require trust and retain override precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-templates-trust-'));
  const cwd = directory(root, 'project');
  const globalDirectory = directory(root, 'global');
  const projectDirectory = directory(cwd, '.agent', 'commands');
  writeFileSync(join(globalDirectory, 'shared.md'), 'global');
  writeFileSync(join(globalDirectory, 'global.md'), 'global only');
  writeFileSync(join(projectDirectory, 'shared.md'), 'project');
  writeFileSync(join(projectDirectory, 'project.md'), 'project only');

  const untrusted = loadTemplates(cwd, { globalDirectory });
  assert.equal(untrusted.get('shared')?.body, 'global');
  assert.equal(untrusted.get('global')?.body, 'global only');
  assert.equal(untrusted.has('project'), false);

  const trusted = loadTemplates(cwd, { globalDirectory, trustProject: true });
  assert.equal(trusted.get('shared')?.body, 'project');
  assert.equal(trusted.get('global')?.body, 'global only');
  assert.equal(trusted.get('project')?.body, 'project only');
});

test('template loading ignores symlinked files and directories', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-templates-symlink-'));
  const globalDirectory = directory(root, 'global');
  const externalDirectory = directory(root, 'external');
  const secret = join(externalDirectory, 'secret.md');
  writeFileSync(secret, 'must not load');
  try {
    symlinkSync(secret, join(globalDirectory, 'linked.md'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }
  assert.equal(loadTemplates(root, { globalDirectory }).has('linked'), false);

  const cwd = directory(root, 'project');
  directory(cwd, '.agent');
  symlinkSync(externalDirectory, join(cwd, '.agent', 'commands'), 'dir');
  assert.equal(loadTemplates(cwd, { globalDirectory: join(root, 'missing'), trustProject: true }).size, 0);
});

test('template loading enforces per-file and aggregate byte caps', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-templates-bytes-'));
  const globalDirectory = directory(root, 'global');
  writeFileSync(join(globalDirectory, 'oversized.md'), Buffer.alloc(TEMPLATE_MAX_FILE_BYTES + 1, 120));
  for (let index = 0; index < 10; index++) {
    writeFileSync(join(globalDirectory, `bounded-${index}.md`), Buffer.alloc(TEMPLATE_MAX_FILE_BYTES, 97));
  }

  const templates = loadTemplates(root, { globalDirectory });
  assert.equal(templates.has('oversized'), false);
  const retainedBytes = [...templates.values()].reduce((total, template) => total + Buffer.byteLength(template.body), 0);
  assert.ok(retainedBytes <= TEMPLATE_MAX_TOTAL_BYTES);
});

test('template directory traversal is entry bounded', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-templates-entries-'));
  const globalDirectory = directory(root, 'global');
  for (let index = 0; index < TEMPLATE_MAX_DIRECTORY_ENTRIES + 16; index++) {
    writeFileSync(join(globalDirectory, `template-${index}.md`), 'x');
  }

  const templates = loadTemplates(root, { globalDirectory });
  assert.equal(templates.size, TEMPLATE_MAX_DIRECTORY_ENTRIES);
});
