import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('fixed evaluator runs a selected build, hashes it, and rejects a false success claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piko-eval-build-'));
  try {
    for (const pkg of ['ai', 'core', 'cli']) mkdirSync(join(dir, 'packages', pkg, 'dist'), { recursive: true });
    const cli = join(dir, 'packages/cli/dist/main.js');
    const summary = { v: 1, type: 'usage_summary', status: 'completed', requests: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const code = `const fs = require('node:fs');\nfs.writeFileSync('greeting.txt', 'WRONG');\nconsole.error(${JSON.stringify(JSON.stringify(summary))});\n`;
    writeFileSync(cli, code);
    const out = join(dir, 'out');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'eval/run.ts', '--only', 'create-file', '--harness-root', dir, '--output-dir', out], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const trial = JSON.parse(readFileSync(join(out, 'trials/create-file/result.json'), 'utf8'));
    assert.equal(trial.outcome.reason, 'verification_failed');
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.configuration.harnessRoot, dir);
    assert.ok(manifest.harness.distSha256);
    const again = spawnSync(process.execPath, ['--import', 'tsx', 'eval/run.ts', '--only', 'create-file', '--harness-root', dir, '--output-dir', out], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.equal(readFileSync(cli, 'utf8'), code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
