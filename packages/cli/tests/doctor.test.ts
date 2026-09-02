import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Session, sessionsDirFor } from '@pi/core';

const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: 'test-key-hermetic' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function deadLockRecord(): string {
  return `${JSON.stringify({
    v: 2,
    pid: 2147483000,
    host: hostname(),
    token: 'dead-owner-token',
    created: new Date().toISOString(),
  })}\n`;
}

function rows(stdout: string): { v: number; event: Record<string, unknown> }[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { v: number; event: Record<string, unknown> });
}

test('0024 CLI acceptance: crash, exit 5 with typed JSON, doctor list, recovery, resume', () => {
  // realpath: the spawned pi resolves its cwd, and the sessions dir is keyed by it
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-doctor-cli-')));
  // Create where pi -c discovers sessions for this workspace.
  const session = Session.create(workspace, 'test-model', sessionsDirFor(workspace));
  session.append({ t: 'msg', message: { role: 'user', content: [{ type: 'text', text: 'newest history' }] } });
  session.close();
  // Simulate a SIGKILL crash: replace the (released) lock with a dead owner's.
  writeFileSync(`${session.file}.lock`, deadLockRecord(), { encoding: 'utf8', mode: 0o600 });

  // pi -c: exit 5, versioned JSON row with the typed code, nothing created.
  const blocked = run(['-p', '-c', '--json', '--model', 'test-model', 'continue'], workspace);
  assert.equal(blocked.status, 5, blocked.stdout + blocked.stderr);
  const errorRow = rows(blocked.stdout)[0]!;
  assert.equal(errorRow.v, 1);
  assert.equal(errorRow.event['type'], 'run_error');
  assert.equal(errorRow.event['code'], 'locked_session_head');

  // Doctor JSON listing: versioned rows, removable classification, no token.
  const listing = run(['doctor', 'sessions', '--json'], workspace);
  assert.equal(listing.status, 0, listing.stdout + listing.stderr);
  const lockedRow = rows(listing.stdout).find(
    (row) => row.event['type'] === 'doctor_session' && row.event['file'] === session.file,
  );
  assert.ok(lockedRow, 'the locked session appears in the doctor inventory');
  assert.equal(lockedRow!.event['classification'], 'removable');
  assert.ok(!JSON.stringify(lockedRow).includes('dead-owner-token'), 'the lock token never enters public JSON');

  // Invalid doctor arguments keep the typed JSON contract on stdout.
  const invalid = run(['doctor', 'sessions', '--json', '--remove'], workspace);
  assert.equal(invalid.status, 1);
  assert.equal(rows(invalid.stdout)[0]?.event['type'], 'doctor_error');

  // Removal requires confirmation, refuses escapes, then really recovers.
  const unconfirmed = run(['doctor', 'sessions', '--json', '--remove', basename(session.file)], workspace);
  assert.equal(unconfirmed.status, 1);
  assert.equal(rows(unconfirmed.stdout)[0]?.event['type'], 'doctor_error');

  const escape = run(['doctor', 'sessions', '--json', '--remove', '/tmp/not-a-session', '--yes'], workspace);
  assert.equal(escape.status, 1);
  assert.match(String(rows(escape.stdout)[0]?.event['error'] ?? rows(escape.stdout)[0]?.event['reason']), /outside|refusing/);

  const removed = run(['doctor', 'sessions', '--json', '--remove', basename(session.file), '--yes'], workspace);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  const recoverRow = rows(removed.stdout)[0]!;
  assert.equal(recoverRow.event['type'], 'doctor_recover');
  assert.equal(recoverRow.event['removed'], true);
  assert.equal(existsSync(`${session.file}.lock`), false);

  // pi -c now selects the recovered newest session again (no provider needed:
  // selection happens before any model call, so a bad key proves selection
  // succeeded when the failure is an auth error rather than a lock error).
  const resumed = run(['-p', '-c', '--json', '--offline-pricing', '--model', 'test-model', 'continue'], workspace);
  assert.notEqual(resumed.status, 5, 'selection must not report a locked head after recovery');
});

test('0015: doctor sessions reports repaired journals in text and JSON', () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-doctor-repair-')));
  const dir = sessionsDirFor(workspace);

  const intact = Session.create(workspace, 'test-model', dir);
  intact.append({ t: 'msg', message: { role: 'user', content: [{ type: 'text', text: 'clean' }] } });
  intact.close();

  // A torn write, then the reopen that repairs the append boundary and records it.
  const repaired = Session.create(workspace, 'test-model', dir);
  repaired.append({ t: 'msg', message: { role: 'user', content: [{ type: 'text', text: 'kept' }] } });
  appendFileSync(repaired.file, '{"t":"msg","message":{"role":"assist', 'utf8');
  repaired.close();
  const reopened = Session.openLocked(repaired.file)!;
  reopened.setRunStatus('running');
  reopened.close();

  const listing = run(['doctor', 'sessions', '--json'], workspace);
  assert.equal(listing.status, 0, listing.stdout + listing.stderr);
  const sessionRows = rows(listing.stdout).filter((row) => row.event['type'] === 'doctor_session');
  const repairedRow = sessionRows.find((row) => row.event['file'] === repaired.file);
  const intactRow = sessionRows.find((row) => row.event['file'] === intact.file);
  assert.equal(repairedRow?.event['repairs'], 1);
  assert.equal(intactRow?.event['repairs'], undefined, 'an intact journal reports no repair count');

  const text = run(['doctor', 'sessions'], workspace);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const repairedLine = text.stdout.split('\n').find((line) => line.includes(repaired.file));
  assert.match(String(repairedLine), /REPAIRED \(1 journal_repaired row\)/);
  const intactLine = text.stdout.split('\n').find((line) => line.includes(intact.file));
  assert.doesNotMatch(String(intactLine), /REPAIRED/);
  assert.match(text.stdout, /recovered from a partial trailing write/);
});
