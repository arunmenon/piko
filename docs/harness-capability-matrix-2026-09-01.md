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
mini-swe-agent); C = public docs only, unverified (DeepSeek).

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
