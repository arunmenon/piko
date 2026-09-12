# Offload RSI research report — 2026-09-12

## Executive result

The updated three-scout pilot ran once on commit `cfcb1723f13ff8795949ded56421aa636f3cd69f` with `fireworks/kimi-k2p7-code`, the explicit Kimi pricing table, bubblewrap required, the existing five-repeat acceptance rule, and a $4.97 run ceiling. All three baseline scouts solved their tasks with complete priced usage. None produced a tool result at least 4,000 characters old enough to be eligible for offload, none emitted an offload event, and none recalled an offload artifact. The predeclared gate therefore stopped the experiment before proposing or measuring a candidate.

This validates the repaired orchestration path: the complete fixed scout batch ran, zero-evidence scouts were retained, usage reconciled, and the controller stopped without manufacturing mechanism activation. It does **not** show that the baseline offload policy is optimal, and it provides no baseline-versus-candidate estimate or statistically supported improvement.

## Run and provenance

- Commit: `cfcb1723f13ff8795949ded56421aa636f3cd69f`
- Branch: `feat/evidence-gated-offload-improvement`
- Model: `fireworks/kimi-k2p7-code`
- Endpoint: keyless exe.dev OpenAI Chat Completions gateway
- Context window supplied to Piko: 262,144 tokens
- Pricing: explicit table at `/home/exedev/.config/pi/exe-llm-kimi-k2p7-code-pricing.json`
- Sandbox: bubblewrap, required for every trial
- Acceptance thresholds: at most 0.05 quality loss, at least 0.05 relative cost saving, and improved observed cost per verified solve
- Repeats if measurement gates opened: 5
- Per-trial ceiling: $1
- Run ceiling: $4.97
- Final status: `insufficient_evidence`
- Exit code: 2
- Reason: `fixed scout batch found no large-output evidence to justify an offload experiment`

Before dispatch, `npm ci`, `npm test`, and `npm run check-budget` passed. The TypeScript suite reported 419 passes, zero failures, three platform skips, and 17 documented TODOs; all 19 Python tests completed with three skips; the fixed prompt remained approximately 815/1,000 tokens.

## Scout results

| Scout | Verified | Requests | Input | Cached input | Output | Calculated USD | Large outputs | Offloads | Recalls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `offload-dev-1` | yes | 6 | 2,176 | 5,285 | 623 | $0.00556335 | 0 | 0 | 0 |
| `offload-dev-2` | yes | 6 | 2,292 | 5,628 | 539 | $0.00540272 | 0 | 0 | 0 |
| `offload-dev-3` | yes | 7 | 2,926 | 8,137 | 700 | $0.00712573 | 0 | 0 | 0 |
| **Total** | **3/3** | **19** | **7,394** | **19,050** | **1,862** | **$0.01809180** | **0** | **0** | **0** |

The model used targeted shell searches and compact outputs rather than reading or printing whole log files. That is desirable agent behavior. The task suite should not be changed to demand gratuitously large output merely to activate an optimization.

No proposal was frozen. No paired development measurements or confirmation trials ran. Baseline remains 4,000 characters / six recent messages; neither 2,000/four nor 8,000/twelve has evidence for adoption from this experiment.

## Cumulative paid-work ledger

The cumulative $5 authorization includes compatibility probes and failed/inconclusive pilots, not only successful experiment rows.

| Paid work | Calculated USD | Usage disposition |
| --- | ---: | --- |
| Kimi text compatibility probe | $0.00069425 | complete, priced |
| Kimi sandboxed tool-call probe | $0.00145799 | complete, priced |
| Original one-scout pilot (controller rejected capabilities header) | $0.01440805 | complete, priced; infrastructure failure after scout |
| Fresh one-scout pilot after parser fix | $0.00594214 | complete, priced; zero evidence |
| Updated three-scout pilot | $0.01809180 | complete, priced; zero evidence |
| **Cumulative** | **$0.04059423** | **no unknown or outstanding usage** |
| **Remaining authorized ceiling** | **$4.95940577** | calculated-cost basis |

The gateway does not expose an independently reconcilable billed-dollar field. Dollar totals are exact under the frozen explicit pricing table and provider-reported token counters, but are not an invoice reconciliation.

