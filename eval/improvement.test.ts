import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headlessCapabilities } from '../packages/cli/dist/capabilities.js';
import { compare, diagnose, propose, runCycle, reserveTrial, settleTrial, type Measurement } from './improvement.js';

const rule = { repeats: 5, maxQualityLoss: .05, minSavings: .05, perTrialUSD: 1 };
function pairs(repeats = 5): Measurement[] {
  return Array.from({ length: repeats }, (_, repeat) => [
    { task: 'a', repeat, arm: 'baseline' as const, pass: true, usd: 1, offloaded: 1, artifact: 'baseline' },
    { task: 'a', repeat, arm: 'candidate' as const, pass: true, usd: .5, offloaded: 1, artifact: 'candidate' },
  ]).flat();
}
test('diagnosis uses actual events and exact source lines, not prose claims', () => {
  const stream = [
    { v: 1, event: { type: 'text', text: 'I offloaded 1000 files' } },
    { v: 1, event: { type: 'offloaded', count: 2, savedChars: 9000 } },
    { v: 1, event: { type: 'tool_start', call: { name: 'read', arguments: { path: '.pi/artifacts/run-a/offload-1.txt' } } } },
  ].map(row => JSON.stringify(row)).join('\n');
  const evidence = diagnose(stream);
  assert.equal(evidence.offloaded, 2);
  assert.equal(evidence.recalls, 1);
  assert.deepEqual(evidence.references, [2, 3]);
  assert.equal(propose(evidence)?.policy.keepRecentMessages, 12);
  assert.equal(propose(diagnose('')), undefined);
  assert.throws(() => diagnose(stream + '\nbroken'));
});
test('diagnosis accepts the CLI capabilities header and preserves JSONL line references', () => {
  const header = { v: 1, sessionId: 'scout-session', capabilities: headlessCapabilities([{ name: 'read' }]) };
  const events = [
    { v: 1, event: { type: 'tool_end', result: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } } },
    { v: 1, event: { type: 'offloaded', count: 1 } },
    { v: 1, event: { type: 'turn_done' } },
  ];
  const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
  const evidence = diagnose('\n' + encode([header, ...events]) + '\n');
  assert.deepEqual(evidence, { offloaded: 1, largeOutputs: 1, recalls: 0, references: [3, 4] });
  assert.deepEqual(propose(evidence)?.policy, { thresholdChars: 2000, keepRecentMessages: 4 });
  for (const bad of [null, {}, { v: 2, ...{ sessionId: header.sessionId, capabilities: header.capabilities } },
    { ...header, capabilities: {} }, { ...header, event: null }]) {
    assert.throws(() => diagnose(encode([bad, ...events])), /invalid event stream at line 1/);
  }
  assert.throws(() => diagnose(encode([header, header])), /invalid event stream at line 2/);
  assert.throws(() => diagnose(encode([events[0], header])), /invalid event stream at line 2/);
  assert.throws(() => diagnose(encode([header, { v: 1, unexpected: true }])), /invalid event stream at line 2/);
});
test('missing cost on a failed attempt blocks the entire comparison', () => {
  const rows = pairs(); rows[1]!.pass = false; rows[1]!.usd = null;
  assert.equal(compare(rows, ['a'], rule).verdict, 'insufficient_evidence');
});
test('missing/duplicate pairs, unknown costs, and dormant mechanisms cannot pass', () => {
  assert.equal(compare(pairs().slice(1), ['a'], rule).verdict, 'insufficient_evidence');
  const duplicate = pairs(); duplicate[1] = duplicate[0]!;
  assert.equal(compare(duplicate, ['a'], rule).verdict, 'insufficient_evidence');
  for (const usd of [NaN, Infinity, -1, 1.1]) {
    const rows = pairs(); rows[0]!.usd = usd;
    assert.equal(compare(rows, ['a'], rule).verdict, 'insufficient_evidence');
  }
  assert.equal(compare(pairs().map(row => ({ ...row, offloaded: 0 })), ['a'], rule).verdict, 'insufficient_evidence');
});
test('cheaper but substantially worse candidate is rejected', () => {
  const rows = pairs(); rows[1]!.pass = false;
  assert.equal(compare(rows, ['a'], rule).verdict, 'rejected');
});
test('pilot point estimate can screen in but cannot falsely certify improvement', () => {
  assert.equal(compare(pairs(), ['a'], rule, false).verdict, 'supported');
  assert.equal(compare(pairs(), ['a'], rule, true).verdict, 'insufficient_evidence');
});
test('sufficient bounded evidence can support a parked candidate', () => {
  assert.equal(compare(pairs(10000), ['a'], { ...rule, repeats: 10000 }).verdict, 'supported');
});

