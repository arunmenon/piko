import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { representativeConfirmation, representativeDevelopment, representativeQualifications } from './representative-tasks.js';
import { taskDefinitionSha256 } from './task-definition.js';

function materialize(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-representative-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

for (const qualification of representativeQualifications) {
  test(`${qualification.task.name}: seeded fixture fails and maintainer repair passes`, () => {
    const seeded = materialize(qualification.task.files);
    const corrected = materialize(qualification.task.files);
    try {
      assert.equal(qualification.task.verify(seeded), false, 'seeded repository must fail its independent verifier');
      qualification.applyCorrect(corrected);
      assert.equal(qualification.task.verify(corrected), true, 'maintainer repair must satisfy public and hidden checks');
    } finally {
      rmSync(seeded, { recursive: true, force: true });
      rmSync(corrected, { recursive: true, force: true });
    }
  });

  qualification.applyWrong.forEach((applyWrong, index) => {
    test(`${qualification.task.name}: rejects deliberately incorrect solution ${index + 1}`, () => {
      const dir = materialize(qualification.task.files);
      try {
        applyWrong(dir);
        assert.equal(qualification.task.verify(dir), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test('representative development and confirmation identities are fixed and disjoint', () => {
  assert.deepEqual(representativeDevelopment.map((task) => task.name), [
    'coding-dev-integration', 'coding-dev-cross-file', 'coding-dev-regression',
  ]);
  assert.deepEqual(representativeConfirmation.map((task) => task.name), [
    'coding-confirm-integration', 'coding-confirm-cross-file', 'coding-confirm-regression',
  ]);
  const names = [...representativeDevelopment, ...representativeConfirmation].map((task) => task.name);
  assert.equal(new Set(names).size, names.length);
  for (const task of [...representativeDevelopment, ...representativeConfirmation]) {
    assert.match(taskDefinitionSha256(task), /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(task.prompt, /print (?:all|the entire)|use (?:bash|read|map)|verbose/iu);
  }
});
test('tracked preregistration freezes the task hashes and split before dispatch', () => {
  const plan = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'experiments', 'offload-representative-v1-preregistration.json'), 'utf8')) as {
    tasks: { development: Array<{ name: string; definitionSha256: string }>; confirmation: Array<{ name: string; definitionSha256: string }> };
    acceptance: { repeats: number; maxQualityLoss: number; minRelativeCostSaving: number };
    execution: { maximumTrials: number };
  };
  assert.deepEqual(plan.tasks.development, representativeDevelopment.map((task) => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) })));
  assert.deepEqual(plan.tasks.confirmation, representativeConfirmation.map((task) => ({ name: task.name, definitionSha256: taskDefinitionSha256(task) })));
  assert.deepEqual(plan.acceptance, {
    repeats: 5, maxQualityLoss: 0.05, minRelativeCostSaving: 0.05,
    candidateCostPerVerifiedSolveMustBeLower: true,
    confirmationBounds: 'two one-sided Hoeffding bounds at alpha 0.025 each',
  });
  assert.equal(plan.execution.maximumTrials, 63);
});
