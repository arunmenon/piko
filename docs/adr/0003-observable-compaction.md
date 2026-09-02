# 0003 — Observable compaction into new session files

Status: accepted (2026-08-13; microcompaction added 2026-08-18; backfilled 2026-08-19)

## Context

Users of major harnesses distrust compaction: it fires unpredictably, destroys
task-critical context mid-task, cannot be disabled or reviewed, and the
pre-compaction history is gone. Separately, most per-turn cost is stale tool
output riding along in history.

## Decision

Two mechanisms, both visible and reversible:

1. Summarizing compaction writes the compacted state to a NEW session file with
   lineage metadata; the full pre-compaction transcript remains on disk untouched.
   Triggered by real provider-reported usage against the model's window, announced
   in the UI, disableable (`--no-auto-compact`), and invocable manually (/compact).
2. Microcompaction offloads old bulky tool results to disk files, replacing them
   with a path stub the model can re-read. Nothing is summarized away and no model
   call is paid; batched to limit prompt-cache invalidation.

## Consequences

- Nothing about the model's context is ever unrecoverable or invisible.
- Cost: extra session files and offload artifacts on disk; lineage tracking needed
  so audits can follow a task across files.
- The preflight gap (deciding from the last request's size, not the next one)
  was identified in the Aug 2026 audit and is addressed by the v0.2 preflight work.
  (2026-08-19: that work has landed — next-request preflight estimation shipped
  in the v0.2 tranche; this consequence is closed.)

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "The Complexity Trap", Lindenbauer et al., DL4C at NeurIPS 2025,
  arXiv 2508.21433, 2025. Observation tokens are about 84% of an average
  SWE-agent turn, and replacing observations older than the last 10 turns with
  placeholders halves cost while matching or beating LLM summarization on
  SWE-bench Verified. That is this record's disk-stub offload, measured.
- corroborates: "ACON", Kang et al., ICML 2026, arXiv 2510.00615.
  Goal-conditioned pruning cuts 23 to 54% of tokens with improved success.
- corroborates: "SWE-Pruner", Wang et al., arXiv 2601.16746, 2026. The same
  result class for code agents specifically.
- challenges: "Governance Decay", Chen, arXiv 2606.22528, 2026. Across 1,323
  scenarios, policy violations rise from 0% to 30% and as high as 59% once
  compaction drops constraints. Piko pins tool policy outside the summary
  (0006) but not task constraints, so the lossy summary can still erase a
  constraint the run depends on.
- challenges: "Toward Reliable Context Compression", Min et al.,
  arXiv 2608.06503, 2026. Compression weakens the influence of recent
  interactions and increases repeated exploration, a cost this record does not
  price.

## Addendum (2026-09-02, cached-prefix summarizer, rehydration, compaction cap)

Red-team finding R2-10 (docs/red-team-remediation-plan-2026-09.md section 6 item
10). Three gaps in the accepted design, closed without changing what compaction
is or where it writes.

1. The summarizer paid full price for a prefix it could have read from cache.
   It was a separate request with its own system prompt and an empty tool list,
   so its prefix matched nothing the session had already cached and the dropped
   history was re-billed uncached. The summary request now reuses the main system
   prompt and the main tool list verbatim, with the summarization instruction as
   the final user message. Tool use is disabled for that one request rather than
   the tools being dropped, since dropping them would change the prefix: a
   `toolChoice: 'none'` field on CompletionRequest maps to Anthropic
   `tool_choice: {type: 'none'}` and OpenAI `tool_choice: 'none'`, and is omitted
   when the tool list is empty because an empty list already forbids tool use.
   The bounded-envelope path is unchanged: if the dropped prefix plus the
   instruction would still overflow, the transcript is serialized and its middle
   truncated against the same binary-searched envelope, now measured with the
   real system prompt and tools in it. The evidence here is a request-shape test
   asserting that the summary request's system and tools are byte-identical to
   the live request's on both sides of the compaction, not a live cache
   measurement; the cache-read comparison on the dev set is a separate bench run.
2. Compaction now emits a rehydration block appended to the new session's first
   message, beside the summary rather than inside it. It carries the AGENTS.md
   body when the run is trusted and that body was in the system prompt, and the
   paths of the last N files (default 5, configurable) that the dropped history
   wrote or edited, as a plain list of stubs. Paths only: the model re-reads what
   it needs, so a summary that forgot a file is recoverable without copying the
   dropped content back into context.
3. Compaction inside one turn is now bounded explicitly instead of relying on
   the turn terminating. A per-turn counter with a stated cap (default 3,
   configurable) ends the turn `incomplete` with reason `context_window` when the
   next compaction would exceed it, before any further summary is billed, and the
   preflight telemetry event carries the counter and the cap so a capped stop is
   distinguishable from the other context-window stops.

Microcompaction (the offload path) is unchanged: it summarizes nothing, pays no
model call, and still batches to break the cache once rather than per turn.
Tests in packages/core/tests/compaction.test.ts and packages/ai/tests/mapping.test.ts.