test('complete cycle freezes one proposal before confirmation and alternates arms', () => {
  const calls: string[] = []; let proposals = 0;
  const result = runCycle({
    development: ['dev'], confirmation: ['sealed'], rule,
    trial(suite, task, repeat, arm, policy) {
      calls.push(`${suite}:${repeat}:${arm}`);
      if (suite === 'offload-confirmation') assert.equal(proposals, 1);
      if (arm === 'candidate') assert.equal(Object.isFrozen(policy), true);
      return { row: { task, repeat, arm, pass: true, usd: arm === 'baseline' ? 1 : .5, offloaded: 1, artifact: task },
        evidence: { offloaded: 1, largeOutputs: 1, recalls: 0, references: [1] } };
    },
    onProposal() { proposals++; }, onStage() {},
  });
  assert.equal(proposals, 1);
  assert.equal(result.verdict, 'insufficient_evidence');
  assert.equal(calls.length, 21); // scout + 5 repeats * 2 arms * 2 suites
  assert.deepEqual(calls.slice(1, 5), ['offload-development:0:baseline', 'offload-development:0:candidate', 'offload-development:1:candidate', 'offload-development:1:baseline']);
});
test('rejected development candidate never consumes confirmation tasks', () => {
  const result = runCycle({
    development: ['dev'], confirmation: ['sealed'], rule,
    trial(suite, task, repeat, arm) {
      assert.equal(suite, 'offload-development');
      return { row: { task, repeat, arm, pass: true, usd: arm === 'baseline' ? .5 : 1, offloaded: 1, artifact: task },
        evidence: { offloaded: 1, largeOutputs: 1, recalls: 0, references: [1] } };
    }, onProposal() {}, onStage() {},
  });
  assert.equal(result.verdict, 'rejected');
});

test('fixed scout batch includes zero-evidence tasks and later recalls before freezing', () => {
  const calls: string[] = []; let proposals = 0;
  const result = runCycle({
    development: ['dev-a', 'dev-b', 'dev-c'], confirmation: ['sealed'], rule: { ...rule, repeats: 1 },
    trial(suite, task, repeat, arm, policy, phase) {
      calls.push(`${phase}:${task}:${arm}`);
      if (phase === 'scout') {
        assert.equal(proposals, 0);
        assert.equal(suite, 'offload-development');
        assert.equal(arm, 'baseline');
        assert.equal(policy.thresholdChars, 4000);
      } else {
        assert.equal(proposals, 1);
        if (arm === 'candidate') assert.equal(policy.thresholdChars, 8000);
      }
      return {
        // Expensive, failed scouts must not contaminate the paired quality/cost screen.
        row: { task, repeat, arm, phase, pass: phase === 'measurement',
          usd: phase === 'scout' ? 1 : arm === 'baseline' ? .2 : .1, offloaded: 1, artifact: `${phase}/${task}/${arm}` },
        evidence: { offloaded: task === 'dev-b' ? 1 : 0, largeOutputs: task === 'dev-b' ? 1 : 0,
          recalls: task === 'dev-c' ? 1 : 0, references: task === 'dev-a' ? [] : [25] },
      };
    },
    onProposal(proposal, scouts) {
      proposals++;
      assert.deepEqual(calls, ['scout:dev-a:baseline', 'scout:dev-b:baseline', 'scout:dev-c:baseline']);
      assert.deepEqual(scouts.evidence, { offloaded: 1, largeOutputs: 1, recalls: 1 });
      assert.deepEqual(scouts.sources.map(s => [s.row.artifact, s.evidence.references]),
        [['scout/dev-a/baseline', []], ['scout/dev-b/baseline', [25]], ['scout/dev-c/baseline', [25]]]);
      assert.equal(proposal.policy.keepRecentMessages, 12);
    },
    onStage(suite, decision) {
      if (suite === 'offload-development') {
        assert.equal(decision.verdict, 'supported');
        assert.ok('metrics' in decision);
        assert.equal(decision.metrics.baselinePass, 3);
        assert.equal(decision.metrics.candidatePass, 3);
        assert.ok(Math.abs(decision.metrics.baselineCost - .6) < 1e-9);
      }
    },
  });
  assert.equal(result.verdict, 'insufficient_evidence');
  assert.equal(calls.length, 11); // three scouts + six development + two confirmation
});

