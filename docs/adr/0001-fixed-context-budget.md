# 0001 — Fixed-context budget, CI-enforced

Status: accepted (2026-08-12, backfilled 2026-08-19)

## Context

Harness fixed overhead ranges from ~2.8k tokens (upstream pi, measured end-to-end)
to ~28k (Claude Code). Overhead is paid on every request, compounds across turns
and sub-agents, and a controlled factorial (arXiv 2605.23950) shows harness design
dominates model choice. Prompt bloat also regresses silently: Claude Code's prompt
grew ~70k tokens in five days (issue #45188) without anyone deciding that.

## Decision

The default system prompt plus built-in tool schemas must stay under 1,000 estimated
tokens, enforced by `scripts/check-budget.ts` as a build gate. Growth is a reviewed,
deliberate act: any change crossing the gate must either shrink something else or
raise the budget in the same commit with justification.

## Consequences

- Every added tool or prompt line has a visible price; the map tool's ~107 tokens
  were an explicit purchase.
- The budget covers the default prefix only; project instructions, skills indexes,
  and extension schemas are additional and bounded separately (byte ceilings).
- Known trade-off: a sub-1,024-token prefix is below some providers' minimum
  cacheable size, so the fixed prefix itself may never cache (the caching
  inversion). The mechanism that saves money is per-turn working set; the budget
  is discipline and proof-of-philosophy, not the headline economic claim.


## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Stop Comparing LLM Agents Without Disclosing the Harness",
  Zhang et al., arXiv 2605.23950, 2026. A factorial of 3 models by 3 harnesses
  by 2 seeds over 100 SWE-bench Verified tasks measures harness-induced variance
  at 7.8 times model-induced, with six ranking reversals in nine comparisons.
  This is the paper the record already cites.
- challenges: "Terminal-Bench", Merrill et al., arXiv 2601.11868, 2026. With a
  neutral scaffold, model choice matters more than agent choice. The
  harness-first claim should be cited alongside this counterweight rather than
  alone.
- corroborates: "Instruction Stacking Collapse", Anand & Chattaraj,
  arXiv 2608.02639, 2026. Compliance falls from about 96% to as low as 20% as
  stacked instructions approach 20, which is the mechanism a bounded fixed
  prefix protects against, and which nothing yet bounds for trusted-project
  instructions.
- corroborates: "Prompt Design at Scale", Eliav, arXiv 2607.19257, 2026.
  Adherence collapses by roughly 80 rules; the same argument counted in rules
  rather than tokens.
- corroborates: "Tool Attention Is All You Need", Sadani & Kumar,
  arXiv 2604.21816, 2026. The per-turn tools tax measures 10k to 60k tokens in
  multi-server MCP deployments, quantifying the overhead this budget refuses.
- corroborates: "Lost in the Middle", Liu et al., TACL 2024. Position effects
  degrade retrieval from long contexts, the canonical result behind keeping the
  resident prefix small.

## Proposed amendment (2026-09-02, token rent; re-homed from 0017 — awaiting owner ratification)

1. Every line of the system prompt and every tool schema byte must keep
   paying measurable rent against the fitness function (dollars per
   completed task, 0017). An addition ships only with the benchmark
   evidence that justified it, cited in the commit that raises
   scripts/budget-baseline.json; the ratcheted CI gate fails on any
   unexplained numeric growth.
2. At each benchmark grid, existing additions are re-audited; an addition
   whose measured benefit cannot be distinguished from noise is reverted
   and its tokens returned to the baseline.
3. Evidence at drafting: the investigate-first guidance line pays rent
   (create-bucket 0-for-history to 3/3); the tool-batching line failed a
   three-grid audit ($0.202 to $0.188 to $0.227 per failure) and was
   reverted 2026-08-25, returning the baseline to 815.
