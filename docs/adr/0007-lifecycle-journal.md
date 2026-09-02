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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "ARIES", Mohan et al., ACM TODS 1992, doi 10.1145/128765.128770.
  Log intent before effect and replay history at recovery to decide outcomes;
  the write-ahead shape this record adopts.
- corroborates: "Crash-Only Software", Candea & Fox, HotOS 2003. State must be
  recoverable from durable records because crash is the only stop path.
- corroborates: "Idempotence Is Not a Medical Condition", Helland, ACM Queue
  2012, doi 10.1145/2181796.2187821. Without idempotent operations a lost
  response makes the outcome unknowable, which is this record's "unknown, never
  did not run".
- corroborates: "Hints for Computer System Design", Lampson, SOSP 1983,
  doi 10.1145/800217.806614. Make actions atomic or restartable.
- corroborates: "Atomix", Mohammadi et al., arXiv 2602.14849, 2026. Settlement
  and reversibility classes for agent tool calls reach 57% clean success under
  fault injection against 0 to 7% for baselines; the idempotency layer this
  record names as missing, now published.
