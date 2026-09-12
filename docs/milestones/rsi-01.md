# RSI-01: one evidence-backed offload improvement cycle

Goal: diagnose observed Piko behavior, propose one bounded policy change, compare
it fairly, and produce a reviewable verdict. A rejected or inconclusive candidate
is a valid outcome; an efficiency gain is not a milestone prerequisite.

Implementation scope:

- [x] External controller with a bounded, trace-derived policy proposal.
- [x] Existing offload thresholds exposed as CLI settings.
- [x] Fixed evaluator, separate executable selection, paired repeated trials.
- [x] Development screen followed by frozen-candidate confirmation fixtures.
- [x] Complete-cost requirement, failed-run accounting, pre-dispatch reservations.
- [x] Statistical acceptance rule; inconclusive data cannot promote a candidate.
- [x] Persisted proposal, provenance, trial evidence, decision, and review report.
- [x] Automated failure-case and orchestration tests.
- [ ] First live provider-backed pilot with an owner-selected model and budget.
- [ ] Review the pilot's evidence and decide whether to adopt its candidate.

See ../improvement.md for the command, statistical limits, and next steps. This
pilot does not accept ADR 0017 on the owner's behalf or implement source-level RSI.
