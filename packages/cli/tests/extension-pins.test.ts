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
