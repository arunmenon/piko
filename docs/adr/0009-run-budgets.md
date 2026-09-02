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


Scope note (2026-09-02): as implemented, every `RunBudget` ceiling is scoped to ONE user turn. In headless `-p` a turn is the run, so the contract holds; in the REPL each ceiling resets per turn and a session may spend any multiple of it. Session-scoped and child-tree aggregate ceilings are proposed in ADR 0026; until it lands, read "run" in this record as "turn".

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "BAGEN: Are LLM Agents Budget-Aware?", Lin et al.,
  arXiv 2606.00198, 2026. Capability and budget-awareness correlate weakly
  (r = 0.35), frontier agents keep spending on failing tasks, and trained early
  stopping saves 28 to 64% of tokens on failing trajectories; the empirical case
  that ceilings must be external to the model, which is this record's thesis.
- corroborates: "More with Less", Gao & Peng, arXiv 2510.16786, 2025. A fixed
  turn limit at the 75th percentile of baseline cuts SWE-bench cost 24 to 68%
  with negligible solve-rate loss.
- corroborates: "Budget-Aware Tool-Use", Liu et al., arXiv 2511.17006, 2025.
  Without budget awareness, larger tool-call budgets do not improve performance.
- corroborates: "Holistic Agent Leaderboard", Kapoor et al., ICLR 2026,
  arXiv 2510.11977. Across 21,730 rollouts, higher reasoning effort reduced
  accuracy in most runs; more spend is not more solves.

## Addendum (2026-09-02, wording)

R2-7 of the red-team remediation plan aligns user-visible text with the scope
note above: every ceiling in this record is enforced per user turn, so the text
a user reads now says turn, not run.

- Validation errors read `invalid turn budget <name>: ...` rather than
  `invalid run budget <name>: ...`.
- The headless terminal line reads `turn <status>: <reason> after N model
  request(s) and M tool call(s)`, so `budget_exceeded` there can no longer be
  misread as a run-scoped budget.
- `--max-*` flag help states the scope once, "every --max-* below is a turn
  budget: per turn (one turn per input in -p)", and the individual flags say
  "per turn".

Identifiers are deliberately untouched: `RunBudget`, `RunBudgetSnapshot`, and
the `run` journal vocabulary keep their names, because renaming a serialized
schema is a separate, breaking act. This addendum changes wording only; no
ceiling, default, or enforcement point moves. Session-scoped ceilings remain
ADR 0026's business.
