import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { synthesizeInterruptedResults } from '../src/agent.js';
import { JOURNAL_SCHEMA_VERSION } from '../src/journal.js';
import {
  LockedSessionHeadError,
  Session,
  SessionCorruptionError,
  SessionPersistenceError,
  countJournalRepairs,
  latestSessionFile,
  listSessionsWithLockState,
  recoverStaleLock,
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

test('0027: a drain marker round-trips and does not move the schema generation', () => {
  const session = Session.create('/some/project', 'test-model', dir);
  session.setRunStatus('running');
  session.recordDrainRequested('SIGTERM', 10_000);
  session.setRunStatus('canceled', 'user_abort');

  const reopened = Session.open(session.file);
  const marker = reopened.drainRequests.at(-1);
  assert.equal(reopened.drainRequests.length, 1);
  assert.equal(marker?.signal, 'SIGTERM');
  assert.equal(marker?.graceMs, 10_000);
  assert.ok(marker?.at, 'the marker records when admission stopped');
  assert.equal(reopened.schemaVersion, JOURNAL_SCHEMA_VERSION, 'the row is additive on the v2 shape');
  assert.equal(reopened.runStatus?.status, 'canceled');
  // The row is validated like any other: a malformed grace period is refused.
  assert.throws(
    () => session.append({ t: 'run_drain_requested', v: 2, at: new Date().toISOString(), signal: 'SIGTERM', graceMs: -1 }),
    /graceMs/,
  );
  session.close();
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

  session.close();
  const reconciled = Session.openLocked(session.file)!;
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
  malformed.close();
  const recovered = Session.openLocked(malformed.file)!;
  recovered.setRunStatus('running');
  assert.equal(Session.open(malformed.file).messages.length, 1);
  assert.match(readFileSync(malformed.file, 'utf8'), /"run_status"/);

  const valid = Session.create('/some/project', 'test-model', dir);
  const unterminated = JSON.stringify({ t: 'msg', message: message('user', 'valid tail') });
  appendFileSync(valid.file, unterminated, 'utf8');
  valid.close();
  const resumed = Session.openLocked(valid.file)!;
  resumed.setRunStatus('completed', 'end_turn');
  const reopened = Session.open(valid.file);
  assert.equal(reopened.messages.length, 1);
  assert.equal(reopened.runStatus?.status, 'completed');
});

test('0015: a crash-shaped partial tail leaves a durable repair row with its byte counts', () => {
  const crashed = Session.create('/some/project', 'test-model', dir);
  crashed.append({ t: 'msg', message: message('user', 'kept') });
  const intactBytes = statSync(crashed.file).size;
  // A torn write: a complete row was being appended when the process died.
  const partialTail = '{"t":"msg","message":{"role":"assist';
  appendFileSync(crashed.file, partialTail, 'utf8');
  crashed.close();

  const recovered = Session.openLocked(crashed.file)!;
  recovered.setRunStatus('running');
  recovered.close();

  const reopened = Session.open(crashed.file);
  assert.equal(reopened.messages.length, 1);
  const repairs = reopened.journalRepairs;
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.repair, 'truncated_partial_line');
  assert.equal(repairs[0]?.offset, intactBytes, 'the repair offset is the last intact byte boundary');
  assert.equal(repairs[0]?.discardedBytes, Buffer.byteLength(partialTail, 'utf8'));

  // The record leads the first append, so the discarded bytes are accounted for
  // before any row that was written after the repair.
  const lines = readFileSync(crashed.file, 'utf8').trim().split('\n');
  const repairIndex = lines.findIndex((line) => line.includes('"journal_repaired"'));
  const statusIndex = lines.findIndex((line) => line.includes('"run_status"'));
  assert.ok(repairIndex >= 0 && statusIndex > repairIndex, 'the repair row precedes the rows it made room for');

  // Repair is recorded once, not re-declared on every later append.
  const stillLocked = Session.openLocked(crashed.file)!;
  stillLocked.setRunStatus('completed', 'end_turn');
  stillLocked.close();
  assert.equal(Session.open(crashed.file).journalRepairs.length, 1);
});

