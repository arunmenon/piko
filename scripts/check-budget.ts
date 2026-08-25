/**
 * Fixed-context budget gate, ratcheted: system prompt + tool schemas must stay
 * under BUDGET_TOKENS (hard ceiling) AND must not grow past the committed
 * baseline (scripts/budget-baseline.json). Growth is a deliberate act: update
 * the baseline in the same commit with measured-benefit evidence in the commit
 * message (token-rent rule, ADR 0017). Shrinking auto-lowers the baseline hint.
 * Run via `npm run check-budget`; exits 1 when over ceiling or above baseline.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../packages/ai/src/tokens.js';
import { buildSystemPrompt } from '../packages/core/src/prompt.js';
import { defaultTools } from '../packages/core/src/tools/index.js';

const BUDGET_TOKENS = 1000;
const baselinePath = join(dirname(fileURLToPath(import.meta.url)), 'budget-baseline.json');

const systemPrompt = buildSystemPrompt({ cwd: '/home/user/project', date: '2026-01-01' });
const toolSchemas = JSON.stringify(
  defaultTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
);

const promptTokens = estimateTokens(systemPrompt);
const toolTokens = estimateTokens(toolSchemas);
const total = promptTokens + toolTokens;

const baseline = (JSON.parse(readFileSync(baselinePath, 'utf8')) as { totalTokens: number }).totalTokens;

console.log(`system prompt: ~${promptTokens} tokens (${systemPrompt.length} chars)`);
console.log(`tool schemas:  ~${toolTokens} tokens (${toolSchemas.length} chars)`);
console.log(`total fixed:   ~${total} / ${BUDGET_TOKENS} tokens (baseline ${baseline})`);

if (total > BUDGET_TOKENS) {
  console.error(`\nOVER BUDGET by ~${total - BUDGET_TOKENS} tokens — trim the prompt or schemas.`);
  process.exit(1);
}
if (total > baseline) {
  console.error(
    `\nABOVE BASELINE by ~${total - baseline} tokens. Fixed context growth must be deliberate ` +
      `(token-rent rule): update scripts/budget-baseline.json in this commit and cite the ` +
      `measured benefit that pays for it in the commit message.`,
  );
  process.exit(1);
}
if (total < baseline) {
  console.log(`\nwithin budget — ${baseline - total} tokens under baseline; consider lowering it to ${total}`);
} else {
  console.log('\nwithin budget');
}
