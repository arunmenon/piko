# Red-team plan R2: runtime fixes not gated on T0 (opened 2026-09-02)

Source: docs/red-team-remediation-plan-2026-09.md section 6. Owner approved ("Go ahead").
Each item: at most five files, its test, a dated addendum to its ADR in the same change.

- [x] 1. 0006 protected-path deny list
- [x] 2. 0020 legible ceiling: reserved, spent, ceiling, effective at every spend stop; --usage ceiling
- [x] 3. 0005 loop classifier: all outcomes hashed, relaxed success thresholds, alternating pairs
- [x] 4. 0004 --parent-run and PI_DEPTH / --max-depth
- [x] 5. 0012 extension sha256 pins and extension_loaded journal row
- [x] 6. 0015 journal_repaired row; doctor lists repaired sessions
- [x] 7. 0009 wording: run budget to turn budget in user-visible text
- [x] 8. 0001 two-number check-budget with per-provider minimum cacheable size
- [x] 9. 0014 measurement: eligibility line, model-switch warning, compare_runs hit-rate column, TTL option
- [x] 10. 0003 compaction: summarizer on the cached prefix, rehydration list, compaction counter
- [x] 11. 0010 capabilities array in the first JSON row
- [x] 12. 0007 idempotency: write expected-hash precondition, bash workspace hash, replay conformance test
- [x] 13. 0022 acceptance tests written as todo, failing on the current tree
- [ ] 14. Re-issue the review prompt against the R2 tree; commit the report
