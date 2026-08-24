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
   the mechanism the 0011 implementation introduced; the current shape is v1.
   Additive row types bump nothing and must be ignorable by older readers;
   breaking changes bump the marker and ship with a migration note. The
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
