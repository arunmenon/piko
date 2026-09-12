import assert from 'node:assert/strict';
import { test } from 'node:test';
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
