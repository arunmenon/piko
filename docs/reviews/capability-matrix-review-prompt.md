# Review prompt: capability matrix report and methodology (Codex)

Paste everything below this line into Codex, run from the repo root.

---

You are reviewing a competitive capability study for both factual accuracy
and methodological soundness. The document is
docs/reviews/capability-matrix-content-2026-09-01.md: a matrix comparing
the piko harness against twelve peer harnesses across eleven capability
dimensions, with per-row evidence grades (A = source-read/benchmarked by
this project, B = registry-mined + vendor docs, C = public docs only). The
authors are the piko team, which means the single most likely failure mode
is self-serving bias wearing an honesty costume. Your job is to find where
the study would not survive a hostile reader — a competitor's DevRel team,
a skeptical CTO, or a methodologist.

Review in two passes.

## Pass 1 — Methodology

1. Census and selection. The field comes from the Harbor benchmark
   framework's agent registry (41 harnesses) filtered to 13. Is that frame
   biased (Harbor registers benchmark-runnable agents; does that exclude
   classes of competitor?), and are the tier assignments and cuts
   (Cursor, Copilot, Cline, goose, Qwen, Kimi, Devin cut as "redundant")
   defensible or convenient?
2. Dimension design. Eleven dimensions, four of which piko "wins." Are the
   dimensions MECE, are any gerrymandered so piko's strengths count as
   multiple columns (e.g. is "context footprint discipline" separable from
   "context management"? is "benchmark evidence transparency" a capability
   or a practice?), and which dimensions that matter to real users are
   missing (e.g. editing quality, latency, IDE integration, language
   support, price of the harness itself)?
3. Grading system. Three glyphs plus "?" with no rubric per cell. Identify
   cells where the grade is asserted without stated criteria, and say what
   a reproducible rubric would require.
4. Evidence-grade honesty. The A-grade rows cite this repository. Check
   that the cited artifacts exist and support the specific cells:
   docs/exo-study-2026-08-24.md for every Exo cell,
   docs/benchmarks/2026-08-24-grid and 2026-08-25-tb20 for Terminus and
   piko benchmark cells, docs/adr for every piko cell. A piko cell graded
   "strong" whose ADR is proposed rather than accepted, or whose
   implementation is absent, is a finding.
5. The stated limitation (no fresh web sweep; knowledge as of Aug-Sep
   2026). Is it quarantined properly, or do B-grade cells make claims that
   required current verification?

## Pass 2 — Cell and prose accuracy

6. Verify every piko cell against the repo the way a hostile reader would:
   isolation marked partial (is that generous given ADR 0022 is accepted
   but unimplemented and the race is reproduced?), approvals marked strong
   (does 0011's implementation support every claim?), cost enforcement
   marked strong-and-unique (does the OpenHands per-task budget make
   "only harness" wording anywhere in the document false?), benchmark
   evidence marked strong (is a 33/89 cost-bounded floor compatible with a
   "strong" grade under the study's own grading language?).
7. Verify peer cells that a competitor could rebut with public
   documentation, especially: Claude Code durability marked partial,
   Codex context marked partial, OpenCode isolation marked absent, Aider
   automation marked partial, Gemini provider breadth marked absent. For
   each rebuttable cell, state the public evidence a competitor would
   cite.
8. Check internal consistency: matrix glyphs vs the prose in sections 4
   and 5 (a harness described as "far ahead" should not share a glyph tier
   with piko anywhere that matters), win/draw/loss counts vs the actual
   matrix, and the verdict paragraph vs both.
9. Check the candidate notes (section 5) for claims that exceed the row's
   evidence grade — anything asserted about a B-grade harness that only an
   A-grade read could establish, and anything about DeepSeek beyond
   "unverified."

Classify each finding: WRONG, OVERSTATED, UNSUPPORTED, STALE, BIASED-FRAME
(methodology), or MISSING-DIMENSION. Cite the repo file or the public
source a rebuttal would use. Do not review style.

Output, in order: (1) verdict — is the matrix publishable as-is, yes/no,
one sentence; (2) methodology findings; (3) cell/prose findings ranked by
severity; (4) the three changes that would most improve the study's
credibility, with concrete replacement wording or rubric.
