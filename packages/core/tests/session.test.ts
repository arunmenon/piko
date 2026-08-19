import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { synthesizeInterruptedResults } from '../src/agent.js';
import {
  Session,
  SessionCorruptionError,
  SessionPersistenceError,
  latestSessionFile,
  tryLockSession,
  usageAcrossSessionLineageDetailed,
} from '../src/session.js';
import type { Message, Usage } from '@pi/ai';

const dir = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
const usage: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 };

function message(role: 'user' | 'assistant', text: string): Message {
  return role === 'user'
    ? { role, content: [{ type: 'text', text }] }
    : { role, content: [{ type: 'text', text }] };
}

test('session create/append/open roundtrip with usage totals', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: message('user', 'hi') });
  session.append({ t: 'msg', message: message('assistant', 'hello') });
  session.append({ t: 'usage', usage });
  session.append({ t: 'usage', usage });

  const reopened = Session.open(session.file);
  assert.equal(reopened.id, session.id);
  assert.equal(reopened.messages.length, 2);
  assert.equal(reopened.meta?.model, 'test-model');
  assert.deepEqual(reopened.usage, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2 });
});

test('an append failure poisons that Session object until the journal is reopened', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  const original = readFileSync(session.file, 'utf8');
  unlinkSync(session.file);
  assert.throws(() => session.setRunStatus('running'));

  // Even if the pathname reappears, the stale in-memory lifecycle cannot safely
  // decide whether the first write reached disk.
  writeFileSync(session.file, original, { encoding: 'utf8', mode: 0o600 });
  assert.throws(
    () => session.setRunStatus('completed'),
    (error: unknown) => error instanceof SessionPersistenceError,
  );
  assert.equal(readFileSync(session.file, 'utf8'), original);

  const reconciled = Session.open(session.file);
  reconciled.setRunStatus('completed');
  assert.equal(Session.open(session.file).runStatus?.status, 'completed');
});

test('lineage usage checkpoints bound deep accounting and legacy limits are nonfatal', () => {
  const lineageDir = mkdtempSync(join(tmpdir(), 'pi-session-usage-checkpoint-'));
  const parent = Session.create('/some/project', 'test-model', lineageDir);
  parent.append({ t: 'usage', usage });
  const child = Session.create('/some/project', 'test-model', lineageDir, {
    lineage: {
      parentSessionId: parent.id,
      parentFile: parent.file,
      relation: 'continuation',
      priorUsage: parent.usage,
      priorUsageComplete: true,
    },
  });
  child.append({ t: 'usage', usage });

  assert.deepEqual(usageAcrossSessionLineageDetailed(child, 1), {
    usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2 },
    complete: true,
    traversed: 1,
  });
  assert.deepEqual(child.lineage?.priorUsage, usage);

  const legacyChild = Session.create('/some/project', 'test-model', lineageDir, {
    lineage: { parentSessionId: parent.id, parentFile: parent.file, relation: 'continuation' },
  });
  legacyChild.append({ t: 'usage', usage });
  const boundedLegacy = usageAcrossSessionLineageDetailed(legacyChild, 1);
  assert.equal(boundedLegacy.complete, false);
  assert.deepEqual(boundedLegacy.usage, usage);

  const boundedCheckpoint = Session.create('/some/project', 'test-model', lineageDir, {
    lineage: {
      parentSessionId: legacyChild.id,
      parentFile: legacyChild.file,
      relation: 'continuation',
      priorUsage: boundedLegacy.usage,
      priorUsageComplete: boundedLegacy.complete,
    },
  });
  assert.equal(usageAcrossSessionLineageDetailed(boundedCheckpoint, 1).complete, false);
});

test('open skips a corrupt partial trailing line instead of refusing the session', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: message('user', 'hi') });
  appendFileSync(session.file, '{"t":"msg","message":{"role":"assist', 'utf8');
  const reopened = Session.open(session.file);
  assert.equal(reopened.messages.length, 1);
});

test('a resumed append repairs malformed and valid unterminated tails', () => {
  const malformed = Session.create('/some/project', 'test-model', dir);
  malformed.append({ t: 'msg', message: message('user', 'kept') });
  appendFileSync(malformed.file, '{"t":', 'utf8');
  const recovered = Session.open(malformed.file);
  recovered.setRunStatus('running');
  assert.equal(Session.open(malformed.file).messages.length, 1);
  assert.match(readFileSync(malformed.file, 'utf8'), /"run_status"/);

  const valid = Session.create('/some/project', 'test-model', dir);
  const unterminated = JSON.stringify({ t: 'msg', message: message('user', 'valid tail') });
  appendFileSync(valid.file, unterminated, 'utf8');
  const resumed = Session.open(valid.file);
  resumed.setRunStatus('completed', 'end_turn');
  const reopened = Session.open(valid.file);
  assert.equal(reopened.messages.length, 1);
  assert.equal(reopened.runStatus?.status, 'completed');
});

