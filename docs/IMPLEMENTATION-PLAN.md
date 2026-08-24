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
human decision. The core loop stays frozen; every phase lands with its ADR in
the same change, per `docs/adr/README.md`.

## Gap register

| # | Gap | Source | Addressed in |
|---|-----|--------|--------------|
| G1 | Durable approvals (0011) implemented in the v0.2.0 tranche — remaining risk is fault coverage of the crash windows | ADR review; tree @ e07affd | Phase 1 (verification) |
| G2 | Costs tracked as token proxies only; no dollar accounting, no spend ceiling | 0009 consequences; Exo `cost` crate proves the pattern | Phase 2 (ADR 0020) |
| G3 | Secret *usage* is prevented but not observable; no access-pattern events | Podcast (host); 0013 substrate exists | Phase 2 |
| G4 | No graceful drain on SIGTERM; run status can end untidy under supervisors | Exo guardian pattern | Phase 2 |
| G5 | Adoption blockers: no license, no published packages, no quickstart, no doctor | Roadmap v1.0; goal choice | Phase 3 (ADR 0019) |
| G6 | Journal rows unversioned; compat policy unpublished; 0011 adds row types and forces the decision | 0007 consequences; maturity notes | Phase 3 (ADR 0019) |
| G7 | No OS-level sandbox executor; "run it in Docker yourself" is still documentation | 0006 named next layer; Exo ships providers | Phase 4 (ADR 0018) |
| G8 | Default contained config has no delegation path (sub-agents require `--allow-host-bash`) | 0004 addendum | Phase 4 (contained spawn) |
| G9 | No self-improvement loop; market gap: nobody grades self-changes by outcomes | Exo study (liveness-only validation, canary gap admitted) | Phase 5 (ADR 0017) |
| G10 | No curated self-map for improvement runs | Exo `SELF.md` | Phase 5 |
| G11 | Parser robustness asserted (fail-closed) but not adversarially evidenced | v1.0 roadmap line | Phase 6 |
| G12 | RPC surface undecided; ACP is a candidate that buys editor integrations | Podcast; roadmap v0.3 | Phase 6 (spike → ADR when decided) |

## Phases

**Phase 0 — record the decisions (this change).** Persist this plan; add
proposed ADRs 0017–0020; update the index; add the `Amended-by: 0020` pointer
to 0009. Exit: docs merged; no code.

**Phase 1 — verify 0011 under fault (implementation already landed).** Confirm
each decision point against tests, adding any missing: crash in every window
(requested→decided, decided→started, started→terminal) resolves per the ADR;
concurrent deciders rejected via the session lock; order-preserving batch
suspension; budget accounting continues across resume; exit 4 and the `--json`
approval rows match 0010's compat rules and the documented exit-code map.
Exit: a fault-test checklist mapping each 0011 clause to a passing test.
Est. 1-2 days: the 0011 implementation already ships 18 approval tests including the crash windows, and the security review verified the four attack surfaces; the remainder is the clause-to-test mapping plus concurrent-decider and --json-conformance tests.

**Phase 2 — small borrowed wins (parallel with Phase 1).**
(a) ADR 0020: pricing loader (explicit path → fresh cache → fetch → stale cache
→ empty; never fails; tokens persist even when cost is unset), USD in the
per-turn ledger, `--usage`, `--audit`, and eval artifacts; `RunBudget` gains
optional `maxSpendUSD` with stop reason `spend`; setting a spend cap for an
unpriceable model refuses to start (fail-closed). Tests: table parse, cache
TTL, degrade paths, ceiling trip, unpriceable+cap error.
(b) Secret-access telemetry: a 0013 event whenever a credential is attached to
a provider request or the sanitized-env policy strips a variable from a child.
(c) Drain shutdown: SIGTERM finishes the in-flight turn, journals terminal run
status, exits with the normal semantic code; kill-after-timeout. Est. ~1 week
combined.

**Phase 3 — adoption gates (ADR 0019).** License chosen by owner (precondition,
not automatable — everything public queues behind it). Public package names,
npm publish with provenance, changelog. Journal `schemaVersion` field (current
shape = v1; additive minor, breaking = new version + migration note). Supported
matrix (macOS/Linux, Node ≥ 20.11) published. Install ergonomics: `npx` path or
install script plus `pi doctor` (checks node version, keys present, write
permissions, provider reachability). Exit: a stranger reaches a completed
`pi -p` run from the README in under five minutes on a clean machine.
Est. ~1 week of engineering; license on owner's clock.

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
Exit: fault tests for mount containment, egress deny, budget enforcement
through the executor; child spawn works with host bash disabled.
Est. 2–3 weeks.

**Phase 5 — `pi improve` MVP (ADR 0017).** External controller, not core.
Scope v1: policy assets only — skills, prompt templates, config, guard/
compaction thresholds. Loop: propose (model edits assets in a workspace clone,
guided by the new `docs/SELF.md` self-map) → prove (`check-budget`, fault
tests, eval suite; fitness = **cost per completed task in USD** at
non-inferior pass rate, from A/B usage artifacts) → park (diff behind an 0011
approval; run exits 4) → promote (commit with an auto-drafted ADR/changelog
stub the human edits). The improve run cannot alter approval policy, budgets,
or its own gating (0011 provenance rules). Optional canary-on-resume verifier.
Exit: one real, measured, approved self-improvement merged end-to-end; the
demo artifact for the flagship story. Est. 2–3 weeks.

**Phase 6 — hardening and reach.** Property/corpus tests for the SSE parser,
session tail-corruption, journal reader, and tool-argument validator (turns
0008/0015 fail-closed claims into adversarial evidence). ACP spike: drive pi
from an ACP client; decide adopt/defer; ADR lands with the decision. Harbor
benchmark run published with raw trajectories and cost per completed task.
Est. 2 weeks.

## Sequencing and risks

Dependencies: the open v0.2.0 human-gate decision (tag held pending the claims-audit labeling call) sequences before Phase 3's public steps. Phase 5 needs Phases 1 (approvals) and 2a (fitness in USD), plus the eval expansion required by 0017 decision 5;
Phase 4 is independent after Phase 1 and should overlap Phase 3; the license
gates only *publishing*, not any engineering. Total: roughly two quarters at
current pace, matching the pivot memo.

Risks worth writing down now: eval quality becomes the ceiling on `pi improve`
(a weak suite promotes weak changes — curating evals is product work from
Phase 5 on); the pricing DB is an external dependency (cached and degradable
by design; spend caps are the only feature that hard-requires it); auto-drafted
ADR stubs invite rubber-stamping (the human edit is part of the promotion
contract, not a formality); and scope creep toward Exo's lanes — gateway
adapters, teleportation, runtime core self-editing — is named out of scope in
0017/0018 so drift has to argue with a record.
