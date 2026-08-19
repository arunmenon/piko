# Release checklist: evidence-gated cut of a piko version; no step is skippable without a written waiver

> Distilled from praxis's production-release workflow and phase-gate model
> (https://github.com/jeet129/praxis, MIT), sized for this repo. The governing rule:
> a release step advances unattended only when its exit is machine-verifiable;
> judgment calls are human gates and stop the line.

## Machine-verifiable gates (run all; attach output as evidence)

1. `npm test` passes on a clean checkout (not an incremental tree).
2. `npm run check-budget` within budget.
3. `npm run eval` pass rate at or above the previous release's recorded rate, same model.
4. Fault suites pass: truncation, containment/symlink escape, crash-resume, budget limits.
5. No uncommitted changes; version bumped consistently across all package.json files.
6. CHANGELOG.md entry exists for the version, listing breaking changes explicitly.

## Human gates (require the owner's explicit sign-off in the release notes)

7. Security posture: any new tool, provider, or trust-boundary change since the last
   release has a written security note (what an attacker gains, what contains it).
8. Claims audit: every performance/cost number in README and docs is reproducible
   from committed artifacts, or is labeled exploratory. No unverifiable claims ship.
9. Known-issues honesty: the release notes state what is NOT hardened (platforms,
   providers, limits) rather than staying silent.

## Evidence pack (commit under docs/releases/<version>/)

- Test, budget, and eval outputs (raw).
- Benchmark manifest if numbers changed: model, provider, task set, trial count, seeds.
- The waiver list: any gate skipped, why, who accepted the risk.

## Anti-rationalization checks

- "Tests passed yesterday" is not gate 1. Clean checkout or it did not happen.
- "The number is roughly right" fails gate 8. Reproducible or labeled exploratory.
- "Nobody uses feature X" does not waive its gate; write the waiver.
