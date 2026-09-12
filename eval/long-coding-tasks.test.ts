import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { longCodingConfirmation, longCodingDevelopment, longCodingQualifications } from './long-coding-tasks.js';
import { taskDefinitionSha256 } from './task-definition.js';

function materialize(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-long-coding-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

for (const qualification of longCodingQualifications) {
  test(`${qualification.task.name}: seeded fails, maintainer passes, wrong solutions fail`, () => {
    const seeded = materialize(qualification.task.files);
    const corrected = materialize(qualification.task.files);
    const wrong = qualification.applyWrong.map(() => materialize(qualification.task.files));
    try {
      assert.equal(qualification.task.verify(seeded), false);
      qualification.applyCorrect(corrected);
      assert.equal(qualification.task.verify(corrected), true);
      qualification.applyWrong.forEach((apply, index) => {
        apply(wrong[index]!);
        assert.equal(qualification.task.verify(wrong[index]!), false);
      });
    } finally {
      for (const dir of [seeded, corrected, ...wrong]) rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('long coding split is fixed, disjoint, and explicit about test integrity', () => {
  const all = [...longCodingDevelopment, ...longCodingConfirmation];
  assert.equal(longCodingDevelopment.length, 3);
  assert.equal(longCodingConfirmation.length, 3);
  assert.equal(new Set(all.map((task) => task.name)).size, 6);
  for (const task of all) {
    assert.match(task.prompt, /Do not modify or remove existing tests/u);
    assert.match(taskDefinitionSha256(task), /^[a-f0-9]{64}$/u);
    assert.ok(Object.keys(task.files).length >= 12, `${task.name} is not a substantive multi-file fixture`);
  }
});
test('long coding preregistration matches task hashes and fixed split', () => {
  const plan = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'experiments', 'offload-long-coding-v1-preregistration.json'), 'utf8')) as {
    tasks: { development: Array<{ name: string; definitionSha256: string }>; confirmation: Array<{ name: string; definitionSha256: string }> };
    budget: { milestoneUSD: number; perTrialUSD: number };
    execution: { maximumTrials: number };
  };
  assert.deepEqual(plan.tasks.development, longCodingDevelopment.map((task) => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) })));
  assert.deepEqual(plan.tasks.confirmation, longCodingConfirmation.map((task) => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) })));
  assert.deepEqual(plan.budget, {
    milestoneUSD: 1, perTrialUSD: 0.1, priorCumulativeUSD: 0.06731935,
    overallAuthorizedUSD: 5, maximumCumulativeUSD: 1.06731935,
  });
  assert.equal(plan.execution.maximumTrials, 63);
});
