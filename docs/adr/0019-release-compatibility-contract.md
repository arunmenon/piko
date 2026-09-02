# 0019 — Release and compatibility contract

Status: proposed (2026-08-24)
Depends on: 0007, 0010, 0011

## Context

The maturity notes promise that schemas stay "unstable until a compatibility
policy is published"; the goal of becoming an adopted tool calls that promise
due. 0011 adds journal row types, forcing the versioning decision 0007 listed
as a cost. Packages are private, unpublished, and unlicensed — a stranger
cannot adopt piko today no matter how good the engineering is.

## Decision

1. License: an OSI license, chosen by the owner, is a precondition for every
   public step below. Recorded here as a gate, not made here — it is an
   owner/legal decision.
2. Journal versioning: each session carries a `journal_schema` marker row —
   the mechanism the 0011 implementation introduced; the current shape is
   generation 2. Generation history: 1 is the v0.2 lifecycle rows; 2 adds the
   approval, suspension, and request-linked pricing fields introduced with 0011
   and 0020. Additive row types do not bump the generation and must be
   ignorable by older readers; breaking changes bump the marker and ship with a
   migration note. The
   `--json` stream keeps 0010's rules; the two contracts version
   independently.
3. Packages: published under public names with provenance and a changelog.
   Pre-1.0 semantics stated plainly: 0.x, breaking changes land in minor
   versions and are called out in the changelog — stated instability over
   silent instability.
4. Support matrix: macOS and Linux, Node ≥ 20.11, and the tested provider
   list, published and kept current; anything absent from the matrix is
   unsupported by definition, not by surprise.
5. Install bar: a stranger reaches a completed `pi -p` run from the README in
   under five minutes on a clean machine — an `npx`-able entry point or
   install script plus `pi doctor` (checks runtime version, credentials,
   workspace permissions, provider reachability).

## Consequences

- Adoption becomes possible: the contract tells users what may change and how
  they will find out, which is the actual product of a compatibility policy.
- Costs: version bookkeeping on every journal change; migration notes are now
  part of the definition of done; the five-minute bar is a real CI-tested
  artifact to maintain, not a README aspiration.
- Until the license lands, all of this queues; engineering proceeds, publishing
  waits.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "SoK: Taxonomy of Attacks on Open-Source Software Supply
  Chains", Ladisa et al., IEEE S&P 2023, arXiv 2204.04008. 107 attack vectors
  mapped to 94 real incidents; provenance and integrity controls are the
  safeguards this record's provenance clause names.
- corroborates: "I depended on you and you broke me", Venturini et al., TOSEM
  2023, arXiv 2301.04563. In npm, 44% of manifesting breaking changes arrived in
  minor or patch releases, so stated 0.x instability is honest about a measured
  failure rate rather than a disclaimer.
- challenges: "Analyzing Challenges in Deployment of SLSA", Tamanna et al.,
  arXiv 2409.05014, 2024. Across 1,523 issues in 233 repositories, provenance
  adoption stalls on documentation and tooling gaps; a cost warning for the
  provenance clause, which this record prices as a checkbox.
