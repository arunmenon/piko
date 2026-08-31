# Review prompt: CTO overview fact-check (Codex)

Paste everything below this line into Codex, run from the repo root.

---

You are fact-checking a marketing-facing executive document against the
repository that claims to back it. The document is
docs/reviews/cto-overview-content-2026-08-31.md. Your job is to find every
statement in it that the repository does not support, overstates, or states
more confidently than the evidence allows. The author's reputation depends
on this document surviving a hostile technical reader; your reputation
depends on finding what such a reader would find.

Ground rules:

1. Verify against the repo, not intuition. Benchmark figures must match
   docs/benchmarks/2026-08-24-grid and docs/benchmarks/2026-08-25-tb20
   (manifests and results.json). ADR rows must match docs/adr/README.md and
   the individual ADR files, including status (accepted / proposed /
   reserved) and what each actually decides. Enforcement claims ("the build
   fails if...", "the runtime blocks...") must match the code:
   scripts/check-budget.ts, packages/core/src/pricing.ts,
   packages/core/src/session.ts, packages/cli/src/main.ts, bench/routing.py.
2. Classify each finding: WRONG (contradicted by the repo), OVERSTATED
   (true but stronger than the evidence), UNSUPPORTED (no artifact backs
   it), or STALE (was true, repo has moved). Cite file and line for the
   contradicting or missing evidence.
3. Check the competitive table's external claims (Claude Code, Codex CLI,
   Terminus, DeepSeek, fusion-class) for fairness: anything a competitor
   could publicly rebut with their documentation is a finding.
4. Check internal consistency: numbers reused across sections must agree
   with each other and with the source artifacts (solve counts, dollar
   figures, percentages, ADR counts and statuses).
5. Do not review style or persuasion. Only accuracy, support, and fairness.

Output, in order: (1) verdict — would this document survive a hostile
technical reader, yes/no with one sentence; (2) findings ranked by severity
with classification and evidence pointers; (3) the three sentences you would
edit first, with suggested replacement wording that stays accurate.
