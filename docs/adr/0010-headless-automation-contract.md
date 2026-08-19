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
