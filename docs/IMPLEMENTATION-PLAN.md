# Implementation plan — post-Exo pivot

Written 2026-08-24 against the working tree at `e07affd` (v0.2.0 prep). Inputs:
the external ADR-set review (2026-08-19), the Exo podcast analysis, and the
exoharness/exo source study (event log writable under the canonical rw mount;
no fsync on the event path; no hard budgets; canary gap admitted in
`SELF-CONTROL.md`). Since the review, 0011 has been accepted **and
implemented** (`suspended` TurnStatus, approval journal rows) — the keystone is
in. Goal for the period: **adopted OSS tool** with
one flagship differentiator: **evidence-gated self-improvement** — recursion as
an external controller, promotion only through evals, budgets, and a recorded
human decision. The core loop stays deliberately small: changes to it are
limited to enforcing accepted contracts such as budgets and executor policy;
orchestration and self-improvement remain external controllers. Every phase
lands with its ADR in the same change, per `docs/adr/README.md`.

Amended 2026-08-24 against `f8142ae` after a plan/ADR coverage review. The
amendment corrects the journal-versioning gap, adds artifact-lifecycle and
provider-capability decisions, makes spend and shutdown semantics precise,
moves adversarial evidence ahead of publication, and pre-registers the minimum
statistical bar for self-improvement promotion.

## Gap register

| # | Gap | Source | Addressed in |
|---|-----|--------|--------------|
| G1 | Durable approvals (0011) implemented in the v0.2.0 tranche; fault coverage and the approval/compaction boundary were closed on 2026-08-24 | ADR review; tree @ e07affd; `docs/adr/evidence/0011-approval-test-map.md` | Phase 1 — complete |
| G2 | Dollar accounting and a pre-dispatch spend ceiling landed with durable price provenance on 2026-08-24 | 0009; ADR 0020; `docs/adr/evidence/0020-pricing-test-map.md` | Phase 2a — complete |
| G3 | Secret-access telemetry landed 2026-08-24: credential.attach and policy.env_sanitized events, names-only by construction | 0013/0016; packages/core/tests/telemetry-secrets.test.ts | Phase 2b — complete |
| G4 | No graceful drain on SIGTERM; run status can end untidy under supervisors | Exo guardian pattern | Phase 2 |
| G5 | Adoption blockers: no license, no published packages, no quickstart, no doctor | Roadmap v1.0; goal choice | Phase 3 (ADR 0019) |
| G6 | Journal schema markers already ship, but migration, compatibility, and publication policy remain unpublished | 0007 consequences; tree @ f8142ae | Phase 3 (ADR 0019) |
| G7 | No OS-level sandbox executor; "run it in Docker yourself" is still documentation | 0006 named next layer; Exo ships providers | Phase 4 (ADR 0018) |
| G8 | Default contained config has no delegation path (sub-agents require `--allow-host-bash`) | 0004 addendum | Phase 4 (contained spawn) |
| G9 | No self-improvement loop; market gap: nobody grades self-changes by outcomes | Exo study (liveness-only validation, canary gap admitted) | Phase 5 (ADR 0017) |
| G10 | No curated self-map for improvement runs | Exo `SELF.md` | Phase 5 |
| G11 | Parser robustness asserted (fail-closed) but not adversarially evidenced | v1.0 roadmap line | Phase 3 pre-publication gate; expanded in Phase 6 |
| G12 | RPC surface undecided; ACP is a candidate that buys editor integrations | Podcast; roadmap v0.3 | Phase 6 (spike → ADR when decided) |
| G13 | Sessions, offloads, telemetry, evals, and benchmark trajectories retain sensitive source/output without one lifecycle policy | Security policy; ADR coverage review | Phase 2 (ADR 0021) |
| G14 | Provider adapters share a terminal contract, but admission, capability, routing, context-window authority, retry/billing, and conformance policy are not recorded together | 0008; ADR coverage review | Phase 3 (ADR 0022) |

## Phases

**Phase 0 — record the decisions (this change).** Persist this plan; add
proposed ADRs 0017–0020; update the index; add the `Amended-by: 0020` pointer
to 0009. Exit: docs merged; no code.

