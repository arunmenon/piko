import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAX_AGENTS_MD_BYTES,
  MAX_SKILL_INDEX_ENTRIES,
  buildSystemPrompt,
  discoverSkills,
  loadAgentsMd,
} from '../src/prompt.js';

test('AGENTS.md is byte bounded and explicitly delimited', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-prompt-'));
  writeFileSync(join(cwd, 'AGENTS.md'), 'A'.repeat(MAX_AGENTS_MD_BYTES * 2));
  const agentsMd = loadAgentsMd(cwd);
  assert.ok(agentsMd?.truncated);
  assert.ok((agentsMd?.content.length ?? Infinity) <= MAX_AGENTS_MD_BYTES);
  const prompt = buildSystemPrompt({ cwd, agentsMd, date: '2026-01-01' });
  assert.match(prompt, /<project-instructions>/);
  assert.match(prompt, /truncated at the harness byte limit/);
});

test('skill index bounds both file reads and entry count', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-skills-'));
  const skillsDir = join(cwd, '.agent', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (let index = 0; index < MAX_SKILL_INDEX_ENTRIES + 10; index++) {
    writeFileSync(join(skillsDir, `${String(index).padStart(3, '0')}.md`), `# skill ${index}${'x'.repeat(10_000)}`);
  }
  const skills = discoverSkills(cwd);
  assert.equal(skills.length, MAX_SKILL_INDEX_ENTRIES);
  assert.ok(skills.every((skill) => skill.summary.length < 2_000));
});

test('project instructions and skills cannot read host files through symlinks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-prompt-links-'));
  const outside = join(mkdtempSync(join(tmpdir(), 'pi-prompt-secret-')), 'secret.md');
  writeFileSync(outside, 'DO NOT SEND THIS');
  symlinkSync(outside, join(cwd, 'AGENTS.md'));
  assert.throws(() => loadAgentsMd(cwd), /regular file inside the project workspace/);

  const skillsDir = join(cwd, '.agent', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  symlinkSync(outside, join(skillsDir, 'stolen.md'));
  assert.deepEqual(discoverSkills(cwd), []);
});
