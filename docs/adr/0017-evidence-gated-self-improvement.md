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

## Proposed amendment (2026-08-25, token rent — awaiting owner ratification)

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
