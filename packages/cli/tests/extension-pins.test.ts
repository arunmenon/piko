import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Session } from '@pi/core';
import { runCli, startFakeProvider } from './fake-provider.js';

const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');

const extensionSource = `export default [{
  name: 'pinned_probe',
  description: 'Extension tool used to test load-time pinning',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() { return { content: [{ type: 'text', text: 'ok' }] }; }
}];
`;

function writeExtension(workspace: string): string {
  const path = join(workspace, 'probe.mjs');
  writeFileSync(path, extensionSource, 'utf8');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('a pinned extension loads and is journaled with its digest', async () => {
  const provider = await startFakeProvider();
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-ext-pin-'));
  const session = Session.create(workspace, 'fake-model', workspace);
  session.close(); // the spawned pi must be able to take the lock (0023)
  const digest = writeExtension(workspace);
  const environment = {
    ...process.env,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: provider.url,
  };
  delete environment['PI_DEPTH'];
  try {
    const result = await runCli(
      [
        cli,
        '-p',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        session.file,
        '--ext',
        `probe.mjs@sha256:${digest}`,
        'hello',
      ],
      { cwd: workspace, env: environment },
    );
    assert.equal(result.status, 0, JSON.stringify(result));

    const reopened = Session.open(session.file);
    const loaded = reopened.lifecycleEntries.filter((entry) => entry.t === 'extension_loaded');
    assert.deepEqual(loaded.map((entry) => ({ ...entry, v: undefined, at: undefined })), [
      {
        t: 'extension_loaded',
        v: undefined,
        at: undefined,
        path: 'probe.mjs',
        sha256: digest,
        toolNames: ['pinned_probe'],
        pinned: true,
        // The digest covers this entry module's bytes only (ADR 0012 addendum).
        entryOnly: true,
      },
    ]);
  } finally {
    await provider.close();
  }
});

test('an unpinned extension is journaled too, marked unpinned', async () => {
  const provider = await startFakeProvider();
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-ext-unpinned-'));
  const session = Session.create(workspace, 'fake-model', workspace);
  session.close();
  const digest = writeExtension(workspace);
  const environment = {
    ...process.env,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: provider.url,
  };
  delete environment['PI_DEPTH'];
  try {
    const result = await runCli(
      [cli, '-p', '--profile', 'openai', '--model', 'fake-model', '--session', session.file, '--ext', 'probe.mjs', 'hello'],
      { cwd: workspace, env: environment },
    );
    assert.equal(result.status, 0, JSON.stringify(result));

    const entry = Session.open(session.file).lifecycleEntries.find((item) => item.t === 'extension_loaded');
    assert.ok(entry && entry.t === 'extension_loaded');
    assert.equal(entry.sha256, digest);
    assert.equal(entry.pinned, false);
  } finally {
    await provider.close();
  }
});

test('a mismatched pin refuses to start with exit 1 and no session row', async () => {
  const provider = await startFakeProvider();
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-ext-mismatch-'));
  const session = Session.create(workspace, 'fake-model', workspace);
  session.close();
  const digest = writeExtension(workspace);
  const stalePin = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`;
  const environment = {
    ...process.env,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: provider.url,
  };
  delete environment['PI_DEPTH'];
  try {
    const result = await runCli(
      [
        cli,
        '-p',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        session.file,
        '--ext',
        `probe.mjs@sha256:${stalePin}`,
        'hello',
      ],
      { cwd: workspace, env: environment },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /probe\.mjs: sha256 pin mismatch/);
    assert.ok(result.stderr.includes(stalePin), 'the expected digest is named');
    assert.ok(result.stderr.includes(digest), 'the digest on disk is named');
    assert.equal(provider.requests.length, 0, 'the refusal precedes every model call');
    assert.equal(
      Session.open(session.file).lifecycleEntries.filter((entry) => entry.t === 'extension_loaded').length,
      0,
    );
  } finally {
    await provider.close();
  }
});

/**
 * R2-2: a pin hashes a pathname and then imports the same pathname, so a swap
 * between the two operations used to journal the benign digest while loading
 * whatever landed in between. Node offers no way to import a byte buffer, so
 * the loader re-reads and re-hashes immediately after the import instead: the
 * swap is detected and the run refuses to start. It is not prevented, and this
 * module proves it by rewriting itself from its own top level.
 */
const selfRewritingSource = `import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default [{
  name: 'swapped_probe',
  description: 'Extension whose entry module replaces itself while it loads',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() { return { content: [{ type: 'text', text: 'ok' }] }; }
}];

// Top level: this runs during the dynamic import, between the two hashed reads.
writeFileSync(fileURLToPath(import.meta.url), '// swapped after the hashed read\\n', 'utf8');
`;

test('an entry module that changes between the two reads refuses to start', async () => {
  const provider = await startFakeProvider();
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-ext-swap-'));
  const session = Session.create(workspace, 'fake-model', workspace);
  session.close();
  const modulePath = join(workspace, 'swapper.mjs');
  writeFileSync(modulePath, selfRewritingSource, 'utf8');
  const digestBeforeLoad = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
  const environment = {
    ...process.env,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: provider.url,
  };
  delete environment['PI_DEPTH'];
  try {
    const result = await runCli(
      [
        cli,
        '-p',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--session',
        session.file,
        '--ext',
        `swapper.mjs@sha256:${digestBeforeLoad}`,
        'hello',
      ],
      { cwd: workspace, env: environment },
    );

    assert.equal(result.status, 1, JSON.stringify(result));
    assert.match(result.stderr, /swapper\.mjs: the entry module changed on disk during load/);
    assert.ok(result.stderr.includes(digestBeforeLoad), 'the digest hashed before the import is named');
    const digestAfterLoad = createHash('sha256').update(readFileSync(modulePath)).digest('hex');
    assert.notEqual(digestAfterLoad, digestBeforeLoad, 'the module really did rewrite itself');
    assert.ok(result.stderr.includes(digestAfterLoad), 'the digest observed after the import is named');
    assert.match(result.stderr, /cannot prevent one/, 'the message states the limit of the check');
    assert.equal(provider.requests.length, 0, 'the refusal precedes every model call');
    assert.equal(
      Session.open(session.file).lifecycleEntries.filter((entry) => entry.t === 'extension_loaded').length,
      0,
      'a swapped module is never journaled as loaded',
    );
  } finally {
    await provider.close();
  }
});
