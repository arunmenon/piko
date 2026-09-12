# Offload improvement pilot

This implements the next external experiment cycle from proposed ADR 0017.
It uses deterministic representative coding fixtures while preserving the same
scout/propose/compare policy gate. It does not change that ADR's status or promote
a policy automatically.
The command is `npm run improve`, not a new core `pi improve` command.

## What it does

1. Freeze source/config/pricing provenance and acceptance settings; run `npm test`
   and `npm run check-budget`, then freeze the built runtime hash.
2. Predeclare three development coding tasks and three disjoint confirmation
   tasks, including their definition hashes and the fixed trial order. Scout each
   development task once using the default offload policy (4,000 characters, six
   recent messages). Complete the fixed batch before aggregating actual JSON events
   for large outputs, offloads, and artifact reads. No retries or early stop when
   evidence appears. Store event line references with their source artifacts;
   retain zero-evidence scouts too.
3. Propose exactly one alternative: earlier offload (2,000/four) when large-output
   evidence exists without observed recalls; longer retention (8,000/twelve) when
   artifact recalls occur. These are hypotheses, not estimates of savings.
4. Run paired baseline/candidate attempts, alternating which arm goes first.
   Reject candidates that fail the development quality/cost-per-solve screen.
5. Evaluate the frozen candidate on disjoint confirmation fixtures, without
   passing those outcomes back to proposal selection. Save the verdict and park
   supported candidates for human review. Nothing is installed, merged, or edited.

The v1 proposer is deterministic and intentionally restricted to two existing
policy controls. Model-authored proposals, source mutation, multi-idea search,
restart/resume, and automatic promotion are not implemented. The only CLI changes
expose existing core offload settings; the system prompt and tool schemas do not grow.

## Run

Configure a provider credential through Piko's normal environment/profile setup.
Use an exact-model pricing file and an available OS sandbox provider. The runner
requires `--sandbox require` for every trial and preserves configured approvals.
An environment with trusted extensions is refused rather than silently changing
its configuration. No provider key is written into experiment artifacts.

```bash
npm ci
npm run improve -- --target offload \
  --profile openai --model YOUR_MODEL \
  --pricing /absolute/path/model-prices.json \
  --budget-usd 10 --per-trial-usd 1 --repeats 5
```

The budget is a ceiling, not a promise to complete every trial. The controller
reserves the full per-trial ceiling before dispatch. A complete cost record
releases the unused reservation; missing/unknown usage retains it and stops the
experiment. Failed trials still cost money and remain in all comparisons. If
this example exhausts its budget, its verdict is insufficient evidence.

Scouts share that same budget and are labeled separately from measurement trials.
Their costs count toward research spend, but scout results are never reused as
paired measurements. If any scout cannot complete with valid usage and evidence,
the controller stops without proposing from a partial batch. With five repeats,
a full run is three scouts plus 30 development and 30 confirmation attempts;
development rejection skips confirmation. An all-zero scout batch stops without
a proposal, even if a prior experiment observed offloading.

The evaluator is fixed outside the task workspace. Each task runs in a fresh
workspace using the same built Piko executable with different offload flags.
Source, configuration, price table, and built-runtime changes stop the experiment.
The optional evaluation `--harness-root` selects a separate build without moving
verification into that build; it is not an authorization boundary for arbitrary
untrusted harness executables. This pilot only runs its own fixed Piko build.

## Evidence and statistical limits

The six representative fixtures cover integration-test repair, cross-file behavior
changes, and regression investigation in dependency-free Node and Python repositories.
They remain a bounded research suite, not evidence of broad software-engineering
capability. Each verifier runs outside the task workspace, protects public tests,
and adds hidden behavioral checks; offline qualification proves seeded states and
plausible incorrect solutions fail while maintainer repairs pass.

Default acceptance: at most five percentage points of task-success loss and at
least five percent lower total cost, plus improved observed cost per solve.
Confirmation uses two one-sided Hoeffding bounds (alpha .025 each, joint coverage
at least 95% by a union bound), on paired success differences and bounded paired
cost differences. The assumptions are independent repeat trials and complete costs
within the fixed per-trial bound. Costs include failures. The cost-per-solve point
estimate is an additional screen, not a separately confidence-bounded ratio.

The bounds are deliberately conservative. Five repeats are a pipeline pilot and
cannot establish the default quality floor even if every outcome ties. For n
confirmation pairs, the quality radius is sqrt(2 * ln(40) / n); about 2,952 pairs
would be needed for a 0.05 radius. Do not spend that amount without first curating
representative tasks and choosing a powered statistical design. This milestone
builds the evidence loop; it does not claim a measured efficiency gain.

Do not repeatedly tune using confirmation results. Start a separately registered
experiment with fresh confirmation tasks for subsequent research. Do not weaken
the acceptance rule after looking at a candidate's results.

## Artifacts and exit status

Each new output directory contains:

- `preregistration.json`: model, pricing hash, task hashes, acceptance settings,
  budgets, trial counts, confirmation-isolation rule, and complete fixed execution plan.
- `experiment.json`: frozen configuration, committed spend and reservations.
- `history.json`: fsynced, atomically replaced complete event ledger; single writer.
- `proposal.json`, when evidence justifies a proposal: policy, hypothesis,
  aggregate evidence, a `sources` array of all scout artifacts with their own
  event line references, and candidate CLI arguments.
- `trial-N/`: evaluation manifest, source/build hashes, deterministic verdict,
  complete usage when available, full JSON event stream, and copied session.
- `decision.json` and `report.md`: result, measurements, and review status.

Exit 0 means rejected, 2 means insufficient evidence/setup/budget failure, and 4
means supported and parked for review. This external exit 4 is not a suspended
core tool approval and cannot be resumed with `pi --approve`. Review the report
and deliberately adopt settings through your normal change process.

Directories cannot be reused. After a crash, inspect the existing reservation and
journal before starting another separately budgeted experiment. There is no silent
retry of unknown-cost work. Artifacts contain model/task content and remain local,
owner-only where supported, under the gitignored artifacts directory by default.
