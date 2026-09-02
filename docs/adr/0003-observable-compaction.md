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
