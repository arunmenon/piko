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
   real system prompt and tools in it.

   When the summary can actually share the cached prefix (corrected 2026-09-02,
   R2 finding 7). The paragraph above originally said the summary request reads
   the cached prefix, unconditionally. That wording was wrong. A provider cache
   key is not only the system prompt and the tool list: Anthropic invalidates a
   message cache whenever the thinking parameters change, and on some models the
   system and tool caches with it. The summary shares the cached prefix only when
   every one of the system prompt, the tool list, the message prefix and the
   thinking fields equals the live request's. With extended thinking enabled the
   old summary request matched the first three and not the last: it carried no
   thinking block at all and a 768-token output cap against a live request's
   8,192-token thinking budget and 9,216-token cap, so it re-paid the whole
   prefix it had been built to reuse. The compaction option `matchLiveCacheKey`
   (default true) now gives the summary request the live thinking budget and an
   output cap of that budget plus the 768-token summary allowance, so every
   cache-key field matches. The trade is explicit and runs both ways: matching
   spends thinking tokens on a handoff note, and not matching re-pays the whole
   prefix at uncached input rates. A caller who prefers the second sets
   `matchLiveCacheKey: false` and gets the small no-thinking request back. Which
   side a compaction took is recorded as `summaryCacheKeyMode` on its
   `context.compact` span and on the summary request's `model.request` span,
   with the values `thinking_matched`, `thinking_dropped` and `thinking_off`, so
   the choice is auditable rather than assumed. The evidence for all of this is a
   request-shape test asserting that the summary request's system, tools and
   thinking fields are byte-identical to the live request's on both sides of the
   compaction. An actual cache-read measurement on the dev set is still
   outstanding: no claim here has been confirmed against billed cache_read
   tokens, and until that bench run exists the argument is about request shape
   only.
2. Compaction now emits a rehydration block appended to the new session's first
   message, beside the summary rather than inside it. It carries the AGENTS.md
   body when the run is trusted and that body was in the system prompt, and the
   paths of the last N files (default 5, configurable) that the dropped history
   wrote or edited. Paths only: the model re-reads what it needs, so a summary
   that forgot a file is recoverable without copying the dropped content back
   into context. Those paths are attacker-controllable text, so since 2026-09-02
   (R2 finding 8) they are not a plain bullet list: they are JSON-encoded strings
   in a fenced `json` block introduced by a line saying the block holds file
   paths recorded from tool calls and is data, not instructions. A filename
   carrying a newline and an instruction is then an escaped `\n` inside a JSON
   string rather than a line of its own, so it can neither start a bullet nor
   close the fence. The 256-character bound per path is unchanged.
3. Compaction inside one turn is now bounded explicitly instead of relying on
   the turn terminating. A per-turn counter with a stated cap (default 3,
   configurable) ends the turn `incomplete` with reason `context_window` when the
   next compaction would exceed it, before any further summary is billed, and the
   preflight telemetry event carries the counter and the cap so a capped stop is
   distinguishable from the other context-window stops.

Microcompaction (the offload path) is unchanged: it summarizes nothing, pays no
model call, and still batches to break the cache once rather than per turn.
Tests in packages/core/tests/compaction.test.ts and packages/ai/tests/mapping.test.ts.