/** A torn row whose tail is one repeated digit: every suffix of it is valid JSON. */
function longTornRow(digits: number): string {
  return `{"t":"msg","message":{"role":"assistant","content":[{"type":"text","text":"torn"}],"n":${'7'.repeat(digits)}`;
}

test('0015: a fragment longer than the rows written over it is truncated and recorded once', () => {
  const repairDir = mkdtempSync(join(tmpdir(), 'pi-repair-truncate-'));
  const crashed = Session.create('/some/project', 'test-model', repairDir);
  crashed.append({ t: 'msg', message: message('user', 'kept') });
  const intactBytes = statSync(crashed.file).size;
  const partialTail = longTornRow(400);
  appendFileSync(crashed.file, partialTail, 'utf8');
  crashed.close();

  const recovered = Session.openLocked(crashed.file)!;
  recovered.setRunStatus('running');
  recovered.close();

  const repaired = readFileSync(crashed.file, 'utf8');
  assert.ok(repaired.endsWith('\n'), 'the repaired journal ends on a row boundary');
  assert.ok(!repaired.includes('7777'), 'the fragment is truncated away, not left after the new rows');
  assert.ok(
    statSync(crashed.file).size < intactBytes + Buffer.byteLength(partialTail, 'utf8'),
    'the file is shorter than it was, so the truncate half of the protocol ran',
  );

  const reopened = Session.open(crashed.file);
  assert.equal(reopened.messages.length, 1);
  assert.equal(reopened.runStatus?.status, 'running');
  const repairs = reopened.journalRepairs;
  assert.equal(repairs.length, 1, 'the completed protocol records exactly one repair');
  assert.equal(repairs[0]?.offset, intactBytes);
  assert.equal(repairs[0]?.discardedBytes, Buffer.byteLength(partialTail, 'utf8'));
});

test('0015: a crash between the repair rows and the truncate records the leftover as a second repair', () => {
  const repairDir = mkdtempSync(join(tmpdir(), 'pi-repair-crash-window-'));
  const crashed = Session.create('/some/project', 'test-model', repairDir);
  crashed.append({ t: 'msg', message: message('user', 'kept') });
  const intactBytes = statSync(crashed.file).size;
  const partialTail = longTornRow(400);
  const partialTailBytes = Buffer.byteLength(partialTail, 'utf8');
  appendFileSync(crashed.file, partialTail, 'utf8');
  crashed.close();

  // Learn the exact bytes one repaired append writes at the repair offset by
  // running the real append against a byte-identical copy of the crashed file.
  const probeFile = join(repairDir, `${randomUUID()}.jsonl`);
  writeFileSync(probeFile, readFileSync(crashed.file));
  const probe = Session.openLocked(probeFile)!;
  probe.setRunStatus('running');
  probe.close();
  const repairRowBytes = readFileSync(probeFile).subarray(intactBytes);
  assert.ok(repairRowBytes.length < partialTailBytes, 'the rows must be shorter than the fragment they overwrite');

  // The crash: the positional row write lands and is fsynced, the truncate that
  // would remove the rest of the fragment never runs.
  const crashedFd = openSync(crashed.file, 'r+');
  try {
    writeSync(crashedFd, repairRowBytes, 0, repairRowBytes.length, intactBytes);
    fsyncSync(crashedFd);
  } finally {
    closeSync(crashedFd);
  }
  const leftoverBytes = partialTailBytes - repairRowBytes.length;
  assert.equal(statSync(crashed.file).size, intactBytes + repairRowBytes.length + leftoverBytes);
  const leftoverText = readFileSync(crashed.file, 'utf8').slice(-leftoverBytes);
  assert.ok(!leftoverText.includes('\n'), "the leftover inherits the fragment's missing delimiter");
  assert.doesNotThrow(
    () => JSON.parse(leftoverText),
    'the leftover is well-formed JSON, the case a reader must tolerate rather than fail closed on',
  );

  // Reopening tolerates the leftover as what it is: another undelimited tail.
  const secondRecovery = Session.openLocked(crashed.file)!;
  secondRecovery.setRunStatus('completed', 'end_turn');
  secondRecovery.close();

  const reopened = Session.open(crashed.file);
  const repairs = reopened.journalRepairs;
  assert.equal(repairs.length, 2, 'both discards are on the record');
  assert.equal(repairs[0]?.repair, 'truncated_partial_line', 'the pre-crash repair row survived the crash');
  assert.equal(repairs[0]?.offset, intactBytes);
  assert.equal(repairs[0]?.discardedBytes, partialTailBytes);
  assert.equal(repairs[1]?.repair, 'truncated_partial_line');
  assert.equal(repairs[1]?.offset, intactBytes + repairRowBytes.length, 'the second repair starts where the rows end');
  assert.equal(repairs[1]?.discardedBytes, leftoverBytes, 'the second row accounts for exactly the leftover fragment');

  // Nothing written before the crash was lost, and nothing is silently discarded.
  assert.equal(reopened.messages.length, 1);
  assert.equal(reopened.runStatus?.status, 'completed');
  const settled = readFileSync(crashed.file, 'utf8');
  assert.ok(settled.endsWith('\n'), 'the repaired journal ends on a row boundary');
  assert.ok(!settled.includes('7777'), 'the leftover is gone only once its discard is recorded');
  assert.equal(countJournalRepairs(crashed.file), 2);
});

