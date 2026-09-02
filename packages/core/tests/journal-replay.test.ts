import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Message, ToolCallBlock, Usage } from '@pi/ai';
import {
  reduceModelRequests,
  reduceToolExecutions,
  validateLifecycle,
  type SessionEntry,
  type WorkspaceDigest,
} from '../src/journal.js';
import { Session } from '../src/session.js';

// ADR 0007 replay conformance: parsing a journal and re-appending its rows must
// reproduce exactly the lifecycle state the original file reduces to. This is
// the example-based half of the guarantee; the property-based corpus lands in
// tranche 3 (R2-12 / T3 G11).

const dir = mkdtempSync(join(tmpdir(), 'pi-journal-replay-'));
const usage: Usage = { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function bashCall(id: string, command: string): ToolCallBlock {
  return { type: 'toolCall', id, name: 'bash', arguments: { command } };
}

const plannedWorkspaceDigest: WorkspaceDigest = {
  kind: 'git',
  algorithm: 'sha256',
  digest: 'a'.repeat(64),
  workspace: '/some/project',
};

/** A bash call dispatched into the dark: started, never settled, digest recorded. */
function unknownBashOutcomeJournal(): string {
  const session = Session.create('/some/project', 'test-model', dir);
  session.setRunStatus('running');
  session.append({ t: 'msg', message: userMessage('deploy it') });
  const requestId = session.beginModelRequest('test-model', { messageCount: 1 });
  session.completeModelRequest(requestId, { stopReason: 'tool_use', usage });
  const executionId = session.planTool(bashCall('call-deploy', './deploy.sh'), {
    requestId,
    workspaceDigest: plannedWorkspaceDigest,
  });
  session.startTool(executionId);
  session.markToolOutcomeUnknown(executionId, 'process stopped before the tool result was durably recorded');
  session.setRunStatus('incomplete', 'interrupted');
  session.close();
  return session.file;
}

/** A committed compaction: the parent's rows plus the child that carries lineage. */
function compactionLineageJournals(): { parent: string; child: string } {
  const parent = Session.create('/some/project', 'test-model', dir);
  parent.setRunStatus('running');
  parent.append({ t: 'msg', message: userMessage('a long history') });
  const compactionId = parent.beginCompaction('auto', { keepFromMessage: 1 });
  const child = Session.create('/some/project', 'test-model', dir, {
    lineage: {
      parentSessionId: parent.id,
      parentFile: parent.file,
      relation: 'compaction',
      priorUsage: usage,
      priorUsageComplete: true,
    },
  });
  child.append({ t: 'msg', message: userMessage('summary of the history') });
  child.markReady();
  child.close();
  parent.completeCompaction(compactionId, 3, { targetSessionId: child.id, usage });
  parent.setRunStatus('completed', 'compacted');
  parent.close();
  return { parent: parent.file, child: child.file };
}

/** A turn stopped at an approval gate, with the decision recorded but nothing started. */
function approvalSuspensionJournal(): string {
  const session = Session.create('/some/project', 'test-model', dir);
  session.setRunStatus('running');
  const requestId = session.beginModelRequest('test-model', { messageCount: 1 });
  session.completeModelRequest(requestId, { stopReason: 'tool_use', usage });
  const gated = session.planTool(bashCall('call-gated', 'rm -rf build'), { requestId });
  session.requestToolApproval(gated);
  const undecided = session.planTool(bashCall('call-undecided', 'git push'), { requestId });
  session.requestToolApproval(undecided);
  session.decideToolApproval(gated, 'approved', { decidedAt: new Date().toISOString(), reason: 'reviewed' });
  session.setRunStatus('suspended', 'awaiting approval');
  session.close();
  return session.file;
}

/** A journal whose torn tail was repaired on the first append after reopening. */
function repairedTailJournal(): string {
  const session = Session.create('/some/project', 'test-model', dir);
  session.append({ t: 'msg', message: userMessage('kept across the crash') });
  appendFileSync(session.file, '{"t":"msg","message":{"role":"assist', 'utf8');
  session.close();
  const recovered = Session.openLocked(session.file)!;
  recovered.setRunStatus('running');
  recovered.close();
  return session.file;
}

interface LifecycleSnapshot {
  entries: readonly SessionEntry[];
  toolExecutions: unknown;
  modelRequests: unknown;
  repairs: unknown;
  lineage: unknown;
  openRun: unknown;
  costSummary: unknown;
  usage: unknown;
  messages: unknown;
}

function snapshot(file: string): LifecycleSnapshot {
  const session = Session.open(file);
  return {
    // The schema marker belongs to the file, not to the history it records: a
    // replay target writes its own, so it is not part of the replayed rows.
    entries: session.lifecycleEntries.filter((entry) => entry.t !== 'journal_schema'),
    toolExecutions: session.toolExecutions,
    modelRequests: session.modelRequests,
    repairs: session.journalRepairs,
    lineage: session.lineage,
    openRun: session.openRun,
    costSummary: session.costSummary,
    usage: session.usage,
    messages: session.messages,
  };
}

/** Re-append a parsed journal's rows into a fresh file, in their original order. */
function replay(file: string): string {
  const source = Session.open(file);
  const replayed = Session.create('/some/project', 'test-model', dir);
  const rows = [...source.journalRows].filter((entry) => entry.t !== 'meta' && entry.t !== 'journal_schema');
  replayed.appendMany(rows);
  replayed.close();
  return replayed.file;
}

test('0007: every corpus journal replays to identical validated lifecycle state', () => {
  const { parent, child } = compactionLineageJournals();
  const corpus = {
    'outcome-unknown bash call': unknownBashOutcomeJournal(),
    'compaction parent': parent,
    'compaction child': child,
    'approval suspension': approvalSuspensionJournal(),
    'repaired tail': repairedTailJournal(),
  };

  for (const [name, file] of Object.entries(corpus)) {
    const before = snapshot(file);
    const replayedFile = replay(file);
    const after = snapshot(replayedFile);
    assert.deepEqual(after.entries, before.entries, `${name}: replayed rows differ`);
    assert.deepEqual(after.toolExecutions, before.toolExecutions, `${name}: tool state differs`);
    assert.deepEqual(after.modelRequests, before.modelRequests, `${name}: model request state differs`);
    assert.deepEqual(after.repairs, before.repairs, `${name}: repair record differs`);
    assert.deepEqual(after.lineage, before.lineage, `${name}: lineage differs`);
    assert.deepEqual(after.openRun, before.openRun, `${name}: open run accounting differs`);
    assert.deepEqual(after.costSummary, before.costSummary, `${name}: cost summary differs`);
    assert.deepEqual(after.usage, before.usage, `${name}: usage differs`);
    assert.deepEqual(after.messages, before.messages, `${name}: messages differ`);
  }
});

test('0007: the corpus carries the states a resumer must distinguish', () => {
  const unknownOutcome = Session.open(unknownBashOutcomeJournal());
  const [bashExecution] = unknownOutcome.toolExecutions;
  assert.equal(bashExecution?.status, 'outcome_unknown');
  // The planning-time digest survives the round trip, so a resumer can compare
  // it against the workspace it sees rather than guessing.
  assert.deepEqual(bashExecution?.workspaceDigest, plannedWorkspaceDigest);

  const suspended = Session.open(approvalSuspensionJournal());
  assert.equal(suspended.suspendedToolExecutions.length, 2);
  assert.equal(suspended.awaitingApprovalExecutions.length, 1);
  assert.equal(suspended.runStatus?.status, 'suspended');

  const repaired = Session.open(repairedTailJournal());
  assert.equal(repaired.journalRepairs.length, 1);
  assert.equal(repaired.journalRepairs[0]?.repair, 'truncated_partial_line');
});

test('0007: replay rejects a corpus whose executionId was duplicated', () => {
  const entries = [...Session.open(unknownBashOutcomeJournal()).journalRows];
  const planned = entries.find((entry) => entry.t === 'tool_planned');
  assert.ok(planned, 'the corpus contains a planned call to duplicate');
  const duplicated = [...entries, structuredClone(planned)];

  assert.throws(() => validateLifecycle(duplicated), /duplicate tool execution/);
  assert.throws(() => reduceToolExecutions(duplicated), /duplicate tool execution/);

  // The same guarantee for provider attempts, which a naive replay could also
  // double-count into a false spend picture.
  const startedRequest = entries.find((entry) => entry.t === 'model_request_started');
  assert.ok(startedRequest, 'the corpus contains a model request to duplicate');
  const duplicatedRequest = [...entries, structuredClone(startedRequest)];
  assert.throws(() => reduceModelRequests(duplicatedRequest), /duplicate model request/);

  // And a real journal refuses the append rather than accepting the contradiction.
  const target = Session.create('/some/project', 'test-model', dir);
  assert.throws(
    () => target.appendMany(duplicated.filter((entry) => entry.t !== 'meta' && entry.t !== 'journal_schema')),
    /duplicate tool execution/,
  );
  target.close();
});