test('open rejects corrupt or schema-invalid rows anywhere except a partial JSON tail', () => {
  const corruptMiddle = Session.create('/some/project', 'test-model', dir);
  appendFileSync(
    corruptMiddle.file,
    '{"t":"msg","message":\n{"t":"usage","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}\n',
    'utf8',
  );
  assert.throws(
    () => Session.open(corruptMiddle.file),
    (error: unknown) => error instanceof SessionCorruptionError && error.lineNumber === 3,
  );

  const invalidTail = Session.create('/some/project', 'test-model', dir);
  appendFileSync(invalidTail.file, '{"t":"usage","usage":{"inputTokens":1}}\n', 'utf8');
  assert.throws(
    () => Session.open(invalidTail.file),
    (error: unknown) => error instanceof SessionCorruptionError && error.lineNumber === 3,
  );

  const completeCorruptTail = Session.create('/some/project', 'test-model', dir);
  appendFileSync(completeCorruptTail.file, '{not-json}\n', 'utf8');
  assert.throws(
    () => Session.open(completeCorruptTail.file),
    (error: unknown) => error instanceof SessionCorruptionError && error.lineNumber === 3,
  );
});

test('UUID creation is exclusive and session files are owner-only', () => {
  const id = randomUUID();
  const session = Session.create('/some/project', 'test-model', dir, { id });
  session.append({ t: 'msg', message: message('user', 'preserve me') });

  assert.match(session.id, /^[0-9a-f-]{36}$/i);
  assert.equal(statSync(session.file).mode & 0o777, 0o600);
  assert.throws(
    () => Session.create('/some/project', 'other-model', dir, { id }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST',
  );
  assert.equal(Session.open(session.file).messages.length, 1, 'exclusive create must not truncate an existing session');

  const ids = new Set(Array.from({ length: 64 }, () => Session.create('/some/project', 'test-model', dir).id));
  assert.equal(ids.size, 64);
});

test('synthesizeInterruptedResults repairs a transcript ending in unmatched tool calls', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }] },
  ];
  const repair = synthesizeInterruptedResults(messages);
  assert.ok(repair);
  assert.equal(repair.role, 'user');
  const block = repair.content[0] as { type: string; toolCallId: string; isError?: boolean };
  assert.equal(block.type, 'toolResult');
  assert.equal(block.toolCallId, 'tc1');
  assert.equal(block.isError, true);
  // a well-formed transcript needs no repair
  assert.equal(synthesizeInterruptedResults([messages[0]!]), undefined);
});

test('branch copies messages up to the given index into a sibling file', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: message('user', 'one') });
  session.append({ t: 'msg', message: message('assistant', 'two') });
  session.append({ t: 'msg', message: message('user', 'three') });

  const branched = session.branch(1, '/some/project', 'test-model');
  assert.equal(branched.messages.length, 2);
  assert.notEqual(branched.file, session.file);
  assert.equal(join(branched.file, '..'), join(session.file, '..'));
  const reopened = Session.open(branched.file);
  assert.equal(reopened.messages.length, 2);
  assert.deepEqual(reopened.lineage, {
    parentSessionId: session.id,
    parentFile: session.file,
    relation: 'branch',
    atMessage: 1,
  });
});

test('branch snapshot durability is bounded by bytes rather than per-message fsyncs', () => {
  const bulkDir = mkdtempSync(join(tmpdir(), 'pi-session-bulk-branch-'));
  const session = Session.create('/some/project', 'test-model', bulkDir);
  const entries = Array.from({ length: 5_000 }, (_, index) => ({
    t: 'msg' as const,
    message: message(index % 2 === 0 ? 'user' : 'assistant', `message-${index}`),
  }));
  session.appendMany(entries);
  const started = performance.now();
  const locked = session.branchLocked(entries.length - 1, '/some/project', 'test-model');
  const elapsed = performance.now() - started;
  assert.equal(locked.session.messages.length, entries.length);
  assert.ok(elapsed < 1_000, `bulk branch took ${elapsed.toFixed(1)}ms`);
  locked.release();
});

test('locked branch is reserved before copying and a continued parent remains a latest-session candidate', () => {
  const lineageDir = mkdtempSync(join(tmpdir(), 'pi-session-branch-head-'));
  const parent = Session.create('/some/project', 'test-model', lineageDir);
  parent.append({ t: 'msg', message: message('user', 'one') });
  const locked = parent.branchLocked(0, '/some/project', 'test-model');
  assert.equal(tryLockSession(locked.session.file), undefined);
  assert.equal(latestSessionFile(lineageDir), locked.session.file);
  assert.equal(latestSessionFile(lineageDir, { excludeActivelyLocked: true }), parent.file);

  parent.append({ t: 'msg', message: message('assistant', 'parent continued') });
  const future = new Date(Date.now() + 2_000);
  utimesSync(parent.file, future, future);
  assert.equal(latestSessionFile(lineageDir), parent.file);
  locked.release();
});