test('0015: a valid but undelimited final row records the newline repair and discards nothing', () => {
  const undelimited = Session.create('/some/project', 'test-model', dir);
  const validRow = JSON.stringify({ t: 'msg', message: message('user', 'valid tail') });
  appendFileSync(undelimited.file, validRow, 'utf8');
  const unterminatedBytes = statSync(undelimited.file).size;
  undelimited.close();

  const resumed = Session.openLocked(undelimited.file)!;
  resumed.setRunStatus('completed', 'end_turn');
  resumed.close();

  const reopened = Session.open(undelimited.file);
  assert.equal(reopened.messages.length, 1, 'a complete final row is kept, not discarded');
  const repairs = reopened.journalRepairs;
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]?.repair, 'appended_missing_newline');
  assert.equal(repairs[0]?.offset, unterminatedBytes);
  assert.equal(repairs[0]?.discardedBytes, 0);
  assert.equal(countJournalRepairs(undelimited.file), 1);
});

test('0015: an intact journal records no repair and doctor counts repaired sessions', () => {
  const inventory = mkdtempSync(join(tmpdir(), 'pi-repair-inventory-'));
  const intact = Session.create('/some/project', 'test-model', inventory);
  intact.append({ t: 'msg', message: message('user', 'clean') });
  intact.close();
  assert.equal(Session.open(intact.file).journalRepairs.length, 0);
  assert.equal(countJournalRepairs(intact.file), 0);

  const repaired = Session.create('/some/project', 'test-model', inventory);
  appendFileSync(repaired.file, '{"t":', 'utf8');
  repaired.close();
  const recovered = Session.openLocked(repaired.file)!;
  recovered.markReady();
  recovered.close();

  const reports = listSessionsWithLockState(inventory);
  const intactReport = reports.find((report) => report.file === intact.file);
  const repairedReport = reports.find((report) => report.file === repaired.file);
  assert.equal(intactReport?.repairs, undefined, 'an intact session carries no repair count');
  assert.equal(repairedReport?.repairs, 1);
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
    (error: unknown) =>
      error instanceof Error &&
      (('code' in error && (error as { code?: string }).code === 'EEXIST') ||
        /could not reserve session lock/.test(error.message)),
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

test('locked branch is reserved before copying and a locked newest head fails loudly (0024)', () => {
  const lineageDir = mkdtempSync(join(tmpdir(), 'pi-session-branch-head-'));
  const parent = Session.create('/some/project', 'test-model', lineageDir);
  parent.append({ t: 'msg', message: message('user', 'one') });
  const locked = parent.branchLocked(0, '/some/project', 'test-model');
  assert.equal(tryLockSession(locked.session.file), undefined);
  assert.equal(latestSessionFile(lineageDir), locked.session.file);
  // Rank before filtering locks: the newest head being locked is an error,
  // never a silent fallback to the older parent.
  assert.throws(
    () => latestSessionFile(lineageDir, { excludeActivelyLocked: true }),
    LockedSessionHeadError,
  );

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
  session.close();
  const relocked = Session.openLocked(session.file)!;
  assert.deepEqual(relocked.markInterruptedToolsOutcomeUnknown('crashed after dispatch'), [interrupted]);

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
  session.close(); // create() holds its lock (0023); this test drives the primitive directly
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
  // 0024: a locked newest head is reported, not skipped, and the legacy
  // bare-pid record stays diagnosable but never auto-removable.
  assert.throws(() => latestSessionFile(lockDir, { excludeActivelyLocked: true }), LockedSessionHeadError);
  assert.equal(tryLockSession(stale.file), undefined);
  assert.equal(readFileSync(`${stale.file}.lock`, 'utf8'), '2147483647');
  const refused = recoverStaleLock(stale.file);
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /legacy/);
  unlinkSync(`${stale.file}.lock`);
});

test('session locks share one process exit hook instead of leaking listeners', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'pi-session-lock-listeners-'));
  const before = process.listenerCount('exit');
  const locked = Array.from({ length: 16 }, () => Session.createLocked('/some/project', 'm', lockDir));
  assert.ok(process.listenerCount('exit') <= before + 1);
  for (const item of locked) item.release();
});