**Phase 1 — verify 0011 under fault (complete 2026-08-24).** Confirm
each decision point against tests, adding any missing: crash in every window
(requested→decided, decided→started, started→terminal) resolves per the ADR;
concurrent deciders rejected via the session lock; order-preserving batch
suspension; budget accounting continues across resume; exit 4 and the `--json`
approval rows match 0010's compat rules and the documented exit-code map.
Resolve the approval/compaction boundary in a dated 0011 addendum: v1 refuses
manual and automatic compaction while any approval is pending. It must explain
which execution IDs block compaction and how the CLI reports the remedy; carrying
pending approvals into a new lineage head is deferred until its lifecycle and
budget semantics have separate fault evidence. Exit: a fault-test checklist
mapping each 0011 clause to a passing test, plus tests proving both compaction
paths refuse without mutating the suspended session.
Exit evidence: `docs/adr/evidence/0011-approval-test-map.md`; the dated addendum
is in ADR 0011. The closing change added concurrent-decider, JSON-envelope, and
manual/automatic compaction-refusal coverage, including a trusted-project and
extension provenance regression. `npm run verify` passes on 2026-08-24.

**Phase 2 — small borrowed wins and missing data policy (parallel with Phase 1).**
(a) **Complete 2026-08-24 — ADR 0020:** pricing loader (explicit path → fresh cache → fetch → stale cache
→ empty; never fails; tokens persist even when cost is unset), USD in the
per-turn ledger, `--usage`, `--audit`, and eval artifacts; `RunBudget` gains
optional `maxSpendUSD` with stop reason `spend`. "Hard ceiling" means the loop
reserves a conservative upper-bound request cost before provider dispatch,
using a tokenizer-safe upper bound for serialized input, the enforced output
cap, uncached rates, and every billable retry. If no safe bound or price exists,
a spend-capped run refuses to start; actual reported usage reconciles the
reservation after completion. Without a cap, unknown/stale pricing leaves USD
unset without affecting token accounting. Every cost row records the pricing
source, revision/hash, currency, and effective time. Tests: table parse, cache
TTL, degrade paths, provenance, reservation refusal, ceiling trip, retries, and
unpriceable+cap error.
Exit evidence: `docs/adr/evidence/0020-pricing-test-map.md`; USD is request-linked
in the journal, unknown cost is never represented as zero, and `npm run verify`
passes on the delivery tree.
(b) Secret-access telemetry: add 0013 metadata-only events when a provider
credential is attached and when sanitized child-environment policy excludes
credential-shaped variables. Events contain provider/policy class and counts,
never environment-variable names, headers, paths, or values; whole-event
redaction tests prove this boundary.
(c) Bounded graceful drain: SIGTERM stops admission of new turns, grants the
in-flight operation a configured grace period, then aborts it. Cooperative work
may finish normally; otherwise provider/tool outcomes are journaled
`canceled`/`outcome_unknown` as appropriate and the process exits with its
semantic code. Because an in-process synchronous extension can block Node's
event loop and prevent its own timer from firing, the hard kill deadline is
owned by a small supervisor process outside the agent process; the child owns
graceful journaling, the supervisor owns eventual termination. Tests cover each
lifecycle window, a hanging client/tool/observer, and an event-loop-blocking
fixture that proves the supervisor deadline.
(d) Accept ADR 0021, the artifact-lifecycle contract covering sessions, workspace offloads,
telemetry, evals, and benchmark trajectories: data classification, owner-only
permissions, default locations, retention/cleanup, export/redaction rules,
encryption non-goals, and behavior when a workspace is version-controlled.
Est. ~1 week combined.

**Phase 3 — adoption and pre-publication gates (ADR 0019).** License chosen by owner (precondition,
not automatable — everything public queues behind it). Public package names,
npm publish with provenance, changelog. The journal schema marker is already
implemented; publish its policy: current shape, additive changes,
breaking-version bumps, compatibility fixtures, and migration notes. Supported
matrix (macOS/Linux, Node ≥ 20.11) published. Install ergonomics: `npx` path or
install script plus `pi doctor` (checks node version, keys present, write
permissions, provider reachability). Exit: a stranger reaches a completed
`pi -p` run from the README in under five minutes on a clean machine.

Before any public package or tag, pull forward the safety half of Phase 6:
property/corpus tests for SSE parsing, session-tail recovery, journal replay,
and argument validation, with committed seeds and minimized regression cases.
Accept ADR 0022, the provider-capability contract defining adapter admission, supported
features, model/context-window authority, profile/alias resolution,
retry-after-response and billing rules, usage normalization, and the
conformance suite required before a provider enters the support matrix.
Exit additionally requires these adversarial suites green on every supported
OS/runtime matrix leg. Est. ~1 week of engineering; license on owner's clock.

