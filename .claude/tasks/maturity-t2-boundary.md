# Maturity plan T2: the boundary (opened 2026-09-02)

Source: docs/maturity-plan-2026-09.md section 5 as amended, plus
docs/red-team-remediation-plan-2026-09.md section 7. Gated decisions
recorded 2026-09-02 by owner delegation (0018, 0022 mechanism, 0026, 0027).

- [ ] 5a. Sandbox executor (0018): acquire/exec/release seam; sandboxed tool worker with all five tools inside; bwrap plus seccomp provider on Linux, Seatbelt provider on macOS; fail closed; control plane outside; workspace only; networking none; sessions outside the mount
- [ ] 5a-ii. 0022 through the executor: the eight containment attacks pass on Linux and macOS in CI via the executor; in-process path documented as not race-proof
- [ ] 5b. Aggregate budgets (0026): root-budget authority, atomic reserve and reconcile, session-scoped ceilings across REPL turns, child-tree exposure, unknown-request exposure, active versus elapsed time, budget reminders to the model, lock measured at twenty children
- [x] 5c. Cooperative shutdown (0027): stop admission, drain marker, grace period, exit 143 in headless and REPL; forced path leaves outcome_unknown; optional supervisor for the blocking-extension case
- [ ] 5d. Argument-aware approvals (0011): prefix rules with inline tests evaluated at dispatch on the shell-split command; session-scoped allow grants as journal rows
- [ ] 5e. Scoped threat model committed under docs/; README stops saying there is no OS sandbox; CHANGELOG
- [ ] 5f. Re-issue the review prompt against the T2 tree; report committed
