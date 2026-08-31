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

Headline metric first (ADR 0017): $0.106 per solved trial at real cached
rates, fully self-priced, versus terminus's ~$0.136 upper-bound estimate.

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

Held-out result (runs 2026-08-24__22-25-43 and 2026-08-25__01-05-02, after
two aborted attempts: one credit exhaustion with zero valid trials
recorded, one Docker infrastructure collapse under disk pressure):

Score: 12/27 valid trials (44.4%) across 9 measured tasks.
blind-maze-explorer-algorithm 3/3, extract-safely 3/3,
tmux-advanced-workflow 3/3, oom 2/3,
decommissioning-service-with-sensitive-data 1/3, chess-best-move 0/3,
play-zork 0/3, polyglot-c-py 0/3, swe-bench-astropy-2 0/3.
cron-broken-network (3 planned trials) is excluded and recorded as a known
harness limitation, not a model failure: the task disables container DNS
by design, and the installer downloads Node at trial time, so the agent
can never boot. The single-binary roadmap item removes this class.

Gaming-check verdict: the dev-set prompt fixes are general dispositions,
not benchmark hacks.
1. No new failure class: a scan of every failed held-out trial for the
   create-bucket premature-blocked signature (early stop, "credentials are
   not configured", blocked report) found zero occurrences. Failures are
   hard-task failures: deep chess evaluation, long-horizon interactive
   play, a real SWE-bench issue, dual-language golf.
2. No inappropriate credential behavior: swe-bench trials fabricated
   nothing; the sensitive-data decommissioning trials engaged the
   archive/GPG/shred procedure directly with no fabricated-credential or
   blocked-report behavior.
3. Bounded failure spend, with one finding: play-zork consumed the full 80
   max-turns in all three trials (~$2.06 mean per failure, $6.18 of the
   $11.69 rerun spend). The turn bound worked; a dollar bound would be
   tighter. Follow-up landed 2026-08-25: the bench adapter now passes
   --max-spend-usd 1.50 on every trial (bench/routing.py), sized from this
   run's evidence (worst observed solve ~$0.25, zork failures ~$2.06).

Solved-task efficiency stayed lean (2-10 requests per solve; extract-safely
solves at ~$0.03). No terminus arm was run on the held-out set; these
numbers stand alone as a piko generalization check, not a comparison.

## Official suite path (Harbor / Terminal-Bench 2.x)

bench/harbor_agent.py ports the adapter to Harbor as custom agent
`bench.harbor_agent:Piko` (named "piko"; Harbor's built-in "pi" is the
badlogic agent). It reuses bench/routing.py for command and credential
construction and installs the same generated single-file build, so the
legacy and Harbor paths cannot drift apart silently. Acceptance so far
(no API spend): install-only trial on terminal-bench@2.0's gpt2-codegolf
container completed cleanly. Open item: the terminal-bench 2.1 dataset ref
resolves on the hub but returns zero tasks through this client; run the
89-task terminal-bench@2.0 suite meanwhile, and note the public terminus
anchor (78.0 +/- 1.2) is quoted against 2.1.

## Token-rent audit and second rerun (2026-08-25)

Second post-fix grid (run 13-31-06, spend-ceilinged): 25/30, exact solve
parity with terminus (both 25/30 across 9/10 tasks, both losing 2
simple-web-scraper trials to the same-task port collision), at $0.098 per
solve self-priced versus terminus's ~$0.136 upper bound. create-bucket
3/3 for the third consecutive run at 4,590 mean input versus terminus
6,651. No trial reached the $1.50 ceiling (max observed $0.382).

Token-rent audit: the tool-batching prompt line failed. fix-git failure
cost across three grids: $0.202 (pre-line) -> $0.188 -> $0.227 per
failure; no consistent benefit at n=3 each. Reverted per the ADR 0017
token-rent rule; the fixed prefix returns to 815 tokens and the ratchet
baseline is lowered accordingly. The investigate-first line keeps paying
rent (create-bucket) and stays.

## Data-lifecycle note (2026-08-31)

The 25/30 second rerun (13-31-06) was recorded above as narrative the day
it ran, but its per-trial comparison artifact was never committed and the
run directory has since been lost with the session scratchpad. Its figures
(25/30, $0.098 per solve) are therefore narrative-only and must not be
used where machine-traceable evidence is required; the committed
machine-readable dev-set artifact remains rerun-comparison.json (24/30,
$0.106 per solve). This is exactly the artifact-retention gap the reserved
data-lifecycle ADR exists to close.
