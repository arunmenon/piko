# Benchmark grid manifest — 2026-08-24

Dataset: terminal-bench-core==0.1.1 (legacy tb CLI). Tasks (10): hello-world,
fix-permissions, fix-git, create-bucket, openssl-selfsigned-cert,
simple-sheets-put, simple-web-scraper, sqlite-db-truncate,
organization-json-generator, heterogeneous-dates. Attempts: 3 per task.
Concurrency 4; --global-timeout-multiplier 2. Host: single macOS machine,
arms sequential.

| Arm | Agent | Model | Solved | Input tokens | Output | Est. USD* |
|---|---|---|---|---|---|---|
| 1 | piko @ HEAD (a52cf9a era) | gpt-4.1 | 12/30 (40.0%) | 1,139,718 | 20,832 | ~$2.45 |
| 2 | piko | gpt-5.5 | 19/30 (63.3%) | 490,392 | 32,734 | ~$3.43 |
| 3 | terminus-2 (temperature=1) | gpt-5.5 | 25/30 (83.3%) | 439,498 | 39,971 | ~$3.40 |

*USD computed at list rates during analysis (gpt-4.1 $2/$8, gpt-5.5 $5/$30
per M in/out); in-container runs reported unpriced per ADR 0020 because the
pricing table was not baked into the bench bundle (filed follow-up).

External anchor: terminus-2 + gpt-5.5 = 78.0% +/- 1.2 on the official
Terminal-Bench 2.1 full suite (rank 7, tbench.ai, 2026-05-01). Local 83.3%
on this easier-band 10-task subset is consistent with that anchor.

Headline findings (honest):
1. At the gpt-5.5 tier on this subset, terminus-2 beat piko on solve rate
   (25 vs 19) AND cost per solve (~$0.136 vs ~$0.181). The gpt-4.1-era
   "6x cheaper at parity" result does not generalize to this tier/subset.
2. piko's gap concentrates in three places: create-bucket (0/3 vs 3/3 --
   piko quit after ~2 calls; root-caused and fixed post-grid, retest 3/3,
   see create-bucket-autopsy.md);
   fix-git failure spend (both harnesses 0/3, but piko burned 64.5k mean
   input per failure vs terminus 19.5k — flail thresholds tuned on
   non-reasoning models look loose for reasoning models); openssl and
   hello-world dropped attempts (timeout/no-usage trials).
3. Where both harnesses solved, piko was cheaper on 4 of 7 matched tasks
   (e.g. simple-sheets-put 30.4k vs 49.8k) — the per-turn lean advantage is
   real but was outweighed by the failure-mode differences above.
4. gpt-5.6 family (sol/terra) cannot run tool-calling via chat completions
   ("use /v1/responses"); frontier-most benchmarking blocks on the v0.3
   Responses adapter. Dead sol arm dir: 16-39-01 (excluded).

Known data gaps: 6 of 60 pi trials lack usage rows (killed before summary);
their spend is uncounted, so pi totals are floors. Pane-capture truncation
bug in the extractor was found and fixed during this grid (a52cf9a).

Run dirs (local, ephemeral): 16-10-28 (arm 1), 17-31-14 (arm 2),
19-10-52 (arm 3). Comparison artifact: gpt-5.5-comparison.json (committed).
