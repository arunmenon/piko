# 0007 — Write-ahead lifecycle journal with unknown-outcome semantics

Status: accepted (2026-08-19, implemented in the v0.2 tranche; backfilled same day)

## Context

The original session log recorded conversation messages only. A crash between
dispatching a side-effecting tool (git push, deploy) and recording its result
left the transcript claiming the call was pending; the resume repair then told
the model it "never ran" — a false assertion that invites repeating a
destructive action. Chat persistence is not durable execution.

## Decision

Sessions carry a write-ahead lifecycle journal alongside messages. Tool
executions are journaled `planned` before dispatch, `started` before the
side effect, then `completed | failed | skipped`. A resume that finds a
`started` entry with no terminal row marks it `outcome_unknown` with a reason —
never "didn't happen." Model requests and compactions get the same treatment
(`model_request_outcome_unknown`, compaction started/completed rows), plus an
explicit run-status row. Invalid state transitions throw before anything is
appended, and every model-visible input must be reconstructable from the log.

## Consequences

- Crash recovery can distinguish "safe to redo" from "go check first," and the
  distinction is enforced by data, not convention.
- The journal became the substrate for later features (durable approvals are
  a `planned` entry awaiting a decision row).
- Costs: a schema to version, more rows per turn, and consumers must handle
  `outcome_unknown` as a first-class state. True idempotency still requires
  tool-specific keys; the journal records honestly, it does not deduplicate.
