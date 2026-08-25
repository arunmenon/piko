# Official suite: terminal-bench@2.0, first run (2026-08-25)

Agent: piko at b42cab4 (815-token prompt, post token-rent revert), model
gpt-5.5, Harbor adapter (bench.harbor_agent:Piko), n=1, concurrency 3,
every trial capped at $1.50 (--max-spend-usd). 89 tasks, none ever seen or
tuned against by this harness. Runtime 5h24m on one macOS machine.
Per-trial rewards, costs, and stop reasons: results.json (committed).

## Headline metric (ADR 0017: dollars per completed task)

$0.875 per solve. $26.24 total measured spend (71 of 89 trials priced,
self-reported at real cached rates), 30 solves.

## Score, honestly accounted

30/89 solved (33.7%) with every planned trial in the denominator.
Decomposition of the 59 non-solves:

| Class | Count | Attribution |
|---|---|---|
| Scored but failed | 11 | capability |
| Stopped by the $1.50 spend ceiling | 24 | cost-bounding choice |
| Agent timeout (900s Harbor default) | 10 | time-bounding choice |
| Docker compose failures | 9 | local infrastructure |
| Agent install failures (exit 1) | 4 | local infrastructure |
| Verifier timeout | 1 | local infrastructure |

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

The run therefore maps one point on the cost/quality frontier: ~34% of
the official suite for ~$26 total. Mapping the rest of the curve (rerun
the 24 ceiling-stopped tasks at $3 and $5 caps, raise the agent timeout,
retry the 14 infrastructure failures) costs roughly $15-30 of additional
credit and is the obvious next measurement. Remaining credit at run end:
roughly $5, insufficient; a top-up decision is the owner's.

## Governance notes

Dev-set rules did not apply here (nothing was tuned on these tasks); this
is the first number in the project quotable as evidence rather than tuning
feedback. The spend ceiling did its job: zero runaway trials, worst
priced trial $1.50 nominal / ~$0.70-1.0 actual, and the 24 stops are
recorded as failures, not excluded. Infra failures (14) are counted
against the score, matching the manifest-driven accounting rule; a
clean-infrastructure rerun would recover some of them.
