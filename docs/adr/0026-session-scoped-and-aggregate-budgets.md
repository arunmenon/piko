# 0026 - Session-scoped and aggregate budget authority

Status: proposed (2026-09-02; drafted from maturity plan T2 5b under owner amendment 5, ratification pending)
Amends: 0009, 0020

## Context

Every `RunBudget` ceiling is enforced per user turn. In headless `-p` a
turn is the run, so the contract holds; in the REPL a `--max-spend-usd`
cap silently resets each turn, and a session can spend any multiple of
it. Contained delegation (0004 addendum, 0018) will add children that run
concurrently; reconstructing each child's journal after the fact cannot
bound concurrent spend. The competitive matrix and README both implied
"every mode" until the 2026-09-02 scope notes corrected them.

## Decision (proposed)

- One root-budget authority per session tree. Reserve and reconcile are
  atomic under a single root-budget lock; a child cannot dispatch until
  its reservation is admitted against the root's remaining budget.
- Branch semantics: a branch inherits the remaining root budget by
  reference, not by copy. Child-tree semantics: a child's exposure is
  charged to every ancestor up to the root.
- Unknown-request exposure: a dispatched request with no durable terminal
  acknowledgement keeps its full reservation on every ancestor until
  reconciled, exactly as the per-turn ledger does today (0007, 0020).
- Time ceilings are defined explicitly. `maxActiveTime` counts model plus
  tool wall time attributable to the tree, summed across parallel
  children. `maxElapsedTime` counts wall-clock from session start.
  Either, both, or neither may be set; "maxTime" alone is not a valid
  name in this record.
- Session-scoped `maxSpendUSD`, `maxTokens`, and the time ceilings are
  enforced alongside, not instead of, the per-turn ceilings of 0009/0020.
- Reservation bounds may use a tokenizer count only where a committed
  corpus proves it conservative against the provider's actual count;
  otherwise the byte-derived bound of 0020 stays.
- At every spend stop the harness prints reserved versus actual and the
  effective ceiling; `--usage` reports the effective ceiling.

## Acceptance regression

A REPL test that two turns cannot exceed the session cap; a concurrent-
children test that the sum of admitted reservations never exceeds the
root; an unknown-outcome child test that exposure persists until
reconciled; a test that the printed reserved/actual/effective numbers
explain a ceiling stop without reading the journal.

## Consequences

- Retires the largest semantic overclaim on the matrix; "every mode"
  becomes true.
- Adds a lock on the dispatch path of every child; acceptable because
  reservation is already a serialized step.
- Requires 0018's parent-controlled children to route admission through
  the parent, which is the intended design.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it. No paper
studies tree-scoped reservation; a DeepSeek community plugin is the only
implementation the review found.

- corroborates: "BAGEN: Are LLM Agents Budget-Aware?", Lin et al.,
  arXiv 2606.00198, 2026. Agents do not self-limit, so spend authority has to
  sit above them, which is what a root budget authority provides.
- corroborates: "Single-Agent LLMs Outperform Multi-Agent Systems", Tran &
  Kiela, arXiv 2604.02460, 2026. Multi-agent advantages vanish under matched
  token budgets, a comparison that is only checkable once the budget is enforced
  across the tree.
- corroborates: "Why Do Multi-Agent LLM Systems Fail?" (MAST), Cemri et al.,
  arXiv 2503.13657, 2025. Failure is attributed largely to system design rather
  than to individual agents, an argument for the parent owning admission.
