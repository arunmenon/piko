# 0011 — Persistent approve/edit/reject workflow

Status: proposed (2026-08-19)

## Context

piko has containment and budgets but no approval layer: a gated action either
runs or the whole run is configured not to allow it. Industry per-call prompts
fail in practice (users alias them away), and no major harness offers approvals
that survive process loss. The v0.2 lifecycle journal already models tool
executions as planned -> started -> completed/failed/skipped/outcome_unknown,
which is precisely the substrate a durable approval needs: an approval is a
planned execution whose start is deferred pending a recorded human decision.
The praxis gate principle applies directly: machine-verifiable steps advance
unattended; judgment calls stop the line and wait.

## Decision

1. Policy: `ToolExecutionPolicy.approval` names gated tools (list of tool names
   or `"*"`; default none, preserving current behavior). Deliberately a data
   shape, not a callback, so it survives serialization into configs and child
   runs.
2. Suspension: when a turn reaches gated calls, the agent journals
   `tool_approval_requested` for each (derived status: `awaiting_approval`),
   emits an `approval_required` event, and ends the turn with the new
   `TurnStatus` `suspended`. No model request is made past that point, so the
   dangling assistant tool_use in the transcript is never sent anywhere.
3. Decisions are journal rows: `tool_approval_decided` with
   `approved | edited | rejected`, the edited arguments when applicable
   (validated by the existing tool-argument validator), and a reason. Original
   arguments remain in the journal; an edit is visible provenance, and the tool
   result message notes it so the model is not gaslit.
4. Resume: opening a session with pending approvals routes to the decision flow
   instead of `synthesizeInterruptedResults` (which would falsely claim the
   calls never ran — they were never started, and the journal proves it).
   Approved calls execute; rejected calls synthesize an error result carrying
   the human reason; the loop then continues normally.
5. Surfaces: the REPL prompts inline (approve/edit/reject) without suspending
   the process; headless/JSON runs exit with a typed `suspended` state, and
   decisions are applied by a resume invocation with per-execution flags.

## Consequences

- Approvals survive crashes, reboots, and days of latency by construction —
  the journal is the state, no new persistence layer.
- Zero cost when unconfigured; no fixed-context change (loop-side, per ADR 0005).
- Costs: a new TurnStatus for every consumer of turn_done to handle; resume
  logic gains a branch that must be fault-tested against the crash-repair path;
  headless callers must handle exit-state `suspended`.
- Explicitly not solved here: approval UI beyond the terminal, multi-approver
  policy, and OS-level enforcement (a rejected bash call is not a sandbox —
  ADR 0006's boundaries still apply).
