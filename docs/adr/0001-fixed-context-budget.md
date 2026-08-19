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
