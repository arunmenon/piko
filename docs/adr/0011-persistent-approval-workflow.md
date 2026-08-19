# 0011 — Persistent approve/edit/reject workflow

Status: accepted (2026-08-19; revised after external ADR review, accepted same day)
Depends on: 0006, 0007, 0009, 0010, 0015

## Context

piko has containment and budgets but no approval layer: a gated action either
runs or the whole run is configured not to allow it. Industry per-call prompts
fail in practice (users alias them away), and no major harness offers approvals
that survive process loss. The v0.2 lifecycle journal (0007) already models
tool executions as planned -> started -> completed/failed/skipped/outcome_unknown,
which is precisely the substrate a durable approval needs: an approval is a
planned execution whose start is deferred pending a recorded human decision.
The praxis gate principle applies directly: machine-verifiable steps advance
unattended; judgment calls stop the line and wait.

## Decision

1. Policy: `ToolExecutionPolicy.approval` names gated tools (list of tool names
   or `"*"`, extension tools included by name; default none, preserving current
   behavior). Deliberately a data shape, not a callback, so it survives
   serialization into configs and child runs. Provenance is restricted:
   approval policy comes only from user config and CLI flags — `--trust-project`
   content and extensions can never set, relax, or narrow it (0006's rule that
   project instructions cannot touch tool policy extends to this field).
2. Suspension: a model batch executes in order until the first gated call.
   Every not-yet-executed call in the batch (gated or not) is journaled
   `planned`; gated ones additionally get `tool_approval_requested` (derived
   status: `awaiting_approval`). The agent emits an `approval_required` event
   and ends the turn with the new `TurnStatus` `suspended`. No model request is
   made past that point, so the dangling assistant tool_use never leaves the
   process, and side-effect order is preserved exactly.
3. Decisions are journal rows: `tool_approval_decided` with
   `approved | edited | rejected`, the edited arguments when applicable
   (validated by the existing tool-argument validator), and a reason. Original
   arguments remain in the journal; an edit is visible provenance, and the tool
   result message notes it so the model is not gaslit.
4. Crash windows are closed by stated rules, not new states: a
   `decided(approved)` row with no `started` row means nothing began — resume
   dispatches it; a `started` row with no terminal row follows 0007 and becomes
   `outcome_unknown`. Concurrent deciders are settled by the single-writer
   session lock (0015) plus the journal's throw-on-invalid-transition.
5. Resume continues the suspended run's `RunBudget` accounting — 0009's
   bounded-per-input property survives suspension. Raising a budget at resume
   is allowed only via explicit flags and is itself journaled.
6. Automation contract (0010): exit code 4 = suspended awaiting approval; the
   `--json` stream gains `approval_required` and decision rows under 0010's
   backward-compatibility rules. Parents spawning children (0004) must treat
   child exit 4 as "forward the decision," not failure.
7. Surfaces: the REPL prompts inline (approve/edit/reject) without suspending
   the process; headless/JSON runs exit 4, and decisions are applied by a
   resume invocation with per-execution flags.

## Consequences

- Approvals survive crashes, reboots, and days of latency by construction —
  the journal is the state, no new persistence layer.
- Zero cost when unconfigured; no fixed-context change (loop-side, per 0005).
- Costs: a fifth TurnStatus and exit code for every consumer to handle; resume
  logic gains a branch that must be fault-tested against the crash-repair path;
  the journal schema grows two row types, forcing the journal-versioning
  decision the maturity notes already flag.
- Explicitly not solved here (named non-goals, revisit on demand):
  argument-pattern gating (approve `git push` but not `ls`) — gating is per
  tool name only; session-scoped "always allow" grants — their absence recreates
  prompt fatigue for chatty tools and is accepted v1 friction; workspace drift
  between planning and a late approval (TOCTOU) — `edit` fails safe by
  construction via its old-text match, `bash` does not, and planning-time
  content hashes are noted as the future mitigation; approval UI beyond the
  terminal; multi-approver policy; OS-level enforcement (a rejected call is not
  a sandbox — 0006's boundaries still apply).