## Preserved evidence

Current run:

- Report: `/home/exedev/workspace/piko/artifacts/improve/rsi-offload-kimi-k2p7-code-three-scout-2026-09-12/report.md`
- Decision: `/home/exedev/workspace/piko/artifacts/improve/rsi-offload-kimi-k2p7-code-three-scout-2026-09-12/decision.json`
- Experiment ledger: `/home/exedev/workspace/piko/artifacts/improve/rsi-offload-kimi-k2p7-code-three-scout-2026-09-12/experiment.json`
- Event history: `/home/exedev/workspace/piko/artifacts/improve/rsi-offload-kimi-k2p7-code-three-scout-2026-09-12/history.json`
- Scout directories: `trial-0`, `trial-1`, and `trial-2` beneath that directory

Earlier experiment directories remain preserved:

- `/home/exedev/workspace/piko/artifacts/improve/rsi-offload-kimi-k2p7-code-2026-09-12`
- `/home/exedev/workspace/piko/artifacts/improve/rsi-offload-kimi-k2p7-code-2026-09-12-02`

## Why the current fixtures are insufficient

The incident-log fixtures are deterministic mechanism probes, not representative coding tasks. They have one file family, one extraction pattern, one small output artifact, and a cheap solution based on `grep`. A capable model can avoid large retained tool results entirely. Repeating these fixtures would primarily measure sampling variation in tool strategy, and retrying until offload appears would bias proposal selection.

The three successful zero-evidence scouts establish only that offload was dormant for these trajectories. They do not estimate the effect of offload on tasks where substantial diagnostic output arises naturally. Five repeats also cannot certify a five-percentage-point quality floor with the current Hoeffding rule; even a full development and confirmation cycle would be pipeline validation unless the confidence bounds actually passed.

## Representative coding-task design

The next suite should use small, vendored, network-free repositories with deterministic setup and verification. Prompts should state the software objective and required tests, not instruct the model to produce large output. Tool-output pressure must arise naturally from realistic diagnosis.

### Development fixtures

1. **Strict TypeScript cross-package regression**
   - Three workspace packages and 15–25 source/test files.
   - Seed an API-contract change that causes errors in declarations, tests, and one downstream package.
   - Require a backward-compatible fix and all package tests to pass.
   - Verifier checks behavior, strict typecheck, public exports, and absence of broad test weakening.

2. **Node CLI fault-isolation task**
   - A CLI with fixture-driven integration tests and several similar parsers.
   - Seed one malformed-input lifecycle bug that produces a multi-test failure report but has a focused implementation fix.
   - Verifier runs focused and full tests, checks exit codes and stderr contract, and rejects snapshot deletion or skipped tests.

3. **Python data-pipeline refactor**
   - A multi-module package with unit and integration fixtures, no third-party downloads.
   - Seed inconsistent normalization across batch and streaming paths.
   - Require one shared implementation while preserving ordering and error semantics.
   - Verifier runs `unittest`, checks golden outputs, and rejects hard-coded fixture answers.

### Confirmation fixtures

4. **TypeScript persistence migration**
   - A journal/schema reader with mixed-version fixtures and crash-tail cases.
   - Seed a compatibility regression requiring localized migration logic.
   - Hold out fixture names and malformed-tail combinations from development tasks.

5. **Node concurrency and cancellation repair**
   - A worker queue with deterministic fake clocks/processes.
   - Seed a cancellation race that leaves a child or unresolved promise.
   - Verifier checks cleanup, timeout bounds, and repeated deterministic execution.

6. **Python command-routing security fix**
   - A command builder with quoting, environment filtering, and provider selection tests.
   - Seed a cross-provider environment leak or quoting regression.
   - Verifier checks adversarial arguments and that unrelated credentials are absent.

### Fixture quality gates before any model call

- Every repository is generated reproducibly from tracked source.
- The seeded revision fails its intended tests; the maintainer solution passes all tests.
- Verifiers reject test deletion, blanket skips, hard-coded expected artifacts, and unrelated destructive edits.
- Development and confirmation task-definition hashes are frozen and disjoint.
- A human reviews that prompts request real engineering outcomes rather than verbose output.
- Offline dry runs prove sandbox availability, timeout behavior, artifact capture, and complete cost parsing with a fake provider.

