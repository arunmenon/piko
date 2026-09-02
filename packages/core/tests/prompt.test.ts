import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimateTokensForBytes } from '@pi/ai';
import {
  MAX_AGENTS_MD_BYTES,
  MAX_SKILL_INDEX_ENTRIES,
  MAX_SKILL_SUMMARY_BYTES,
  buildSystemPrompt,
  discoverSkills,
  loadAgentsMd,
} from '../src/prompt.js';
import { fixedPrefixSize, toolSchemaJson, worstCaseFirstRequest } from '../src/context-budget.js';
import { defaultTools } from '../src/tools/index.js';
import { DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES } from '../src/tools/validation.js';

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

test('the worst-case first request adds every bounded cap to the default prefix', () => {
  const defaultPrefixTokens = 815;
  const worstCase = worstCaseFirstRequest(defaultPrefixTokens);
  assert.equal(worstCase.defaultPrefixTokens, defaultPrefixTokens);

  const byLabel = new Map(worstCase.boundedInputs.map((input) => [input.label, input]));
  assert.equal(byLabel.get('AGENTS.md cap')?.capBytes, MAX_AGENTS_MD_BYTES);
  assert.equal(byLabel.get('AGENTS.md cap')?.capTokens, estimateTokensForBytes(MAX_AGENTS_MD_BYTES));
  assert.equal(byLabel.get('skill index cap')?.capBytes, MAX_SKILL_INDEX_ENTRIES * MAX_SKILL_SUMMARY_BYTES);
  assert.equal(byLabel.get('extension schema ceiling')?.capBytes, DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES);

  // The reported total is exactly the sum: nothing invented, nothing dropped.
  const sumOfCaps = worstCase.boundedInputs.reduce((sum, input) => sum + input.capTokens, 0);
  assert.equal(worstCase.totalTokens, defaultPrefixTokens + sumOfCaps);
  assert.equal(worstCase.totalTokens, 815 + 8192 + 12_800 + 2048);

  // An input with no constant cap is reported as unbounded, never given a number.
  assert.equal(worstCase.unboundedInputs.length, 1);
  assert.match(worstCase.unboundedInputs[0]!.label, /skill index entry names and paths/);
  assert.throws(() => worstCaseFirstRequest(-1), /nonnegative safe integer/);
});

test('fixedPrefixSize measures the tool schemas plus the system prompt', () => {
  const systemPrompt = buildSystemPrompt({ cwd: '/home/user/project', date: '2026-01-01' });
  const tools = defaultTools();
  const size = fixedPrefixSize(systemPrompt, tools);
  assert.equal(size.systemPromptChars, systemPrompt.length);
  assert.equal(size.toolSchemaChars, toolSchemaJson(tools).length);
  assert.equal(size.totalTokens, size.systemPromptTokens + size.toolSchemaTokens);
  // Number one of the two-number gate is exactly this measurement.
  assert.ok(size.totalTokens > 0 && size.totalTokens < 1000);
});
