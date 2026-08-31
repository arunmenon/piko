# Independent adversarial review (received 2026-08-25)

Model-driven adversarial code review and maturity assessment, run with
docs/reviews/codex-review-prompt.md against commit d7c5157. Received from
the operator; recorded here as provenance for the maturity score cited in
project materials. Lightly reformatted from the original paste; findings
preserved with their classifications and locations. Disposition: the three
major findings drove ADRs 0022-0024; six re-review defects on the first
0023/0024 implementation were subsequently closed (commit bc34217) with the
reviewer's reproductions as permanent tests; ADR 0022 remains open.

## Verification summary
npm install clean; build pass; 240/240 TS tests; bench 9 pass 3 skip;
budget gate ~843/1000 at time of review; lockfile drift noted (workspace
metadata 0.1.0 vs manifests 0.2.0).

## Findings (as ranked by the reviewer)
1. Major CONFIRMED — Workspace containment has an exploitable
   parent-symlink TOCTOU (filesystem.ts; write.ts). Reproduced escape:
   {"escaped":true,"errors":11}. Fix: descriptor-relative operations.
2. Major CONFIRMED — Public session API does not enforce single-writer:
   Session.open() returns mutable session without lock; double-open
   interleaving corrupted a journal (SessionCorruptionError).
3. Major CONFIRMED — A stale lock silently hides the newest conversation:
   pi -c filters locked sessions before ranking; silent older-session
   fallback; no recovery workflow.
4. Major CONFIRMED — Host-bash env sanitization is not a credential
   boundary (parent process env recoverable via ps from child).
5. Major CONFIRMED — Telemetry privacy contract not enforced "by
   construction" (full allowlist exported; apiKeyEnv unrestricted string).
6. Major CONFIRMED — Benchmark collection drops infrastructure failures
   from denominators (trial_dirs yields only dirs with results.json).
7. Major CONFIRMED — Published benchmark evidence not independently
   reproducible (ephemeral paths; no hashes; example-only manifest).
8. Major CONFIRMED — Test suite misses process/integration boundaries
   (five highest-value missing tests listed; Harbor tests skip-only).
9. Major PLAUSIBLE — SIGTERM cannot guarantee graceful bounded shutdown.
10. Minor CONFIRMED — Pricing timeout does not bound custom response body.
11. Minor CONFIRMED — Partial price coverage understates cost per solved
    trial.
12. Minor CONFIRMED — Benchmark usage rows typed but unauthenticated.
13. Minor CONFIRMED — Trusted-project skill discovery unbounded scan.
14. Minor CONFIRMED — Credential-name classifier matches MONKEY/HOTKEY.
15. Minor CONFIRMED — Keyless requests emit false credential.attach.
16. Minor CONFIRMED — Committed lockfile workspace metadata stale.

## Maturity scorecard (reviewer's)
Correctness and concurrency 3/5 · Security and containment 2/5 ·
Financial correctness 3/5 · Failure honesty 3/5 · Test quality 3/5 ·
Docs and ADR integrity 2/5 · Benchmark methodology 2/5 ·
Operational maturity 2/5. Overall: 2.6/5 — late prototype / early alpha,
not a production framework. Weighting: correctness 20%, security 20%,
failure honesty 15%, financial correctness 10%, tests 10%, docs 10%,
operations 10%, benchmarks 5%.

## Remediation status at recording time (2026-08-31)
Findings 2, 3 closed via ADRs 0023/0024 (implemented, hardened after a
six-defect re-review; reproductions are permanent tests). Findings 5, 6,
10, 11, 13, 14, 15, 16 closed in the quick-wins tranche. Finding 1 is ADR
0022: ratified with owner amendments, N-API spike approved, NOT yet
implemented. Findings 4, 8, 9, 12 and parts of 7 remain open.