test('all-zero scout batch completes once without proposing or measuring', () => {
  const tasks: string[] = [];
  const result = runCycle({
    development: ['a', 'b', 'c'], confirmation: ['sealed'], rule,
    trial(suite, task, repeat, arm, policy, phase) {
      assert.equal(phase, 'scout'); tasks.push(task);
      return { row: { task, repeat, arm, phase, pass: true, usd: .01, offloaded: 0, artifact: task },
        evidence: { offloaded: 0, largeOutputs: 0, recalls: 0, references: [] } };
    },
    onProposal() { assert.fail('no proposal without evidence'); },
    onStage() { assert.fail('no comparison without proposal'); },
  });
  assert.deepEqual(tasks, ['a', 'b', 'c']);
  assert.equal(result.verdict, 'insufficient_evidence');
  assert.match(result.reason, /fixed scout batch/);
});

test('incomplete scout batch cannot propose from early evidence or exceed the budget', () => {
  const account = { spentUSD: 0, reservedUSD: 0 }; const dispatched: string[] = [];
  assert.throws(() => runCycle({
    development: ['a', 'b', 'c'], confirmation: ['sealed'], rule,
    trial(suite, task, repeat, arm, policy, phase) {
      reserveTrial(account, 1, 1.5);
      dispatched.push(task);
      settleTrial(account, { complete: true, usd: .75, unknownRequests: 0, unpricedRequests: 0, reservedUSD: 0 });
      return { row: { task, repeat, arm, phase, pass: true, usd: .75, offloaded: 1, artifact: task },
        evidence: { offloaded: 1, largeOutputs: 1, recalls: 0, references: [25] } };
    },
    onProposal() { assert.fail('no proposal from partial batch'); },
    onStage() { assert.fail('no measurements after incomplete batch'); },
  }), /research budget exhausted/);
  assert.deepEqual(dispatched, ['a']);
  assert.deepEqual(account, { spentUSD: .75, reservedUSD: 0 });
});

test('duplicate scout tasks and scout rows in comparisons are rejected', () => {
  const result = runCycle({
    development: ['a', 'a'], confirmation: ['sealed'], rule,
    trial() { throw new Error('invalid suite must not dispatch'); }, onProposal() {}, onStage() {},
  });
  assert.equal(result.verdict, 'insufficient_evidence');
  assert.equal(compare(pairs().map(row => ({ ...row, phase: 'scout' })), ['a'], rule).verdict, 'insufficient_evidence');
});

test('custom suite names preserve scout and confirmation isolation', () => {
  const suites: string[] = [];
  runCycle({
    development: ['dev'], confirmation: ['confirm'], rule: { ...rule, repeats: 1 },
    suiteNames: { development: 'representative-development', confirmation: 'representative-confirmation' },
    trial(suite, task, repeat, arm, policy, phase) {
      suites.push(`${phase}:${suite}:${task}:${arm}`);
      return { row: { task, repeat, arm, phase, pass: true, usd: arm === 'candidate' ? .1 : .2, offloaded: 1, artifact: task },
        evidence: { offloaded: 1, largeOutputs: 1, recalls: 0, references: [2] } };
    },
    onProposal() {}, onStage() {},
  });
  assert.deepEqual(suites, [
    'scout:representative-development:dev:baseline',
    'measurement:representative-development:dev:baseline',
    'measurement:representative-development:dev:candidate',
    'measurement:representative-confirmation:confirm:baseline',
    'measurement:representative-confirmation:confirm:candidate',
  ]);
});
test('research reservations bound dispatch and retain unknown exposure', () => {
  const account = { spentUSD: 0, reservedUSD: 0 };
  reserveTrial(account, 1, 2);
  assert.throws(() => settleTrial(account));
  assert.deepEqual(account, { spentUSD: 0, reservedUSD: 1 });
  assert.throws(() => reserveTrial(account, 1, 2));
  settleTrial(account, { complete: true, usd: .75, unknownRequests: 0, unpricedRequests: 0, reservedUSD: 0 });
  assert.deepEqual(account, { spentUSD: .75, reservedUSD: 0 });
  assert.throws(() => reserveTrial(account, 1.5, 2));
  reserveTrial(account, 1, 2);
  assert.throws(() => settleTrial(account, { complete: true, usd: .1, unknownRequests: 1, unpricedRequests: 0, reservedUSD: 0 }));
  assert.equal(account.reservedUSD, 1);
});
