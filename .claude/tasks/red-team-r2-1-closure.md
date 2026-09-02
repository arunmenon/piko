# Red-team plan R2.1: closure patch from the R2 review (opened 2026-09-02)

Source: docs/reviews/2026-09-02-r2-review.md (minimum patch set, items 1-10).

- [ ] 1. Digest never runs before tool validation, budget, approval, or abort; git hardened; process group and deadline safe; regressions added
- [ ] 2. Extension pins: hash bound to imported bytes or contract narrowed to the entry module; ADR 0012 corrected
- [ ] 3. expected_sha256 downgraded to a stale-at-check diagnostic; hashing bounded; ADR 0007 corrected
- [x] 4. Repair plus journal_repaired row is one durable operation; crash regression added; ADR 0015 corrected
- [ ] 5. JSON contract row independent of agent events; run_error on depth and suspension paths; ADR 0010 corrected
- [ ] 6. ADR 0022 tests drive Tool.execute through named swap barriers; evidence map corrected
- [x] 7. Cache reuse claim qualified for thinking; model-aware cache minima with unknown as unknown
- [x] 8. Rehydrated paths encoded as untrusted data
- [ ] 9. Eval marker accepts both spellings; spend formatting preserves the inequality; protected-path case folding follows the filesystem
- [ ] 10. Six overclaims corrected in ADRs, CHANGELOG, README
- [ ] 11. Re-review against the R2.1 tree; report committed
