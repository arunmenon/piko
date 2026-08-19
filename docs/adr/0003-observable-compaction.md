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
