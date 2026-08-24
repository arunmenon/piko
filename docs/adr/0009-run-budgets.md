# 0009 — Hard run budgets enforced in the loop

Status: accepted (2026-08-19, implemented in the v0.2 tranche; backfilled same day)
Amended-by: 0020

## Context

`--max-turns` capped model requests only: one assistant response could still
execute an unbounded batch of tool calls, and nothing bounded wall time,
tokens, or spend. Doom-loop budget blowups are the most-reported failure
across all major harnesses, and a fleet multiplies any per-run excess by N.

## Decision

Every run enforces a `RunBudget` with defaults: model requests, tool calls
(checked before dispatch, including inside a single batch), wall time (a timer
that aborts the run), provider-reported input/output/total tokens, and
per-tool retained output bytes. Exceeding any budget ends the turn with
status `budget_exceeded` and a specific stop reason (`tool_calls`,
`wall_time`, `total_tokens`, ...) rather than a generic failure, and the CLI
maps it to a distinct exit code. Budgets are hard ceilings owned by the
harness; the model is never asked to respect them, it is stopped by them.

## Consequences

- Blast radius per input is bounded by construction — the property fleet
  orchestrators and unattended (drive-style) use require.
- Typed stop reasons make budget exits scriptable and auditable.
- Costs: legitimate long tasks must raise budgets explicitly; budget checks
  thread through the loop and every new execution path must respect them.
  Monetary cost is bounded only via token proxies until per-model pricing is
  wired into enforcement.
