# 0010 — Fail-closed headless and JSON automation contract

Status: accepted (2026-08-19, implemented across the initial build and the v0.2 tranche; backfilled same day)

## Context

Headless `pi -p` is piko's composition primitive: sub-agent spawns, CI, bench
harnesses, and meta-harness backends all consume it programmatically. Early
versions could exit 0 with an incomplete answer, and progress/answer streams
were the only machine interface. An automation surface that fails open is
worse than none.

## Decision

The headless contract is versioned and fail-closed:

- stdout carries only the final reply (or, with `--json`, a versioned JSONL
  event stream with typed rows such as `usage_summary` v1); all progress and
  diagnostics go to stderr.
- Exit codes are semantic and default to failure: 0 only for a verified
  completed turn, 2 for budget_exceeded, 3 for incomplete/unknown terminal
  states, 130 for user cancellation, 1 for errors — the initial value is
  failure, and success must be proven by a terminal status.
- The `--json` stream is the stable automation surface; its schema carries a
  version field and additions are backward compatible. Human-readable output
  makes no stability promise.

## Consequences

- A parent process can trust exit codes and parse events without scraping
  prose; the bench/eval tooling consumes the same typed rows it ships.
- Fail-closed semantics surface real problems in CI instead of laundering
  them into green runs.
- Costs: exit-code and event-schema changes are now breaking changes requiring
  versioning discipline; a richer bidirectional RPC surface remains future
  work (roadmap v0.3) and must not fork this contract.

## Amendment (2026-08-25, exit code 5 and typed lock-contention error)

0024 adds one exit code to the headless contract: 5 means the newest
resumable session is locked and nothing was resumed or created. It is a
deliberate, versioned extension of the code set (0 success, 1 error,
4 suspended awaiting approval, 5 locked newest head); scripts that treated
all nonzero as failure keep working, scripts that react to lock contention
can now distinguish it. In --json mode the run_error event carries
code: "locked_session_head" for the same purpose, and pi doctor sessions
emits doctor_session / doctor_recover / doctor_error rows under the same
versioned envelope, keeping argument errors on the typed stdout channel.

## Addendum (2026-09-02, capabilities row)

R2-11 of the red-team remediation plan adds one backward-compatible field to
this contract. The first row a headless `--json` run emits now carries a
`capabilities` object alongside the existing `v`, `sessionId`, and `event`
fields, so an adapter can discover what it is talking to instead of inferring
it from a piko version string:

- `journalSchemaVersion`: the journal schema generation this build writes
  (`JOURNAL_SCHEMA_VERSION`).
- `tools`: the tool names available for this run, after built-ins, host-bash
  gating, and extensions are resolved.
- `exitCodes`: the full exit-code set a caller must interpret, as documented
  above and amended for 0024.
- `budgetScope`: `turn`, the scope every budget ceiling is enforced against
  (ADR 0009 scope note; ADR 0026 proposes session scope).

Only the first row gains the field; every later row is byte-identical to what
it was, and a consumer that ignores unknown fields is unaffected. This is an
additive extension of the versioned schema, so `v` stays 1. It is deliberately
a read-only self-description and not an RPC surface: the bidirectional adapter
work remains future work under R0-6.
