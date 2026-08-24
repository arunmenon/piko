# Grid rerun and held-out protocol (2026-08-24)

## Dev-set governance

The original 10-task subset is hereby a DEV SET. Both prompt fixes shipped
today (investigate-before-blocked, batch-and-fold-plan-updates) were
motivated by and validated on failures from these tasks, so numbers from
this subset are tuning feedback, not evidence. They must not be quoted as
headline results. Headline claims require tasks the harness was never
tuned against: the held-out set below, or the official Terminal-Bench 2.1
suite (Harbor port pending).

## Rerun result (dev set, post-fix)

Run 2026-08-24__20-29-49, pi + gpt-5.5, 10 tasks x 3, same settings as the
original arm: 24/30 (80.0%), up from 19/30. Terminus baseline (19-10-52)
remains 25/30. Misses: fix-git 0/3 (terminus also 0/3), openssl 1 miss
(model variance; normal 3-request session, grader rejected), and 2
simple-web-scraper trials whose containers never started (host-port
collision between concurrent trials of the same task). A serial rerun of
simple-web-scraper went 2/3, so one of those two drops would likely have
been a genuine miss anyway: pooled clean-trial score 25/31 (~81%),
effectively even with terminus on solves.

create-bucket held 3/3 in the full grid at 3,673 mean input tokens versus
terminus 6,651 on the same task. No task solved before the prompt changes
regressed. piko used fewer input tokens than terminus on 8 of 10 tasks.
First fully self-priced run: 28/28 measured trials reported complete USD,
total $2.54, $0.106 per solve at real cached rates (terminus per-solve
remains an upper-bound estimate; its logs carry no cache split).

## Held-out draw (generalization test for the prompt fixes)

Pool: the 70 terminal-bench-core==0.1.1 tasks not in the dev set.
Draw: seeded, reproducible, documented before results existed:

    random.Random("piko-heldout-2026-08-24").sample(sorted(pool), 10)

Drawn tasks: blind-maze-explorer-algorithm, chess-best-move,
cron-broken-network, decommissioning-service-with-sensitive-data,
extract-safely, oom, play-zork, polyglot-c-py, swe-bench-astropy-2,
tmux-advanced-workflow.

This band is visibly harder than the dev set (interactive tmux tasks, a
SWE-bench port, game playing). The purpose is not a high score; it is to
check that the dev-set fixes are general dispositions rather than
benchmark hacks: no regression class introduced, no fabricated-credential
behavior where it does not belong, reasonable failure spend. Result to be
recorded here.

Held-out result: PENDING
