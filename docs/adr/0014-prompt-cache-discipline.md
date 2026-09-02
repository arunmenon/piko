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

## Addendum (2026-09-02, cache measurement)

R2-9 of docs/red-team-remediation-plan-2026-09.md. The decision above is
unchanged. The red-team review's finding was narrower than "no hit rate
anywhere": `pi --audit`, `/tokens`, and `--usage` already carry a hit
rate. What was missing was everything upstream of the hit rate, so a low
number could not be explained. Four measurements close that.

1. Cache eligibility at startup. One stderr line per process states this
   run's fixed prefix size against the provider's minimum cacheable size,
   and says plainly whether the prefix can cache at all. It measures the
   real prefix, project instructions and extensions included, not the
   default one the budget gate measures. It goes to stderr so the typed
   stdout stream of 0010 is untouched.
2. Model switches. `/model` in the REPL now warns that the prompt cache
   key includes the model and profile, so the next request re-pays the
   full prefix and this session's cached history. It warns only when the
   key actually changes; re-selecting the running model is silent.
3. Bench hit rate. bench/compare_runs.py gains a hit% column per side,
   cache_read divided by the whole input side (uncached plus cache read
   plus cache write), from fields it already parsed. It is blank, not
   zero, for a source that reports no split, which is every Terminus
   baseline run; a reported zero prints as 0%.
4. TTL selection. `profiles.<name>.cacheTtl` accepts the two values
   Anthropic documents, 5m and 1h, validated at config parse and again at
   profile resolution. Anthropic maps it onto every cache_control
   breakpoint; OpenAI exposes no cache-lifetime control and ignores it.
   Omitted leaves the request body byte-identical to the pre-option
   shape, so adding the option cannot move an existing cache key. The
   1-hour TTL doubles the write price, so it pays only when requests
   sharing a prefix are more than five minutes and less than an hour
   apart; piko does not choose that for the user.

Provider minimums are provider policy and change: Anthropic publishes a
per-model minimum that has ranged from 512 to 4,096 tokens, and OpenAI
publishes 1,024. piko carries 1,024 for the general Anthropic case,
2,048 for the Haiku class, and 1,024 for OpenAI as named constants in
packages/ai/src/cache.ts, with both documentation URLs in that file's
header comment. They are configuration of someone else's policy, not a
piko invariant, and a reader who needs the current number should follow
the links rather than trust the constant.

What none of this changes: at ~815 tokens the default prefix is below
every one of those minimums, so the fixed prefix still does not cache.
The mechanism that saves money remains the per-turn working set, and the
new lines make that visible at startup instead of leaving it to 0001.