test('latest session follows a committed compaction child instead of parent mtime', () => {
  const lineageDir = mkdtempSync(join(tmpdir(), 'pi-session-lineage-'));
  const parent = Session.create('/some/project', 'test-model', lineageDir);
  const compactionId = parent.beginCompaction('manual');
  const child = Session.create('/some/project', 'test-model', lineageDir, {
    lineage: { parentSessionId: parent.id, parentFile: parent.file, relation: 'compaction' },
  });
  child.append({ t: 'msg', message: message('user', 'summary') });
  parent.completeCompaction(compactionId, 2, { targetSessionId: child.id });

  assert.equal(latestSessionFile(lineageDir), child.file);
});

test('latest session ignores an uncommitted compaction child', () => {
  const lineageDir = mkdtempSync(join(tmpdir(), 'pi-session-uncommitted-'));
  const parent = Session.create('/some/project', 'test-model', lineageDir);
  parent.beginCompaction('auto');
  Session.create('/some/project', 'test-model', lineageDir, {
    lineage: { parentSessionId: parent.id, parentFile: parent.file, relation: 'compaction' },
  });

  assert.equal(latestSessionFile(lineageDir), parent.file);
});

test('latest session ignores a branch until its copy is marked ready', () => {
  const lineageDir = mkdtempSync(join(tmpdir(), 'pi-session-unready-branch-'));
  const parent = Session.create('/some/project', 'test-model', lineageDir);
  const child = Session.create('/some/project', 'test-model', lineageDir, {
    lineage: { parentSessionId: parent.id, parentFile: parent.file, relation: 'branch', atMessage: 0 },
  });
  assert.equal(latestSessionFile(lineageDir), parent.file);
  child.markReady();
  assert.equal(latestSessionFile(lineageDir), child.file);
});

test('v2 lifecycle journal distinguishes planned, started, completed, and unknown tool outcomes', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.setRunStatus('running');
  const requestId = session.beginModelRequest('test-model', { messageCount: 1 });
  session.completeModelRequest(requestId, { stopReason: 'tool_use', usage });

  const completed = session.planTool(
    { type: 'toolCall', id: 'provider-1', name: 'write', arguments: { path: 'a.txt', content: 'a' } },
    { requestId },
  );
  session.startTool(completed);
  session.completeTool(completed);

  const interrupted = session.planTool(
    { type: 'toolCall', id: 'provider-2', name: 'bash', arguments: { command: 'deploy' } },
    { requestId },
  );
  session.startTool(interrupted);
  const neverStarted = session.planTool(
    { type: 'toolCall', id: 'provider-3', name: 'read', arguments: { path: 'a.txt' } },
    { requestId },
  );
  const skipped = session.planTool(
    { type: 'toolCall', id: 'provider-4', name: 'bash', arguments: { command: 'too-many-tools' } },
    { requestId },
  );
  session.skipTool(skipped, 'tool-call budget exhausted');

  const reopened = Session.open(session.file);
  assert.deepEqual(
    reopened.pendingToolExecutions.map(({ executionId, status }) => ({ executionId, status })),
    [
      { executionId: interrupted, status: 'started' },
      { executionId: neverStarted, status: 'planned' },
    ],
  );
  assert.deepEqual(reopened.interruptedToolExecutions.map((state) => state.executionId), [interrupted]);
  const skippedState = reopened.toolExecutions.find((state) => state.executionId === skipped);
  assert.equal(skippedState?.status, 'skipped');
  assert.equal(skippedState?.reason, 'tool-call budget exhausted');
  assert.equal(skippedState?.startedAt, undefined);
  assert.deepEqual(reopened.markInterruptedToolsOutcomeUnknown('crashed after dispatch'), [interrupted]);

  const recovered = Session.open(session.file);
  assert.equal(recovered.toolExecutions.find((state) => state.executionId === interrupted)?.status, 'outcome_unknown');
  assert.deepEqual(recovered.pendingToolExecutions.map((state) => state.executionId), [neverStarted]);
  assert.equal(recovered.runStatus?.status, 'running');
});