**Phase 4 — sandbox executor (ADR 0018).** `SandboxExecutor` behind the
existing tool-execution boundary with narrow verbs: `acquire(image) → id`,
`exec(id, cmd, limits) → output`, `release(id)`; `snapshot` deferred to v2.
Docker provider only; the seam designed so Firecracker/remote providers are
additive. Non-negotiables learned from the Exo study: session store, journal,
config, and credentials are **never inside the sandbox mount** (their event log
is rw-mounted into the agent's sandbox in the canonical setup — the failure
piko must make structurally impossible); workspace only; egress default-deny
with allowlist; 0009 budgets enforced loop-side regardless of executor.
Contained spawn: headless children (0004) execute inside sandboxes, restoring a
delegation path in the contained default and closing the 0004/0006 gap (G8).
Egress acceptance is behavioral, not configuration-based: tests exercise DNS,
IPv4, IPv6, redirects, and direct-IP access against allowed and denied canary
endpoints on Linux and macOS Docker environments. The provider must document
rootless/desktop limitations and fail closed when it cannot enforce policy.
Exit: fault tests for mount containment, egress deny, budget enforcement
through the executor; child spawn works with host bash disabled; session,
journal, config, and credential paths are proven absent from container mounts.
Est. 2–3 weeks.

**Phase 5 — `pi improve` MVP (ADR 0017).** External controller, not core.
Scope v1: policy assets only — skills, prompt templates, config, guard/
compaction thresholds. Loop: propose (model edits assets in a workspace clone,
guided by the new `docs/SELF.md` self-map) → prove (`check-budget`, fault
tests, eval suite; fitness = **cost per completed task in USD** at
non-inferior pass rate, from A/B usage artifacts) → park (diff behind an 0011
approval; run exits 4) → promote (commit with an auto-drafted ADR/changelog
stub the human edits). The improve run cannot alter approval policy, budgets,
its own gating, evaluator, task definitions, scoring code, or baseline artifacts
(0011 provenance rules). The controller verifies those inputs from a separate,
read-only checkout by committed hashes.

Promotion statistics are pre-registered before the first candidate is run:
at least five independent repetitions per task and arm, at least 100 paired
task-trials per arm, fixed model/sampling/budget/container inputs, and a held-out
task set never exposed to the proposer. A paired 95% bootstrap interval for
pass-rate delta must have a lower bound of at least -5 percentage points; the
point estimate for USD cost per completed task must improve by at least 10%,
and the 95% interval for its ratio must remain below 1.0. Timeouts, verifier
failures, and missing usage are failures, never exclusions. An unpriced trial
invalidates the comparison and blocks promotion because the declared fitness
function cannot be computed.
The thresholds may be superseded only by a new ADR written before observing
candidate results. Canary-on-resume remains optional for v1.

Trusted local development may begin after Phases 1 and 2a, but a public-facing
release of `pi improve` also depends on Phase 4's sandbox executor. Exit: one
real, measured, approved self-improvement merged end-to-end with raw artifacts,
the pre-registration, and the human-edited ADR — the demo artifact for the
flagship story. Est. 2–3 weeks.

**Phase 6 — reach and post-publication hardening.** The safety-critical
property/corpus baseline moved into Phase 3; this phase expands it with longer
chaos/concurrency campaigns and provider corpora collected from real compatible
endpoints. ACP spike: drive pi from an ACP client; decide adopt/defer; ADR lands
with the decision. Harbor benchmark run published with raw trajectories,
artifact-lifecycle compliance, pricing-table provenance, and cost per completed
task. Est. 2 weeks.

## Sequencing and risks

Dependencies: the open v0.2.0 human-gate decision (tag held pending the claims-audit labeling call) sequences before Phase 3's public steps. Trusted Phase 5 development needs Phases 1 (approvals) and 2a (fitness in USD), plus the pre-registered eval expansion required by 0017 decision 5; public Phase 5 additionally needs Phase 4. Phase 4 is independent after Phase 1 and should overlap Phase 3; Phase 3 publication waits for its pulled-forward adversarial suites. The license gates only *publishing*, not any engineering. Total: roughly two quarters at current pace, matching the pivot memo.

Risks worth writing down now: eval quality becomes the ceiling on `pi improve`
(a weak suite promotes weak changes — curating evals is product work from
Phase 5 on); the pricing DB is an external dependency (cached and degradable
by design; spend caps are the only feature that hard-requires it, and conservative
reservation may reject runs whose expected spend would have fit); retained
artifacts are sensitive data even when owner-only and gitignored; auto-drafted
ADR stubs invite rubber-stamping (the human edit is part of the promotion
contract, not a formality); and scope creep toward Exo's lanes — gateway
adapters, teleportation, runtime core self-editing — is named out of scope in
0017/0018 so drift has to argue with a record.