## Predeclared next experiment

This is a design, not authorization to run immediately.

- Scope: the six representative fixtures above, three development and three confirmation.
- Model/endpoint/pricing: unchanged Kimi endpoint and frozen exact-model pricing.
- Baseline: 4,000-character threshold / six recent messages.
- Scouts: one baseline attempt for each development fixture; all three complete before aggregation; no retries and no early evidence stop.
- Scout gate: stop if aggregate `largeOutputs + offloaded == 0`; stop on any incomplete usage, unknown cost, invalid evidence, timeout, or infrastructure failure.
- Proposal rule: unchanged—2,000/four only for large-output evidence without recalls; 8,000/twelve when recalls occur.
- Development: five paired repeats per task, alternating arm order.
- Confirmation: five paired repeats per held-out task only if the unchanged development screen passes.
- Acceptance: unchanged maximum quality loss 0.05, minimum cost saving 0.05, and strictly lower observed cost per verified solve.
- Cost: per-trial ceiling $1; cumulative next-run ceiling no more than **$4.95**, which keeps the already reconciled $0.04059423 below $5 even if the next run reaches its ceiling.
- Interpretation: call the result a pipeline/representativeness pilot unless the predeclared confidence bounds pass. Do not adopt settings from point estimates alone.

Before running, register the fixture source, verifier, split, pricing hash, model identifier, context window, timeout, and command in a tracked preregistration document. Any post-registration task or threshold change creates a new experiment.

## Prioritized roadmap

### 1. Offloading

1. Implement and review the representative fixture suite; this is the immediate blocker.
2. Add offline controller tests that replay complete real JSONL trajectories, including capabilities headers, zero-evidence batches, recalls, malformed evidence, and mixed eligible/ineligible tool results.
3. Record diagnostic counters for eligible old tool-result characters, batch-minimum suppression, chosen cutoff, cache-breaking rewrites, and artifact rereads. Keep these out of the fixed prompt.
4. Separate mechanism activation from benefit: first establish that realistic tasks activate offload, then compare quality and cost under a frozen proposal.
5. Explore content-aware eligibility only after threshold/retention evidence exists; do not add model-authored policy search yet.

### 2. Compaction

1. Build a separate representative long-horizon suite where context pressure occurs naturally through edits, tests, and recovery—not padded prompts.
2. Measure compaction request cost, cache-read/write effects, summary fidelity, rehydration success, lost constraints, and post-compaction task completion.
3. Compare offload-only, compaction-only, and combined behavior using factorial arms only after each mechanism has an activation baseline; otherwise interactions are uninterpretable.
4. Add deterministic summary-fidelity checks for filenames, failing-test identities, user constraints, pending work, and prior tool outcomes.
5. Keep crash semantics, pending approvals, and session lineage as hard gates before optimizing summary size.

### 3. Model routing

1. Implement the provider capability registry and native OpenAI Responses adapter already identified on the roadmap; endpoint/API incompatibility must be resolved before broad routing comparisons.
2. Define routing inputs that are available before dispatch: task class, expected context pressure, sandbox/tool requirements, price table, and prior gate failures. Do not route using confirmation outcomes.
3. Start with a predeclared two-tier policy: a cost-efficient coding model for standard tasks and one stronger model for security/architecture or one allowed escalation after a deterministic gate failure.
4. Journal route decisions, exact model IDs, capability checks, prices, and escalation reasons with each request lineage.
5. Evaluate routing on cost per verified solve with failure and escalation costs included; compare against fixed-model baselines on the same task/repeat pairs.

## Conclusion

RSI-01's control pipeline now behaves correctly for a complete zero-evidence scout batch: it spends little, preserves evidence, reconciles usage, and stops rather than forcing a candidate. That is successful pipeline validation. There is currently no measured offload improvement and no statistical support for changing defaults. The next useful work is representative task construction and offline preregistration, followed by one new bounded experiment—not another attempt on the same synthetic logs.
