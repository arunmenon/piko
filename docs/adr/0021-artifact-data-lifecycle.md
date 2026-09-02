# 0021 - Artifact data lifecycle

Status: proposed (2026-08-31; drafted from plan item G13 and the lost-run incident below, owner ratification pending)
Depends on: 0007, 0013, 0015

## Context

Piko produces durable artifacts in several places with no single policy
governing what must be retained, for how long, and what counts as evidence:
session journals and their offloads, telemetry files, benchmark run
directories, and the comparison artifacts derived from them. The plan's gap
register (G13) has tracked this since the post-Exo review.

The cost of the gap is no longer hypothetical. On 2026-08-25 a benchmark
rerun recorded a headline-grade result (25/30 on the development suite) in
prose notes, but its per-trial comparison artifact was never committed and
the run directory was later lost with a session scratchpad. The numbers
survive only as narrative and had to be formally demoted from evidence
(docs/benchmarks/2026-08-24-grid/rerun-and-heldout.md, data-lifecycle
note). Separately, benchmark evidence retains task outputs and transcripts
that may hold sensitive content, with retention decided ad hoc per run.

## Decision (proposed)

One written lifecycle contract covering every artifact class:

- Evidence-grade artifacts (benchmark per-trial ledgers, comparison JSON,
  run manifests) are committed in the same change that cites their numbers
  anywhere. A number whose artifact is not committed is narrative, never
  evidence — the rule applied retroactively to the 2026-08-25 incident.
- Session journals, offloads, and telemetry get named retention classes
  with defaults and an explicit owner override; deletion is an explicit,
  logged act, never a side effect of scratch cleanup.
- Sensitive-content handling for retained transcripts follows 0013/0016
  posture: values redacted or excluded at write time, not at review time.
- Benchmark run directories are treated as ephemeral BY DEFAULT and
  therefore must never be the sole home of anything evidence-grade.

## Consequences

- Restores a one-to-one match between cited numbers and committed
  artifacts, closing the class of loss that already cost one result.
- Adds a small commit-discipline burden to benchmark work; the
  manifest-driven accounting in bench/compare_runs.py already produces the
  artifacts, so the cost is remembering to commit them, enforced by the
  rule above.
- Full policy text, retention periods, and any tooling (a lifecycle check
  in CI) are implementation work that follows ratification.


## Retention classes and defaults (drafted 2026-09-02 for ratification)

| Class | Default retention | Deletion | Notes |
|---|---|---|---|
| Session journals and lineage files | Indefinite, owner-only (0600) | Explicit only: a future `pi doctor sessions --prune <id>` with confirmation, journaled | Evidence-grade for audits; never deleted by scratch cleanup |
| Workspace offloads | With their session | Same act as the session | Contain task output; treated as sensitive |
| Telemetry JSONL | 30 days | Explicit or scheduled prune, logged | Redacted at write time (0013/0016); retention configurable per sink |
| Benchmark run directories | Ephemeral by default | Any time | Never the sole home of anything evidence-grade; ledgers and manifests are committed |
| Committed benchmark artifacts and manifests | Permanent | Never | The evidence tier; regenerated only from committed inputs |
| Review reports and adjudications | Permanent | Never | Provenance for maturity claims |

Ratification may accept these defaults, or accept the record as principles
only with defaults deferred; the owner chooses, and the status line says which.
