/**
 * Fixed-context budget gate: system prompt + tool schemas must stay under
 * BUDGET_TOKENS. Run via `npm run check-budget`; exits 1 when over budget.
 * Uses the ~4 chars/token estimate — close enough to police a hard ceiling.
 */
import { estimateTokens } from '../packages/ai/src/tokens.js';
import { buildSystemPrompt } from '../packages/core/src/prompt.js';
import { defaultTools } from '../packages/core/src/tools/index.js';

const BUDGET_TOKENS = 1000;

const systemPrompt = buildSystemPrompt({ cwd: '/home/user/project', date: '2026-01-01' });
const toolSchemas = JSON.stringify(
  defaultTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
);

const promptTokens = estimateTokens(systemPrompt);
const toolTokens = estimateTokens(toolSchemas);
const total = promptTokens + toolTokens;

console.log(`system prompt: ~${promptTokens} tokens (${systemPrompt.length} chars)`);
console.log(`tool schemas:  ~${toolTokens} tokens (${toolSchemas.length} chars)`);
console.log(`total fixed:   ~${total} / ${BUDGET_TOKENS} tokens`);

if (total > BUDGET_TOKENS) {
  console.error(`\nOVER BUDGET by ~${total - BUDGET_TOKENS} tokens — trim the prompt or schemas.`);
  process.exit(1);
}
console.log('\nwithin budget');
