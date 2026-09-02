/**
 * Fixed-context budget gate, two numbers (ADR 0001 addendum 2026-09-02).
 *
 * Number one, ratcheted: system prompt + tool schemas must stay under
 * BUDGET_TOKENS (hard ceiling) AND must not grow past the committed baseline
 * (scripts/budget-baseline.json). Growth is a deliberate act: update the
 * baseline in the same commit with measured-benefit evidence in the commit
 * message (token-rent rule, proposed amendment to ADR 0001). Shrinking
 * auto-lowers the baseline hint.
 *
 * Number two, reported only: the bounded worst-case first request, which is the
 * default prefix plus every capped first-request input at its cap. Neither the
 * ratchet nor the hard ceiling applies to it; it exists so the gate stops
 * implying that the default prefix is the whole story.
 *
 * Third section, reported only: whether the default prefix reaches each
 * provider's minimum cacheable size (ADR 0014).
 *
 * Run via `npm run check-budget`; exits 1 when over ceiling or above baseline.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeCacheEligibility, type CacheProviderName } from '../packages/ai/src/cache.js';
import { fixedPrefixSize, worstCaseFirstRequest } from '../packages/core/src/context-budget.js';
import { buildSystemPrompt } from '../packages/core/src/prompt.js';
import { defaultTools } from '../packages/core/src/tools/index.js';

const BUDGET_TOKENS = 1000;
const baselinePath = join(dirname(fileURLToPath(import.meta.url)), 'budget-baseline.json');

/**
 * One probe per provider, plus the Haiku class, whose minimum is higher than the
 * rest of the Anthropic line. The model ids only select a minimum; nothing here
 * contacts a provider.
 */
const CACHE_ELIGIBILITY_PROBES: readonly { provider: CacheProviderName; model: string }[] = [
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  { provider: 'openai', model: 'gpt-5' },
];

const systemPrompt = buildSystemPrompt({ cwd: '/home/user/project', date: '2026-01-01' });
const prefix = fixedPrefixSize(systemPrompt, defaultTools());
const total = prefix.totalTokens;

const baseline = (JSON.parse(readFileSync(baselinePath, 'utf8')) as { totalTokens: number }).totalTokens;

console.log(`system prompt: ~${prefix.systemPromptTokens} tokens (${prefix.systemPromptChars} chars)`);
console.log(`tool schemas:  ~${prefix.toolSchemaTokens} tokens (${prefix.toolSchemaChars} chars)`);
console.log(`total fixed:   ~${total} / ${BUDGET_TOKENS} tokens (baseline ${baseline})`);

const worstCase = worstCaseFirstRequest(total);
console.log('\nworst-case first request (reported, not ratcheted):');
console.log(`  default prefix            ~${worstCase.defaultPrefixTokens} tokens`);
for (const input of worstCase.boundedInputs) {
  const note = input.note ? `\n      note: ${input.note}` : '';
  console.log(`  ${input.label.padEnd(25)} ~${input.capTokens} tokens (${input.capBytes} bytes, ${input.constants})${note}`);
}
console.log(`  worst-case total          ~${worstCase.totalTokens} tokens`);
for (const input of worstCase.unboundedInputs) {
  console.log(`  UNBOUNDED: ${input.label}: ${input.reason}`);
}

console.log('\ncache eligibility of the default prefix (provider minimums; sources in packages/ai/src/cache.ts):');
for (const probe of CACHE_ELIGIBILITY_PROBES) {
  console.log(`  ${describeCacheEligibility({ ...probe, prefixTokens: total })}`);
}

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
