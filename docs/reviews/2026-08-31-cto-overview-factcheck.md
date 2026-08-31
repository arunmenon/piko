# Fact-check of the CTO overview artifact (received 2026-08-31)

External model-driven fact-check of docs/reviews/cto-overview-content-2026-08-31.md,
run with docs/reviews/cto-overview-review-prompt.md against this repository.
Received verbatim from the operator; recorded here as review provenance.
Disposition: findings accepted; the artifact was rewritten the same day
(see the follow-up content extract in this directory).

---
1. Critical — WRONG: the headline benchmark is development-set evidence.
   The 25/30 parity, $0.098/solve, 28% saving, and "8 of 10 tasks" claims
   appear throughout the stat band, executive summary, Exhibit 1, and
   conclusion. The benchmark record explicitly designates those ten tasks as
   a development set, says the prompt was tuned on their failures, and
   states that its results "must not be quoted as headline results"
   (docs/benchmarks/2026-08-24-grid/rerun-and-heldout.md). The 25/30 result
   exists only as a narrative entry; the committed machine-readable
   comparison is for the earlier 24/30 run.

2. Critical — WRONG: Exhibit 3 misstates both measured cost and capability.
   $26.24 is the measured subtotal for 71 of 89 trials; 18 trials are
   unpriced. The 11 are trials that reached a scored failure; cap-stopped,
   timed-out, and infrastructure-failed trials do not reveal counterfactual
   capability. 28 total trials carried a ceiling stop (25 unsolved plus
   three solved), not "25 stopped, three of those passed." "Uncapped run
   costs 3-4x" is unsupported.

3. Critical — WRONG: the trust section claims a containment guarantee that
   is known not to exist yet. "Blast radius at zero" contradicts ADR 0022's
   documented, reproduced parent-symlink race; the descriptor-relative
   implementation and regression suite have not landed.

4. Major — WRONG: the fitness metric and token-rent rule are not ratified.
   ADR 0017 is proposed; its token-rent amendment says "awaiting owner
   ratification." ADR 0020 ratifies dollar accounting and ceilings only.

5. Major — WRONG: there are 23 ADR records, not 24. No ADR 0021 file or
   index row exists; the artifact invented "0021 (reserved)."

6. Major — UNSUPPORTED: the independent-review provenance is absent from
   the repository (prompt committed, report not committed). "Each
   reproduction is now a permanent regression test" is false while ADR
   0022's parent-swap tests remain unimplemented.

7. Major — WRONG: benchmark-honesty guarantees overstated. The page
   headlines the tuned development set while claiming tuning is barred from
   headlines; three cron-broken-network trials were excluded from the
   held-out denominator; compare_runs warns and continues without metadata
   rather than refusing; the gaming scan covered a specific signature on
   the held-out run only.

8. Major — OVERSTATED: competitive claims are publicly rebuttable
   (Claude Code gateway budgets exist; Terminus exposes prices and turn
   limits; fusion documents round caps, timeouts, and a writer lease;
   DeepSeek characterization unsupported; Codex 2-5k figure
   unsubstantiated). Defensible narrow claim: piko implements a native
   per-run USD ceiling with conservative pre-dispatch reservation and
   durable exposure accounting.

9. Major — WRONG: CI verifies the ratchet numbers, not evidence citations;
   the evidence requirement lives in error text. 815 is the default
   prompt + built-in schemas, not everything attached to every request.

10. Major — WRONG: the 44% cache figure belongs to the 24/30 run's
    committed artifact, not the 25/30 "parity run."

11. Major — WRONG: the journal reports unknown outcomes honestly but does
    not deduplicate; "repeated work impossible" contradicts ADR 0007.

12. Moderate — OVERSTATED: "per pipeline" spend limits imply aggregate
    budgets that remain roadmap work.

13. Moderate — OVERSTATED: ADR summaries erase documented limitations
    (0005 guard does not catch successful-no-op loops; 0004 delegation
    path caveat).

14. Moderate — WRONG: license is not the only external-adoption blocker
    (ADR 0019 requirements and roadmap items outstanding).

15. Minor — WRONG: the correction history misdescribes what was retracted
    (the flail-threshold claim, not "a headline cost claim").

Reviewer's suggested first edits: replace the parity headline with the
official-suite figures and their caveats; state the true ADR counts and
statuses; replace the independent-review/security claim with the honest
pre-production statement.
