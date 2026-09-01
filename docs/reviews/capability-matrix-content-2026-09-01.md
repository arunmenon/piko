# Capability matrix study (artifact content extract, 2026-09-01)

Automated text extraction of the published capability-matrix artifact
(https://claude.ai/code/artifact/3d61ce9a-7fac-4fb3-9b1f-39586e554c4b).
Layout flattened; wording verbatim. Matrix glyphs: filled circle = strong,
half = partial, open = absent, ? = unverified. For external review.

---
**Engineering Strategy · Competitive Capability Study · September 2026 

# Where piko stands: a capability matrix against the leading agentic harnesses 

Thirteen harnesses, eleven capability dimensions, every cell graded by how we know it — from source-level reads and head-to-head benchmarks down to public documentation. Piko's row includes the columns it loses. 

**1 · Method and evidence 

## How each cell earned its mark 

The field census comes from the Harbor benchmark framework's agent registry — 41 registered harnesses, the closest thing this industry has to an official roster. Every candidate row carries an evidence grade: 

- A — source-read and/or benchmarked by us. Terminus-2 (source + three benchmark arms head-to-head), Exo (pinned source study with provenance chain), fusion-harness (source review, tests run), pi-mono (adapter internals + its extension ecosystem run locally). 

- B — registry-mined + vendor documentation. Claude Code, Codex CLI, Gemini CLI, OpenCode, OpenHands, Aider, mini-swe-agent: Harbor adapter capability flags (resume, trajectory, config, MCP wiring) cross-read with public docs, corrected where an external fact-check already caught us overclaiming. 

- C — public documentation only. DeepSeek harness: unverified at source; cells marked "?" where we could not confirm. 

Piko's own row is graded by the strictest standard in this document: committed artifacts (24 ADRs, benchmark ledgers, review trail). Limitation, stated plainly: this pass ran without a fresh web sweep (session search budget exhausted); external facts reflect our session research and documentation as of August–September 2026. 

**2 · The field 

## Thirteen candidates from a 41-harness census, in four tiers 

#### Tier 1 · Production flagships 

Claude Code, Codex CLI, Gemini CLI, OpenCode — vendor-backed or community-massive CLIs with real adoption; the capability bar. 

#### Tier 2 · Open frameworks 

OpenHands (sandboxed platform + SDK), Aider (the git-native veteran) — the programmable/agentic-platform wing. 

#### Tier 3 · Lean & lineage 

pi-mono (piko's design ancestor), Exo (self-hosting fleet ambition), Terminus-2 (the benchmark baseline), mini-swe-agent (radical minimalism). 

#### Tier 4 · Emerging 2026 

DeepSeek harness (cheap-token economics), fusion-harness (multi-model orchestration on pi). 

Also considered and cut as redundant with a represented tier: Cursor CLI, Copilot CLI, Cline, goose, Qwen Code, Kimi CLI, trae-agent, Devin, Junie, and the remainder of the registry. 

**3 · The matrix 

## Eleven dimensions, graded 

● strong / engineered ◐ partial / present with gaps ○ absent / out of scope ? unverified 

Harness (evidence) 
Context mgmt Cost enforce Tools & ext. Sub-agents Approvals Isolation Session durability Automation Provider breadth Bench evidence Maturity 

| Piko (A) ● ● ◐ ○ ● ◐ ● ● ◐ ● ○ |
| Claude Code (B) ● ◐ ● ● ● ● ◐ ● ◐ ◐ ● |
| Codex CLI (B) ◐ ◐ ● ◐ ● ● ● ● ◐ ◐ ● |
| Gemini CLI (B) ◐ ◐ ● ◐ ◐ ◐ ◐ ◐ ○ ◐ ● |
| OpenCode (B) ◐ ◐ ● ◐ ◐ ○ ◐ ● ● ◐ ● |
| OpenHands (B) ◐ ◐ ● ◐ ◐ ● ◐ ● ● ● ● |
| Aider (B) ◐ ◐ ◐ ○ ◐ ○ ◐ ◐ ● ◐ ● |
| pi-mono (A) ● ◐ ◐ ◐ ◐ ○ ◐ ● ● ◐ ◐ |
| Exo (A) ◐ ○ ● ● ◐ ● ◐ ◐ ● ○ ○ |
| Terminus-2 (A) ◐ ○ ○ ○ ○ ◐ ○ ◐ ● ● ◐ |
| mini-swe-agent (B) ◐ ○ ○ ○ ○ ◐ ○ ◐ ● ● ◐ |
| DeepSeek harness (C) ? ? ◐ ? ? ? ? ? ◐ ? ◐ |
| fusion-harness (A) ◐ ◐ ◐ ● ○ ○ ◐ ◐ ● ○ ○ |

**4 · Reading the columns 

## Where piko wins, draws, and loses — dimension by dimension 

### Piko wins outright (4 columns) 

- Cost enforcement. The only harness in this set with a native per-run dollar ceiling backed by pre-dispatch reservation and durable exposure accounting (ADR 0020, exercised across 89 benchmark trials). Nearest peers: OpenHands has a per-task budget setting (softer, post-hoc); Exo has a pricing loader we adopted — "accounting, not enforcement," per our source study; everyone else meters or less. Terminus and mini-swe bound turns, not dollars. 

- Session durability & crash honesty. Write-ahead journal with unknown-outcome semantics, fsync discipline, lock-capability mutation (compile-time and runtime), hard-link defense, explicit stale-lock recovery (ADRs 0007/0015/0023/0024, all adversarially re-reviewed). Codex's native rollout files are the closest peer. Our Exo study line stands source-backed: Exo asserts an immutable log; piko engineered one. 

- Benchmark evidence transparency. Self-priced per-trial ledgers with stop reasons, committed in-repo; tuning firewalled from evidence; corrections and retractions dated. OpenHands and the research baselines publish strong scores; nobody in this set publishes piko-style cost-itemized, governance-audited evidence packs. Note the honest flip side under "loses": the score itself. 

- Context footprint discipline. 815-token default prefix under a CI ratchet with a token-rent rule already enforced against our own feature. pi-mono shares the lean thesis (it is the ancestor); no one else makes the discipline mechanical. 

### Piko draws (3 columns) 

- Approvals. Piko's durable suspend/approve/edit/reject across process death (exit 4, scriptable) matches the production tier's permission systems in rigor; Claude Code's permission modes and Codex's tested exec-policy engine are broader in expressiveness. 

- Automation contract. Versioned JSON events, stable exit codes, amendment governance (ADR 0010). Codex's bidirectional app-server and OpenCode/OpenHands server-SDK surfaces are richer; piko's is smaller but contract-governed. 

- Context management (beyond footprint). Observable compaction with lineage and offload is solid engineering; Claude Code's subagent-offload pattern and Terminus's constant-size snapshot context are equally valid answers we don't have. 

### Piko loses (4 columns) — and by how much 

- Isolation. The field's leaders are far ahead: Claude Code ships OS-level sandboxing, Codex has seatbelt/landlock modes, OpenHands runs Docker/K8s runtimes, and Exo fields a seven-provider sandbox matrix up to Firecracker microVMs. Piko has path-based workspace containment with a known, reproduced race (ADR 0022, accepted, unimplemented) and a proposed container seam (0018). This is piko's single largest capability deficit. 

- Sub-agents / orchestration. Absent by explicit decision (0004 defines the mechanism; no delegation path ships). Claude Code's subagent system, Exo's agent sandboxes, and fusion's N-model DAG collaboration all deliver real capability piko does not. 

- Tool surface & ecosystem interop. Five tools + skills + trusted extensions is a deliberate cost trade (ADR 0002), but it means no MCP interop while every Tier-1 harness treats MCP as table stakes. Cheap per request; expensive per integration. 

- Maturity & adoption. Pre-1.0, unlicensed, unpublished, zero external operators, independent maturity score 2.6/5 on the record. Every Tier-1/2 candidate is in production use. This column is not close. 

- Raw capability ceiling (cross-cutting). Our only official-suite number is a cost-bounded floor (33/89 at tight caps); Terminus's uncapped 78.0 on the harder 2.1 suite towers over it even granting non-comparability. Until the frontier rerun, piko cannot claim capability parity with anyone on hard tasks — only cost-efficiency at the difficulty band it handles. 

So what The matrix says piko is not a general-purpose challenger to Claude Code or Codex — and doesn't need to be. Its four winning columns (cost enforcement, durability, evidence, footprint) are exactly the columns that matter for unattended, budgeted, auditable operation. The two moves that most change its position: implement 0022+0018 (isolation is the deficit that gates everything else) and publish the frontier rerun (converts the capability column from "floor" to "curve"). 

**5 · Candidate notes 

## One honest paragraph each 

| Harness | What it actually is, and what we'd steal |
| Claude Code | The capability bar: rich context, mature subagents, hooks/skills/MCP, OS sandboxing, production polish. Its cost story is reporting plus platform-level budgets, not per-run contracts. Steal: the subagent-offload pattern for keeping main context lean while spending in disposable contexts. |
| Codex CLI | The engineering-rigor peer: tested exec policies, sandbox modes, native session rollouts, an approval-aware app-server protocol. Closest to piko in contract-mindedness, far ahead in isolation. Steal: the execpolicy idea — policy as tested code. |
| Gemini CLI | Massive-context strategy (the model's window does the work), Apache-licensed, huge adoption; capability posture broad but less contract-governed. Provider-locked in practice. |
| OpenCode | The community's multi-model TUI: 75+ providers, LSP integration, server/SDK mode, plugins. Provider breadth and DX are the draw; no OS sandbox, cost is metering. Steal: LSP-informed editing. |
| OpenHands | The platform wing: Docker/K8s sandboxes, REST/SDK, strong published SWE-bench lineage, and the field's closest thing to a peer budget control (per-task cost cap, post-hoc). Heavier than a CLI; a different species, and the most instructive one for piko's 0018. |
| Aider | The veteran: git-native auditability (every edit a commit), repo-map context, huge provider breadth via litellm, its own public leaderboards. Aging on orchestration and isolation; still the standard for git discipline. |
| pi-mono | Piko's design ancestor: the lean thesis with a real ecosystem (SDK, RPC/JSON modes, extensions, packages) and multi-provider reach — proof the lean architecture scales into a platform. No cost enforcement, trusted-code extension philosophy like ours. The fork lineage means capability gaps here are piko's roadmap preview. |
| Exo | The most ambitious architecture we read: three-layer Rust/TS split, seven sandbox providers incl. Firecracker, real ops engineering — and, per our pinned source study, an "immutable" log protected by convention without fsync, and zero hard budgets. Steal (already stolen): its pricing-loader pattern became ADR 0020's foundation. Its sandbox seam design informs 0018. |
| Terminus-2 | The research baseline that beat us before our fixes and anchors the public leaderboard. Constant-size snapshot context is genuinely distinctive engineering. No tools, no durability, no governance — by design; it exists to measure models, and it does that credibly. |
| mini-swe-agent | Radical minimalism (shell-only, ~100 lines of agent) with real SWE-bench pedigree — the proof that harness complexity is not where capability comes from. Piko's philosophical cousin on a different axis: minimal code vs minimal context. |
| DeepSeek harness | Graded C on purpose: public docs describe a traceable, plugin-based harness with multiple operating modes; its real force is economic (token prices that shift the whole cost/quality frontier). Unverified at source; the one candidate a follow-up web pass should firm up — and a ~$2 benchmark arm through our adapter would turn folklore into a measured column. |
| fusion-harness | The multi-model wing, source-reviewed: read-only N-model fan-out, single-writer lease, DAG collaboration, ACK-verified merges — genuinely novel orchestration on pi. Meters cost per agent, caps rounds and timeouts, ships no dollar ceiling. Steal: read-only fan-out + sole-writer as an execution pattern, and escalation-tier fusion as an experiment our TB 2.0 data is begging for. |

**The standing, in one statement 

Piko is the field's governance-and-economics specialist: first or best-in-set on cost enforcement, session durability, evidence transparency, and footprint discipline — and honestly behind the production tier on isolation, orchestration, ecosystem, and proven capability ceiling. The strategy the matrix supports is not "catch Claude Code"; it is: close the isolation gap (0022, 0018), publish the frontier curve, and let the four winning columns compound where the field is weakest — unattended agents running on budgets somebody has to answer for. 

Provenance. Census: the Harbor framework's agent registry (41 harnesses; adapter capability flags mined for resume/trajectory/config/MCP support). Source-level grounding: Terminus-2 (source + three head-to-head benchmark arms, docs/benchmarks/), Exo (docs/exo-study-2026-08-24.md, pinned commit, provenance chain), fusion-harness (source review, tests executed), pi-mono (adapter + ecosystem run). Piko cells cite committed artifacts: 24 ADRs, benchmark ledgers, the adversarial review trail (docs/reviews/). Vendor-tier cells reflect public documentation as of August–September 2026 and incorporate corrections from the external fact-check of our prior competitive claims (docs/reviews/2026-08-31-cto-overview-factcheck.md). This pass ran without a fresh web sweep; DeepSeek cells are explicitly unverified. Grades are our judgment; the evidence letter on each row says how much to trust it.
