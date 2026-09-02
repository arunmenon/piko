# 0014 — Prompt-cache discipline

Status: accepted (2026-08-19, backfilled same day; practices date to the initial build)

## Context

Cache reads bill at ~10% of list price and production harnesses live or die by
hit rate (measured 90-97% for the leaders; a documented field case cut a bill
59% by prompt reordering alone). Cache behavior is a harness property: byte-
unstable prefixes and history rewrites silently destroy it. 0001 already
concedes that the per-turn working set, not prefix size, is the headline
economic mechanism — this ADR owns that mechanism.

## Decision

- Stable prefix ordering (tools -> system -> messages); the fixed prefix is
  byte-stable across turns within a session.
- Normal turns are append-only: earlier messages are never mutated, so the
  incremental Anthropic breakpoints (system block + last message block) extend
  the cached prefix each turn.
- History rewrites are confined to two visible, batched operations:
  microcompaction offloads (0003) run only in worthwhile batches so the cache
  breaks once, not per turn; full compaction starts a new lineage-linked
  session, deliberately trading one cold start for a small working set.
- The caching inversion is acknowledged, not hidden: a sub-1,024-token prefix
  is below some providers' minimum cacheable size and may never cache. piko
  optimizes cost-per-completed-task, and surfaces hit rate in /tokens, --usage,
  and --audit so the trade-off is measurable per session.

## Consequences

- Long sessions get near-optimal incremental caching without any resident
  machinery; the economics claims are observable by users, not asserted.
- Costs: append-only discipline constrains future features (anything that
  edits history must batch or fork), and first turns/short sessions/fleet
  fan-outs pay uncached rates — the regime where the small prefix wins anyway.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Don't Break the Cache", Lumer et al., arXiv 2601.06007, 2026.
  Across more than 500 agent sessions on three providers, caching cuts API cost
  41 to 80% and time-to-first-token 13 to 31%, and the consistent wins come from
  dynamic content last, stable tool definitions, and dynamic tool results
  excluded; this record's ordering rules, measured.
- corroborates: "Learning Agent Execution for KV-Cache Management", Zhang et al.,
  arXiv 2608.14624, 2026. Agent workloads repeatedly reuse the system prompt and
  tool definitions, and execution-aware eviction lifts hit rate by 10 to 18
  points.
- corroborates: "Prompt Cache", Gim et al., MLSys 2024, arXiv 2311.04934. The
  serving-side mechanism that makes a stable prefix pay.
- corroborates: "SGLang RadixAttention", Zheng et al., NeurIPS 2024,
  arXiv 2312.07104. Radix-tree prefix sharing as the same property implemented
  in the serving layer.
