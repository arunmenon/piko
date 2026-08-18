# piko roadmap

Derived from the Aug 2026 competitive study and piko's own measured benchmarks.
Ordered by evidence-weighted value. Each item cites the finding that justifies it.

## P0 — identity-defining

### 1. Flail-capping (doom-loop detection)
The single most valuable unbuilt feature. Evidence: our own benchmark lost 231k
tokens to one failed grind; doom-loop token burn is the shared top complaint across
Claude Code and Codex communities (up to enterprise-budget scale); no harness ships
a real answer. Design sketch: track consecutive failed tool results and absence of
file-state progress; after N stalled rounds inject a one-line "step back or stop"
nudge; after M, end the turn with a partial-result report. Saves tokens, cannot hurt
winnable tasks, and differentiates in the one regime where lean currently loses.

### 2. Cost-per-completed-task as the headline metric
The caching-inversion finding demotes prefix size to a philosophy signal: sub-1k
prefixes often sit below provider cache floors (1,024 tokens on Sonnet 5), while big
cached prefixes bill at 0.1x from turn two. The mechanism that saves money is
per-turn working set (Databricks: 3x; openbench: 37.6k vs 117k tokens/solve).
Action: extend bench/ into a reproducible model-held-constant comparison (openbench
style), publish methodology + per-task data, and reframe README metrics around
tokens-per-solved-task. The field's biggest deficit is honest harness comparisons —
publishing ours is both credibility and contribution.

### 3. Official Terminal-Bench 2.x submission via Harbor
No lean harness has an official entry — upstream pi never submitted (its adapter has
been dormant since Dec 2025). Port bench/ to the Harbor framework, run TB 2.1 under
official constraints, submit. Even a mid-table score with a verifiable public number
is a first for the segment. Requires a frontier-model key for a competitive score
(leaderboard runs cost roughly $250–600).

## P1 — durability and positioning

### 4. Cache-floor investigation
Our ~557-token fixed prefix cannot be cached on models with a 1,024-token minimum
(Sonnet 5, most OpenAI models). Measure the real effect; if long sessions justify
it, consider an opt-in that folds the skills index or a stable pad into the prefix
to cross the floor. Do not give up the small prefix by default — first turns, short
sessions, and fleet fan-outs (many cold starts) are where lean wins most.

### 5. ACP support
The Agent Client Protocol (25+ agents, JetBrains/Zed native) is the cheap path onto
the editor surface without building IDE plugins. Fits the headless architecture.

### 6. Single-binary distribution
The study identified single-binary minimal + OSI license as an unclaimed axis (pi
and piko are both Node). `bun build --compile` gets a single executable from the
existing codebase for near-zero effort; full Go/Rust rewrite is not warranted.

### 7. npm publish + install docs
piko is npm-link-only today. Publish @piko scoped packages; the 64KB bundled build
already proves the packaging story.

## P2 — expansion, driven by use

### 8. Meta-harness backend contract
Enterprises are commoditizing harnesses behind meta-layers (Databricks Omnigent,
Orca — which already lists upstream pi). Document and test piko's headless contract
(exit codes, stdout purity, --usage JSON) as a stable interface; consider a JSON
event-stream mode like pi's RPC mode.

### 9. MCP-proxy extension (only if needed)
Never load MCP schemas into context. If integrations become necessary, adopt the
pi-mcp-adapter pattern: one ~200-token proxy tool that fetches schemas on demand.

### 10. Daily-driver mileage
The roadmap beyond this point should come from real use, not analysis. Upstream pi
got good through daily friction; the same applies here.

## Explicit non-goals (unchanged, evidence reaffirmed)

Permission prompts (users alias them away; sandbox instead), built-in sub-agent
orchestration (headless self-spawn is the context-firewall benchmarks reward),
MCP-in-core, planning/todo modes, competing with OpenCode for mass-market mindshare.
