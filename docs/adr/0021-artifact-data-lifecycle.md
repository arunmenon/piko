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
- Sensitive-content handling is per class, not uniform (owner review
  2026-09-02): telemetry is structurally redacted at write time (0013/0016);
  session journals and offloads are owner-only (0600) and DO retain full
  prompts, tool arguments, and tool results in plaintext by design, so they
  are never publishable as-is; publishable benchmark artifacts (ledgers,
  trajectories) require explicit sanitization before commit.
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


## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Holistic Agent Leaderboard", Kapoor et al., ICLR 2026,
  arXiv 2510.11977. Inspecting 2.5B tokens of released logs revealed shortcuts
  invisible in aggregate scores, including agents searching for benchmark
  answers; the case for committed per-trial artifacts.
- corroborates: "The Leaderboard Illusion", Singh et al., NeurIPS 2025,
  arXiv 2504.20879. Private testing and selective disclosure inflate scores by
  up to 112% relative, the case for the development and held-out firewall.
- corroborates: "Terminal-Bench", Merrill et al., arXiv 2601.11868, 2026. At
  least five trials per pair with confidence intervals, plus trajectories for
  passing trials, is the published bar these artifacts feed.
- challenges: "Efficient Benchmarking of AI Agents", Ndzomga et al.,
  arXiv 2603.23749, 2026. Ad-hoc task subsets show high variance and rankings
  survive only under principled selection, a warning about the ten-task
  development set this lifecycle preserves as evidence.

## Retention classes and defaults (drafted 2026-09-02 for ratification)

| Class | Default retention | Deletion | Notes |
|---|---|---|---|
| Session journals and lineage files | Indefinite, owner-only (0600) | Explicit only: a future `pi doctor sessions --prune <id>` with confirmation, journaled | Evidence-grade for audits; never deleted by scratch cleanup |
| Workspace offloads | With their session | Same act as the session | Contain task output; treated as sensitive |
| Telemetry JSONL | 30 days | Explicit or scheduled prune, logged | Redacted at write time (0013/0016); retention configurable per sink |
| Benchmark run directories | Ephemeral by default | Any time | Never the sole home of anything evidence-grade; ledgers and manifests are committed |
| Committed benchmark artifacts and manifests | Permanent | Never | The evidence tier; regenerated only from committed inputs |
| Review reports and adjudications | Permanent | Never | Provenance for maturity claims |

"Permanent" and "never" above mean no scheduled or incidental deletion; they
do not override deletion obligations. An erasure request, a legal hold's
release, or a discovered secret in a committed artifact is a documented
deletion act (history rewrite or redaction commit with a dated note), and the
role is named: the owner, or an operator the owner delegates, performs the
deletion, and each deletion is journaled where a journal exists and otherwise
recorded with a dated note in the same change. (Named per R0-8 of
docs/red-team-remediation-plan-2026-09.md; a recommendation pending owner
ratification with the rest of this record.)

Ratification may accept these defaults, or accept the record as principles
only with defaults deferred; the owner chooses, and the status line says which.
