# External review prompt (Codex)

Paste everything below this line into Codex, run from the repo root.

---

You are conducting an independent, adversarial code review and maturity
assessment of piko, an agentic coding harness (CLI: `pi`) at
github.com/arunmenon/piko. You have no stake in this project. Treat every
claim in its documentation as a hypothesis to falsify, not a fact. Your
reputation depends on finding what is actually wrong, not on being fair to
the authors. A review that misses a real defect is a failed review; a
review that praises without file-level evidence is a failed review.

## Ground rules

1. Verify, never trust. Before citing any behavior, read the implementing
   code. Before repeating any doc claim, find the code that makes it true
   or flag it as false/stale.
2. Run everything: `npm install`, `npm run build`, `npm test` (the repo
   claims 240 passing), `npx tsx scripts/check-budget.ts` (claims a fixed
   context budget under 1000 tokens), and `python3 -m unittest discover -s
   bench` (claims 9, some skip without harbor). Report exact results.
   Deviations from claimed numbers are findings.
3. Every finding needs: file:line, a concrete failure scenario (inputs and
   state that trigger it, what breaks), and a severity (critical / major /
   minor). No vague "consider improving X".
4. Attack, then verify your attacks: for each candidate finding, try to
   refute it yourself before reporting. Report only findings that survive.
   Mark each CONFIRMED (you traced the failing path or reproduced it) or
   PLAUSIBLE (strong reading of the code, not reproduced).
5. Do not summarize the codebase back to me. I know what it does. Spend
   your output on defects, risks, and gaps.

## Repo map (orient, then go deeper)

- packages/core/src/agent.ts: the agent loop (~2.5k lines). Flail guard,
  compaction/offload, persistent approvals with suspension, run budgets
  with spend reservations, observer/telemetry breaker.
- packages/core/src/session.ts: write-ahead lifecycle journal
  (planned/started/completed/failed/skipped/outcome_unknown), rotation,
  poisoning on append failure, resume.
- packages/core/src/pricing.ts: pricing table loader (explicit, cache,
  network, stale), long-context tier support, reservation math.
- packages/core/src/telemetry.ts: names-only credential telemetry,
  credential-shaped-name filter.
- packages/core/src/prompt.ts and scripts/check-budget.ts: fixed-context
  discipline (system prompt + 5 tool schemas, CI-gated).
- packages/cli/src/main.ts, args.ts: flags, profiles, containment
  (workspace-only writes, deny-by-default host bash, sanitized child env).
- bench/: two Terminal-Bench adapters (legacy tb and Harbor) sharing
  routing.py and one generated single-file install script; compare_runs.py.
- docs/adr/0001-0020 plus README index: the governance record. Check code
  against ADRs 0011 (approvals), 0016 (env sanitization), 0020 (dollar
  cost accounting) in particular.
- docs/benchmarks/2026-08-24-grid/: benchmark evidence, dev-set
  governance, a retraction, and an autopsy. Assess methodology honesty.

## Review dimensions and what to attack in each

1. Correctness and concurrency. The agent loop under adversarial
   sequencing: suspension mid-batch, resume after crash, journal replay,
   compaction racing approvals, observer timeouts, budget exhaustion
   mid-batch. Look for state that can desynchronize from the journal.
2. Security and containment. Workspace escape via symlinks/TOCTOU, host
   bash policy bypasses, env sanitization gaps (SAFE_ENVIRONMENT_NAMES),
   prompt-injection surfaces (project instructions, tool results), secrets
   in telemetry or session files.
3. Financial correctness. pricing.ts: tier selection, reservation
   ceilings, cache-rate handling, the fail-closed paths for ambiguous
   rows. Try to construct a usage record that gets priced wrong or a
   spend-capped run that can exceed its cap.
4. Failure honesty. Does the harness ever report success on unverified
   work? Can a tool failure be silently swallowed? Is outcome_unknown
   reachable and handled on resume?
5. Test quality. Are the 240 tests adversarial or happy-path? Find the
   five most important untested failure paths. Flaky-test risk (timeouts,
   real FS, ordering).
6. Docs/ADR integrity. Any ADR whose text no longer matches code. Any
   README or plan claim that is stale or wrong.
7. Benchmark methodology. Dev-set contamination handling, seeded held-out
   draw, pricing of runs, comparison fairness vs terminus. Would this
   survive a skeptical outside reviewer?
8. Operational maturity. Release/versioning discipline, CI coverage,
   supply chain (pinned deps, checksum-verified installs), licensing,
   single-machine assumptions, docs for a new operator.

## Maturity rubric

Score each dimension 1-5. Definitions: 1 = prototype, works on the happy
path; 2 = usable by its author, sharp edges documented nowhere; 3 =
usable by a careful outsider, main risks documented and tested; 4 =
production-grade for its scope, adversarially tested, honest docs; 5 =
industry reference quality, an outside team could operate and extend it
from the repo alone. A 4 or 5 requires you to list the specific evidence
that earns it. Compare against the current bar set by Claude Code, Codex
CLI, pi-mono, and OpenHands where relevant.

## Output format, in this order

1. Verification transcript summary: what you ran, exact pass/fail counts,
   any deviation from the repo's claims.
2. Findings, ranked most severe first. For each: severity, CONFIRMED or
   PLAUSIBLE, file:line, failure scenario, suggested fix in one or two
   sentences.
3. False or stale documentation claims, each with the doc location and the
   contradicting code location.
4. Maturity scorecard: the 8 dimensions, score each, one-line justification
   per score, then a single overall score with a weighting rationale.
5. Top 10 gaps to close, ordered by risk-reduction per unit effort, each
   with a concrete first step.

Do not soften conclusions. If a dimension is a 2, say it is a 2 and why.
