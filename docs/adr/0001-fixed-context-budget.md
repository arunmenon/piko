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


## Addendum (2026-09-02, two-number gate and eligibility)

R2-8 of docs/red-team-remediation-plan-2026-09.md. The accepted decision
above is unchanged: one number, the default prefix, is still the only
thing the ratchet and the 1,000-token ceiling apply to. What changes is
what the gate reports next to it, because a gate that measures the
default prefix alone invites the reading that the default prefix is the
whole first request.

`npm run check-budget` now prints three things.

1. The ratcheted default prefix, exactly as before: system prompt plus
   built-in tool schemas, against the hard ceiling and the committed
   baseline in scripts/budget-baseline.json. Unchanged at ~815 tokens;
   the gate still exits non-zero when it grows.
2. A bounded worst-case first request, reported only. It is the default
   prefix plus every first-request input that has a byte cap expressed as
   a constant, each at its cap: MAX_AGENTS_MD_BYTES (32,768 bytes,
   ~8,192 tokens), MAX_SKILL_INDEX_ENTRIES times MAX_SKILL_SUMMARY_BYTES
   (51,200 bytes, ~12,800 tokens), and
   DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES (8,192 bytes, ~2,048 tokens). Today
   that totals ~23,855 tokens. Two things keep it honest as an upper
   bound rather than a forecast: the tool-schema ceiling covers the whole
   tool set, so the built-in schemas already inside number one are
   counted twice, and the byte-to-token conversion assumes one character
   per byte. Neither the ratchet nor the ceiling applies to this number.
3. A cache-eligibility line per provider, computed from the same measured
   prefix (see the 0014 addendum of the same date for the constants and
   their sources). At ~815 tokens the default prefix clears no supported
   provider minimum, which is the caching inversion this ADR already
   concedes, now printed rather than remembered.

Open item, from what number two exposes: the skill index is only
partly bounded. Entry counts and summary bytes have constants; the
per-entry skill name and path bytes have none, and are bounded only by
the filesystem name limit. The gate prints them as UNBOUNDED rather than
inventing a cap. Fifty entries with long names and deep paths is a small
number of tokens in practice and an unbounded one on paper, so closing
it means adding a real constant, not a bigger estimate. Until then the
worst case in number two is a worst case over the bounded inputs only.

The arithmetic lives in packages/core/src/context-budget.ts with unit
tests in packages/core/tests/prompt.test.ts, so it can be checked
without running the gate. Because that module reads the shared token
estimator from @pi/ai, `npm run check-budget` now builds first.
