# Official suite: terminal-bench@2.0, first run (2026-08-25)

Agent: piko at b42cab4 (815-token prompt, post token-rent revert), model
gpt-5.5, Harbor adapter (bench.harbor_agent:Piko), n=1, concurrency 3,
every trial capped at $1.50 (--max-spend-usd). 89 tasks, none ever seen or
tuned against by this harness. Runtime 5h24m on one macOS machine.
Per-trial rewards, costs, and stop reasons: results.json (committed).

## Headline metric (ADR 0017: dollars per completed task)

$0.795 per solve. $26.24 total measured spend (71 of 89 trials priced,
self-reported at real cached rates), 33 solves.

## Score, honestly accounted

33/89 solved (37.1%) with every planned trial in the denominator.
Decomposition of the 56 non-solves:

| Class | Count | Attribution |
|---|---|---|
| Scored but failed | 11 | capability |
| Stopped by the $1.50 spend ceiling | 25 | cost-bounding choice |
| Agent timeout (900s Harbor default) | 7 | time-bounding choice |
| Docker/install/verifier failures | 13 | local infrastructure |

Correction (same day): the first count of this run said 30/89. It
classified any trial carrying a harness exception as a non-solve, but pi
exits code 2 on budget_exceeded, and three tasks (build-pmars,
cobol-modernization, llm-inference-batching-scheduler) PASSED their
verifiers before the ceiling cut the process off. Reward is the source of
truth for solved; the exception is a stop reason, not an outcome.

## What this number is and is not

This is a COST-BOUNDED capability measurement: what 89 unseen official
tasks yield at roughly $0.30 per attempted task, wall-clock-capped at 15
minutes each. It is NOT comparable to the terminus-2 leaderboard anchor
(78.0 +/- 1.2 on Terminal-Bench 2.1): that number runs uncapped spend,
longer horizons, and a different (harder) task set. 24 of our failures are
trials this harness chose to stop mid-flight when dollars ran out; the
ceiling was sized on dev-set economics (worst solve ~$0.25) and is plainly
too low for the official suite's difficulty band, where the reservation
mechanics of ADR 0020 stop work near ~$0.70 actual on long-context tasks.

The run therefore maps one point on the cost/quality frontier: ~37% of
the official suite for ~$26 total. Mapping the rest of the curve (rerun
the 25 ceiling-stopped tasks at $3 and $5 caps, raise the agent timeout,
retry the 13 infrastructure failures) costs roughly $15-30 of additional
credit and is the obvious next measurement. Remaining credit at run end:
roughly $5, insufficient; a top-up decision is the owner's.

## The ceiling clips inside the solve distribution (measured)

Cost distributions from results.json:

| Class | min | median | max |
|---|---|---|---|
| Solved (n=33) | $0.043 | $0.258 | $0.668 |
| Ceiling-stopped (n=28) | $0.243 | $0.543 | $0.800 |
| Scored failures (n=11) | $0.112 | $0.273 | $0.683 |

These overlap almost entirely: 18 of 33 solves cost more than the
cheapest ceiling stop, and three tasks solved WHILE being cut off. The
ceiling is therefore firing inside the band where this harness wins, not
safely above it. Two causes, both ours:

1. The cap was sized on dev-set economics (worst solve there $0.25) and
   never revalidated against a harder suite where solves reach $0.67.
2. ADR 0020 reserves conservatively before each request, so a $1.50
   nominal cap stops work at $0.24-$0.80 actual: the effective ceiling is
   roughly half the nominal one, and lower still on long contexts.

Neither invalidates spend ceilings; both say this ceiling was set wrong
and its nominal number does not mean what an operator would assume. A
frontier rerun at $3 and $5 measures how many of the 25 stops were
winnable. Until then, 37.1% is a floor, not a capability estimate.

## Governance notes

Dev-set rules did not apply here (nothing was tuned on these tasks); this
is the first number in the project quotable as evidence rather than tuning
feedback. The spend ceiling did its job: zero runaway trials, worst
priced trial $1.50 nominal / ~$0.70-1.0 actual, and the 24 stops are
recorded as failures, not excluded. Infra failures (14) are counted
against the score, matching the manifest-driven accounting rule; a
clean-infrastructure rerun would recover some of them.
