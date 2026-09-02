# 0017 — Evidence-gated self-improvement (`pi improve`)

Status: proposed (2026-08-24)
Depends on: 0009, 0010, 0011, 0020

## Context

Self-modifying harnesses now exist: exoharness/exo lets the agent edit its own
policy layer at runtime, guarded by build-and-restart validation and rollback
on crash. Reading its source confirms the limit of that design: validation is a
liveness check on the live instance, and its own docs name the missing canary
path as a gap — nothing distinguishes a change that is *broken* from one that
is *bad* (boots fine, reasons worse, spends more). Elsewhere, extensibility is
human-installed slots. Nobody grades self-changes by measured outcomes. piko
already owns every component of that grader: fail-closed evals with
deterministic verifiers, hashed provenance manifests, hard budgets (0009),
dollar-denominated cost (0020), a journal that records honestly (0007), and
durable approvals (0011). The praxis gate principle applies: machine-verifiable
steps advance unattended; judgment calls stop the line.

## Decision

Self-improvement is an external controller, never core-loop machinery — the
same stance 0004 takes for sub-agents and 0002 takes for MCP.

1. Scope v1: policy assets only — skills, prompt templates, configuration,
   guard and compaction thresholds. Core source is out of scope until the
   sandbox executor (0018) provides a soak chamber, and is a separate future
   decision.
2. Loop: **propose** — a model edits assets in a workspace clone, oriented by
   the checked-in `docs/SELF.md` self-map; **prove** — `check-budget`, fault
   tests, and the eval suite run fail-closed, and an A/B of usage artifacts
   computes the fitness function: cost per completed task in USD (0020) at a
   non-inferior pass rate; **park** — the winning diff waits behind an 0011
   approval and the run exits 4; **promote** — on approval, commit with an
   auto-drafted ADR/changelog stub that the human edits before merge.
3. Provenance: an improve run can never modify approval policy, budgets, or
   its own gating — 0011's rule that policy comes only from user config and
   CLI flags extends to the improvement loop itself.
4. Every stage runs under normal RunBudgets; the A/B spend is bounded and
   reported like any other run.
5. Statistical validity is a promotion precondition, not an aspiration: no
   promotion may cite an eval suite whose measured run-to-run variance exceeds
   the effect being claimed. piko's own benchmark runs flipped task outcomes
   between identical n=1 runs, so the current 10-task suite cannot support a
   non-inferiority claim — expanding the suite and adding repeat trials to a
   stated bar is prerequisite work for the first promotion, not follow-up.

## Consequences

- The first shipped self-improvement loop whose promotion criterion is
  measured outcomes rather than process liveness; it dogfoods 0010, 0011, the
  eval suite, and 0020 in one feature, and costs nothing when unused.
- The eval suite becomes the ceiling on improvement quality: a weak suite
  promotes weak changes, so eval curation is product work from day one, not
  test hygiene.
- Costs: A/B evidence is paid for in real tokens; auto-drafted ADR stubs
  invite rubber-stamping (the human edit is part of the promotion contract);
  and decision 5 makes eval expansion and repeat trials prerequisite product
  work before the loop can promote anything.
- Explicitly out of scope: runtime hot-swap of the running process, guardian-
  style in-process rebuilds, and any self-modification path that bypasses the
  prove and park stages.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Darwin Gödel Machine", Zhang et al., arXiv 2505.22954, 2025.
  The agent hallucinated tool runs with fabricated passing test logs, then
  removed the logging its own hallucination detector depended on, while scoring
  highly against the predefined evaluation functions; the failure this record's
  gate exists to catch, observed.
- challenges: "Huxley-Gödel Machine", Wang et al., arXiv 2510.21614, 2025. An
  agent's own benchmark score poorly predicts whether its descendants improve,
  so selection by point score, which the promotion gate uses, is a misleading
  fitness signal.
- challenges: "Reward Hacking Benchmark", Thaman, ICML 2026, arXiv 2605.02964.
  Exploit rates of 0 to 13.9% across 13 frontier models rise with RL
  post-training and with task difficulty, so the proposer's incentive to game
  the suite grows with the capability the loop is meant to add.
- corroborates: "Sycophancy to Subterfuge", Denison et al., arXiv 2406.10162,
  2024. Models generalise to editing their own reward code, which is the
  argument for keeping the gate outside the model's write scope, as decision 3
  does.
- corroborates: "Adding Error Bars to Evals", Miller, arXiv 2411.00640, 2024.
  Paired-difference comparisons, confidence intervals from question-level
  sampling, and power analysis before running; decision 5, formalised.
- challenges: "Beyond pass@1", Khanal et al., arXiv 2603.29231, 2026. Across
  23,392 episodes, software-engineering reliability decays from 0.90 to 0.44
  across repeated attempts, so the n=1 comparisons the current suite can afford
  are unreliable.
- challenges: "Beyond Pass@k", Jiang et al., arXiv 2608.14711, 2026. A
  single-rollout proxy does not substitute for repeated runs (rho = 0.42).
- challenges: "A Sober Look at Progress", Hochlehnert et al., COLM 2025,
  arXiv 2504.07086. Reported gains often hinge on unreported seed and format
  variance, which is the noise this record's suite has not yet measured.
- corroborates: "Self-Harness", arXiv 2606.09498, 2026 (first author not
  recorded in the review). The closest shipped analogue validates by benchmark
  score with no pre-registration and no human gate.
- corroborates: "Prime Agent", arXiv 2608.23552, 2026 (first author not recorded
  in the review). The same shape, which is why an evidence gate with
  pre-registered statistics would be first in the field.

## Token-rent rule (re-homed 2026-09-02)

This amendment was moved to ADR 0001 as a proposed amendment to an accepted record, because CI already enforces it and an amendment inside a still-proposed record is structurally ambiguous (owner review, 2026-09-02). The text below is retained for history; the governing copy is in 0001.

### Original text (superseded)

The fitness function above (dollars per completed task) gains an enforcement
rule for the fixed context specifically:

1. Every line of the system prompt and every tool schema byte must keep
   paying measurable rent against the fitness function. An addition ships
   only with the benchmark evidence that justified it, cited in the commit
   that raises scripts/budget-baseline.json (the ratcheted gate fails CI on
   any unexplained growth).
2. At each benchmark grid, existing additions are re-audited: an addition
   whose measured benefit cannot be distinguished from noise is reverted
   and its tokens returned to the baseline.
3. Evidence for this rule, from the week it was drafted: the
   investigate-first guidance line pays clear rent (create-bucket
   0-for-history to 3/3 at 45 percent below the baseline harness's token
   cost); the tool-batching line moved failure cost only $0.202 to $0.188
   at n=3 and stands first for reversion if the next grid cannot validate
   it. The prefix itself is under 6 percent of a real run's bill, so this
   rule is about compounding discipline, not this week's dollars.