test('model, compaction, and terminal run lifecycle rows survive replay', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  const failedRequest = session.beginModelRequest('test-model');
  session.failModelRequest(failedRequest, 'provider unavailable', true);
  const compactionId = session.beginCompaction('manual', { keepFromMessage: 2 });
  session.completeCompaction(compactionId, 2, { targetSessionId: randomUUID(), usage });
  session.setRunStatus('failed', 'provider unavailable');

  const reopened = Session.open(session.file);
  assert.deepEqual(
    reopened.lifecycleEntries.map((entry) => entry.t),
    [
      'journal_schema',
      'model_request_started',
      'model_request_failed',
      'compaction_started',
      'compaction_completed',
      'run_status',
    ],
  );
  assert.equal(reopened.runStatus?.status, 'failed');
  assert.equal(reopened.runStatus?.reason, 'provider unavailable');
});

test('v2 request completion usage is authoritative while legacy history remains compatible', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'usage', usage }); // pre-v2 historical row
  const requestId = session.beginModelRequest('test-model');
  session.completeModelRequest(requestId, { stopReason: 'end_turn', usage });
  session.append({ t: 'usage', usage }); // compatibility duplicate written by the v2 agent

  const reopened = Session.open(session.file);
  assert.equal(reopened.usageEntries.length, 2);
  assert.deepEqual(reopened.usage, {
    inputTokens: 20,
    outputTokens: 10,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
  });
});

test('invalid lifecycle transitions fail before they are appended', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  const executionId = session.planTool({
    type: 'toolCall',
    id: 'provider-1',
    name: 'bash',
    arguments: { command: 'true' },
  });
  const before = readFileSync(session.file, 'utf8');
  assert.throws(() => session.completeTool(executionId), /cannot finish from planned/);
  assert.equal(readFileSync(session.file, 'utf8'), before);
  session.startTool(executionId);
  const afterStart = readFileSync(session.file, 'utf8');
  assert.throws(() => session.skipTool(executionId, 'too late'), /cannot be skipped from started/);
  assert.equal(readFileSync(session.file, 'utf8'), afterStart);
});

test('session locks are exclusive, owner-token protected, and owner-only', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  const firstRelease = tryLockSession(session.file);
  assert.ok(firstRelease);
  assert.equal(statSync(`${session.file}.lock`).mode & 0o777, 0o600);
  assert.equal(tryLockSession(session.file), undefined);

  // Simulate an external stale-lock cleanup and a new owner. The old callback
  // must inspect its token rather than unlinking the successor's lock.
  unlinkSync(`${session.file}.lock`);
  const secondRelease = tryLockSession(session.file);
  assert.ok(secondRelease);
  firstRelease();
  assert.ok(existsSync(`${session.file}.lock`));
  assert.equal(tryLockSession(session.file), undefined);
  secondRelease();
  assert.equal(existsSync(`${session.file}.lock`), false);

  // Even a lock whose recorded PID appears dead remains authoritative. PID
  // liveness and reuse are racy, so cleanup must be an explicit operator action.
  const staleLock = `${JSON.stringify({
    v: 1,
    pid: 2_147_483_647,
    token: 'dead-owner-token',
    created: '2000-01-01T00:00:00.000Z',
  })}\n`;
  writeFileSync(`${session.file}.lock`, staleLock, { encoding: 'utf8', mode: 0o600 });
  const staleInode = statSync(`${session.file}.lock`).ino;
  assert.equal(tryLockSession(session.file), undefined);
  assert.equal(readFileSync(`${session.file}.lock`, 'utf8'), staleLock);
  assert.equal(statSync(`${session.file}.lock`).ino, staleInode);

  // Manual cleanup restores normal exclusive acquisition.
  unlinkSync(`${session.file}.lock`);
  const afterCleanup = tryLockSession(session.file);
  assert.ok(afterCleanup);
  afterCleanup();
});

test('latest-session discovery treats a dead-PID lock as contention', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'pi-session-stale-lock-discovery-'));
  const unlocked = Session.create('/some/project', 'test-model', lockDir);
  const stale = Session.create('/some/project', 'test-model', lockDir);
  const future = new Date(Date.now() + 2_000);
  utimesSync(stale.file, future, future);
  writeFileSync(`${stale.file}.lock`, '2147483647', { encoding: 'utf8', mode: 0o600 });

  assert.equal(latestSessionFile(lockDir), stale.file);
  assert.equal(latestSessionFile(lockDir, { excludeActivelyLocked: true }), unlocked.file);
  assert.equal(tryLockSession(stale.file), undefined);
  assert.equal(readFileSync(`${stale.file}.lock`, 'utf8'), '2147483647');
  unlinkSync(`${stale.file}.lock`);
});

test('session locks share one process exit hook instead of leaking listeners', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'pi-session-lock-listeners-'));
  const before = process.listenerCount('exit');
  const locked = Array.from({ length: 16 }, () => Session.createLocked('/some/project', 'm', lockDir));
  assert.ok(process.listenerCount('exit') <= before + 1);
  for (const item of locked) item.release();
});
