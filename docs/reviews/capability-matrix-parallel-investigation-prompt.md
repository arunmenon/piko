# Parallel investigation prompt: capability matrix (Codex)

Paste everything below this line into Codex, run from the piko repo root.
Codex must have network access for this task.

---

You are running an INDEPENDENT PARALLEL INVESTIGATION, not a review of our
conclusions. A 13-agent workflow already grounded a competitive capability
matrix for the piko coding-agent harness against primary sources; its
output is committed. Your job is to redo the investigation yourself,
blind-first, then diff your findings against ours. Independent replication
is the point: where two investigations agree, the matrix is solid; where
they disagree, at least one of us is wrong, and that is the finding.

## Phase 1 — Blind investigation (do NOT read our results yet)

Do not open docs/reviews/capability-matrix-grounding-2026-09-01.json,
docs/reviews/capability-matrix-content-2026-09-01-r2.md, or
docs/harness-capability-matrix-2026-09-01.md until Phase 3.

Investigate these 13 harnesses across these 11 dimensions:

Harnesses: piko (this repo), Claude Code, Codex CLI, Gemini CLI, OpenCode,
OpenHands, Aider, pi-mono (earendil-works/pi, formerly badlogic/pi-mono),
Exo (exoharness/exo), Terminus-2 (harbor-framework), mini-swe-agent
(SWE-agent org), DeepSeek harness (deepseek-ai), fusion-harness (disler).

Dimensions: (1) context management — compaction/caching/footprint;
(2) cost enforcement — accounting vs hard per-run limits; (3) tools and
extensibility — MCP/plugins/skills; (4) sub-agents/orchestration;
(5) approvals and permission control; (6) isolation and sandboxing at
OS/container level; (7) session durability — resume, crash honesty,
locking; (8) automation contract — headless/JSON/SDK/exit codes;
(9) provider/model breadth; (10) benchmark evidence and transparency;
(11) maturity and adoption.

Rules of evidence:
- Primary sources only: official documentation sites, the project's own
  repository (README, docs/, and source code where public), release/
  changelog pages. Blog posts and third-party comparisons are not
  evidence. For piko, the repo you are standing in is the primary source:
  grade it from docs/adr (respecting each ADR's Status line — proposed or
  accepted-but-unimplemented is not shipped), docs/benchmarks, docs/
  reviews, README.md, and the code itself.
- Grade every cell on this rubric: STRONG = engineered, documented, and
  shipped; PARTIAL = present with real gaps, mode restrictions, or
  config dependence; ABSENT = not offered or out of scope; UNVERIFIED =
  you could not establish it from primary sources. Never guess: a failed
  fetch or missing documentation is UNVERIFIED, not a judgment call.
- Every grade carries its evidence: source URL or repo file, plus the
  specific fact, one sentence. A cell without evidence is UNVERIFIED.
- Be alert to mode restrictions (a capability that exists only in
  headless mode, only behind a flag, only in an experimental tier) —
  grade PARTIAL and say why.

Deliverable of Phase 1: your own 13x11 matrix with a one-line
evidence note per cell.

## Phase 2 — Adversarial spot-checks (still blind)

For five claims that most affect the competitive story, dig one level
deeper than documentation where possible (source code, changelogs):
1. Does any harness besides piko enforce a hard per-run DOLLAR limit, and
   in which modes? (Check at minimum: claude CLI reference for budget
   flags; mini-swe-agent's agent config; OpenHands budget settings.)
2. Which harnesses prevent two concurrent processes from corrupting one
   session's history — locking, not just append-only logs? (Check piko's
   session implementation and tests; any peer documentation on concurrent
   resume behavior.)
3. What OS-level sandboxing does each production-tier harness actually
   enforce by default vs opt-in, and what happens when the sandbox fails
   to start?
4. What does the DeepSeek harness actually ship for approvals, session
   persistence, and sandboxing, per its own reference documentation?
5. What benchmark evidence does each harness PUBLISH about itself (not
   model-card scores) — and does piko's committed benchmark evidence
   (docs/benchmarks/) support the grade you gave its row?

## Phase 3 — Diff against our investigation

Now read docs/reviews/capability-matrix-grounding-2026-09-01.json (our
143 per-cell verdicts with sources) and
docs/reviews/capability-matrix-content-2026-09-01-r2.md (the published
conclusions). Produce a cell-by-cell diff:

- AGREE: same grade, independently reached. No commentary needed.
- DISAGREE-GRADE: different grade. State both grades, both evidence
  trails, and which is better supported — including the possibility that
  YOUR read is the weaker one.
- DISAGREE-EVIDENCE: same grade, but our cited evidence is wrong, stale,
  or does not support the cell (a right answer for a wrong reason is a
  defect in an evidence-graded study).
- OUR-MISS: facts your investigation surfaced that ours never saw.
- YOUR-MISS: cells where our artifact cites primary evidence you failed
  to find — flag these as limits of your own pass.

Also judge the published conclusions (r2 extract, sections 4-5 and the
verdict): does the "piko tops no column alone; edge is mechanism depth"
narrative survive YOUR matrix? Do the three claimed surviving mechanisms
(reservation-based spend enforcement in all modes, lock-enforced session
integrity, the evidence-governance loop) hold up against your Phase 2
spot-checks?

## Output, in order

1. Verdict: does your independent matrix substantially replicate ours —
   yes/no, with the agreement rate (cells matching / 143).
2. Your Phase 1 matrix (compact table, grades only).
3. All DISAGREE and MISS findings, ranked by how much each would change
   the published competitive story, each with both evidence trails.
4. Phase 2 spot-check results, stated plainly.
5. The three sentences in the published study you would change first,
   with replacements.
