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

## Addendum (2026-09-02, idempotency preconditions)

The last consequence above is the honest one and it is also the gap: the
journal tells a resumer that a side effect may have happened, and then leaves
it with no way to find out. `outcome_unknown` is only useful if something can
be checked against it. This addendum adds the per-tool preconditions that make
the state actionable, and the conformance test that keeps replay faithful.

- Write gains an optional `expected_sha256` precondition (built alongside this
  under R2-12; edit already carries an equivalent through its match text). A
  write that states the digest it expects to overwrite refuses when the file on
  disk no longer matches, so a resumer can safely reissue a write whose outcome
  is unknown instead of guessing whether the earlier one landed.
- Bash cannot have a precondition of that shape, because its effects are
  arbitrary. It gets evidence instead: the `tool_planned` row for a bash call
  carries an optional `workspaceDigest`, the planning-time fingerprint of the
  workspace the call was planned against. When the workspace is a git checkout
  the digest is SHA-256 over `git rev-parse HEAD` and `git status --porcelain=v1 -z`.
  A resumer facing an `outcome_unknown` bash call recomputes it: an equal digest
  says the workspace did not move, and an unequal one says something changed and
  a human should look before the command is repeated.
- The digest is best-effort by construction, under a total 2 second budget. It
  is omitted, never fabricated and never fatal, when git is absent, slow, or the
  directory is not a checkout. An absent digest therefore means "unknown", not
  "unchanged", and no caller may read it the other way. An unborn branch is
  still a checkout: HEAD contributes nothing and the porcelain status carries
  the whole state.
- Both fields are additive optional fields on existing row shapes, so
  `JOURNAL_SCHEMA_VERSION` does not move.
- A replay conformance test covers the corpus these guarantees depend on:
  journals built from real `Session` calls holding an `outcome_unknown` bash
  call with a digest, a compaction lineage, an approval suspension, and a
  repaired tail (0015). Parsing each and re-appending its rows must reproduce
  identical validated lifecycle state, and `validateLifecycle` must reject a
  corpus whose `executionId` was duplicated, so a replay cannot silently double
  a side effect. This is the example-based half; the property-based corpus
  lands in tranche 3 (G11).

Consequence: a resumer can distinguish "safe to redo" from "go check first"
with evidence rather than with policy. The journal still does not deduplicate,
and the digest is a diagnostic aid rather than a lock: a workspace can move and
move back, and git says nothing about effects outside the checkout.