test('0024 acceptance: crash leaves a lock, selection fails loudly, doctor recovers, selection resumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-0024-acceptance-'));
  const older = Session.create('/some/project', 'm', dir);
  older.append({ t: 'msg', message: message('user', 'old work') });
  const newest = Session.create('/some/project', 'm', dir);
  newest.append({ t: 'msg', message: message('user', 'newest work') });
  const future = new Date(Date.now() + 5_000);
  utimesSync(newest.file, future, future);

  // Simulate a SIGKILL crash: a v2 lock record whose pid is dead on this host.
  const deadPid = 2147483_000;
  writeFileSync(
    `${newest.file}.lock`,
    `${JSON.stringify({ v: 2, pid: deadPid, host: hostname(), token: 'tok-dead', created: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  const error = (() => {
    try {
      latestSessionFile(dir, { excludeActivelyLocked: true });
      return undefined;
    } catch (thrown) {
      return thrown as LockedSessionHeadError;
    }
  })();
  assert.ok(error instanceof LockedSessionHeadError, 'a locked newest head must be an error, not a fallback');
  assert.equal(error.file, newest.file);
  assert.equal(error.owner?.pid, deadPid);
  assert.match(error.message, /doctor sessions/);

  const survey = listSessionsWithLockState(dir);
  const lockedRow = survey.find((row) => row.file === newest.file);
  assert.equal(lockedRow?.classification, 'removable');

  const outcome = recoverStaleLock(newest.file);
  assert.equal(outcome.removed, true, outcome.reason);
  assert.equal(latestSessionFile(dir, { excludeActivelyLocked: true }), newest.file);
});

test('0024: recovery refuses live, remote, malformed, and serialized-out owners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-0024-refusals-'));
  const target = Session.create('/some/project', 'm', dir);
  const lockPath = `${target.file}.lock`;
  const record = (over: Record<string, unknown>) =>
    `${JSON.stringify({ v: 2, pid: 2147483_000, host: hostname(), token: 't', created: new Date().toISOString(), ...over })}\n`;

  writeFileSync(lockPath, record({ pid: process.pid }), { encoding: 'utf8', mode: 0o600 });
  assert.match(recoverStaleLock(target.file).reason, /live/);

  writeFileSync(lockPath, record({ host: 'some-other-host.example' }), { encoding: 'utf8', mode: 0o600 });
  assert.match(recoverStaleLock(target.file).reason, /remote/);

  writeFileSync(lockPath, 'not json and not a pid\n', { encoding: 'utf8', mode: 0o600 });
  assert.match(recoverStaleLock(target.file).reason, /malformed/);

  // Concurrent recovery: an existing recovery lock serializes us out.
  writeFileSync(lockPath, record({}), { encoding: 'utf8', mode: 0o600 });
  const recoveryLock = join(dir, '.recovery.lock');
  writeFileSync(recoveryLock, 'held\n', { encoding: 'utf8', mode: 0o600 });
  assert.match(recoverStaleLock(target.file).reason, /another recovery/);
  unlinkSync(recoveryLock);
  assert.equal(recoverStaleLock(target.file).removed, true);
});

test('0023 acceptance: no public API yields an unlocked mutable session', () => {
  const capabilityDir = mkdtempSync(join(tmpdir(), 'pi-0023-acceptance-'));

  // Session.create() is not an unlocked escape hatch: it holds its own lock.
  const created = Session.create('/some/project', 'm', capabilityDir);
  assert.equal(tryLockSession(created.file), undefined, 'create() must already hold the lock');
  assert.equal(Session.openLocked(created.file), undefined, 'a second locked opener must fail');

  // A read-only open cannot mutate, even when cast around the type system.
  const view = Session.open(created.file);
  assert.throws(() => view.append({ t: 'msg', message: message('user', 'forged') }), /requires the lock/);

  // close() is idempotent and hands the capability off cleanly.
  created.close();
  created.close();
  assert.throws(() => created.append({ t: 'msg', message: message('user', 'after close') }), /requires the lock/);
  const relocked = Session.openLocked(created.file);
  assert.ok(relocked, 'the lock is available after close');
  relocked!.append({ t: 'msg', message: message('user', 'locked append works') });

  // The review's double-open interleave: a second mutable handle cannot exist.
  assert.equal(Session.openLocked(created.file), undefined);
  const stale = Session.open(created.file);
  assert.throws(() => stale.setRunStatus('running'), /requires the lock/);
  relocked!.close();
});

test('hard-linked journal cannot bypass single-writer (owner review repro)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-hardlink-bypass-'));
  const session = Session.create('/some/project', 'm', dir);
  session.append({ t: 'msg', message: message('user', 'seed') });
  session.close();

  const alias = join(dir, `${randomUUID()}.jsonl`);
  linkSync(session.file, alias);

  // Neither name may open: the journal now has two links, so pathname-keyed
  // locks could otherwise mint two writers for one inode.
  assert.throws(() => Session.openLocked(session.file), /single-link/);
  assert.throws(() => Session.openLocked(alias), /single-link/);
  assert.throws(() => Session.open(session.file), /single-link/);

  // Restore single-link state: the journal opens and appends again.
  unlinkSync(alias);
  const relocked = Session.openLocked(session.file);
  assert.ok(relocked);
  relocked!.append({ t: 'msg', message: message('user', 'after unlink') });
  relocked!.close();
});

test('recovery refuses targets that are not real contained sessions (owner review)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-recover-target-'));
  const notASession = join(dir, 'not-a-session');
  writeFileSync(
    `${notASession}.lock`,
    `${JSON.stringify({ v: 2, pid: 2147483000, host: hostname(), token: 't', created: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const outcome = recoverStaleLock(notASession);
  assert.equal(outcome.removed, false);
  assert.match(outcome.reason, /refusing recovery/);
  assert.ok(existsSync(`${notASession}.lock`), 'the lock file must not be deleted');
});

test('a crashed recovery does not disable recovery forever (owner review)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-recovery-selfheal-'));
  const target = Session.create('/some/project', 'm', dir);
  target.close();
  writeFileSync(
    `${target.file}.lock`,
    `${JSON.stringify({ v: 2, pid: 2147483000, host: hostname(), token: 'dead', created: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  // Simulate a doctor that died mid-recovery on this host.
  writeFileSync(
    join(dir, '.recovery.lock'),
    `${JSON.stringify({ v: 2, pid: 2147483001, host: hostname(), token: 'crashed', created: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const outcome = recoverStaleLock(target.file);
  assert.equal(outcome.removed, true, outcome.reason);
});
