# Harness capability matrix (2026-09-01)

Published artifact: https://claude.ai/code/artifact/3d61ce9a-7fac-4fb3-9b1f-39586e554c4b
(private until shared; updates in place on republish)

Competitive capability study: piko vs 12 leading agentic harnesses across
11 dimensions, every cell carrying an evidence grade.

Census: Harbor's agent registry (41 harnesses; adapter flags mined).
Candidates: Claude Code, Codex CLI, Gemini CLI, OpenCode (production tier);
OpenHands, Aider (open frameworks); pi-mono, Exo, Terminus-2,
mini-swe-agent (lean/lineage); DeepSeek harness, fusion-harness (emerging).

Dimensions: context management, cost enforcement, tools/extensibility,
sub-agents, approvals, isolation, session durability, automation contract,
provider breadth, benchmark evidence, maturity.

Evidence grades: A = source-read and/or benchmarked by this project
(Terminus-2, Exo, fusion-harness, pi-mono); B = Harbor-adapter-mined +
vendor docs, fact-check-corrected (production tier, OpenHands, Aider,
mini-swe-agent); C = public docs only, unverified (DeepSeek at draft time; upgraded to B by the grounding pass recorded below).

Verdict recorded in the artifact: piko wins cost enforcement, session
durability, benchmark-evidence transparency, and footprint discipline;
draws on approvals, automation contract, and context management; loses on
isolation (largest deficit; ADR 0022 unimplemented, 0018 proposed),
sub-agents, ecosystem interop (no MCP by ADR 0002 trade), maturity, and
proven capability ceiling (official-suite number is a cost-bounded floor).
Strategic reading: not a Claude Code challenger; the
governance-and-economics specialist whose position improves most by
landing 0022/0018 and publishing the frontier rerun.

Limitation: compiled without a fresh web sweep (session search budget
exhausted); external claims reflect session research and public docs as of
Aug-Sep 2026. DeepSeek cells explicitly unverified; a ~$2 benchmark arm
through the existing adapter would convert that row to measured.

## Grounding pass (2026-09-01, same day)

The draft matrix was verified by a 13-agent workflow (run wf_eb2809e6-9a2):
one adversarial verifier per harness row, primary sources only, no-guess
rule. 38 of 143 cells were revised, including two of piko's own downward
(isolation partial -> absent; benchmark evidence strong -> partial).
Full per-cell verdicts with sources:
docs/reviews/capability-matrix-grounding-2026-09-01.json.

Verdict rewritten accordingly: piko tops no column alone at glyph
resolution. Its surviving edge is mechanism depth (reservation-based spend
enforcement (per turn today; session-scoped under proposed ADR 0026); lock-enforced session integrity vs Claude
Code's documented double-resume interleaving; the CI-ratcheted footprint
and evidence-governance loop). Key strategic finding: the DeepSeek harness
is a governance competitor in piko's own specialty (fail-closed approvals,
append-only session log, OS sandbox backends), not a price story.
Claude Code (print-mode --max-budget-usd) and mini-swe-agent (enforced
cost_limit) both ship hard dollar caps: the "only harness with a dollar
ceiling" claim is retired. Isolation (0022/0018) is now assessed as
existential rather than roadmap.

## Independent replication and adjudication (2026-09-01, same day)

A parallel blind investigation (protocol:
capability-matrix-parallel-investigation-prompt.md) agreed on 90/143 cells
(62.9%) and killed the residual exclusivity claims: OpenHands documents a
per-task dollar stop (MAX_BUDGET_PER_TASK) and process-safe locked
event-log appends — both re-verified by us against its documentation
before acceptance. Adjudication record:
docs/reviews/2026-09-01-capability-matrix-replication.md (accepted
findings, rejected findings with reasons, adopted rubric splits for cost
enforcement and durability). Published matrix regraded post-adjudication;
piko's surviving differentiation is stated as composition (pre-dispatch
spend reservation + durable lifecycle accounting + lock-capability
sessions + stale-lock recovery + evidence ratchets in one runtime), with
piko sub-agents regraded absent -> partial and several peer cells moved
in both directions under the tightened rubric.
