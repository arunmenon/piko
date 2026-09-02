<!-- Export of the published artifact "Piko Red Team" (claude.ai artifact ce777c72), generated 2026-09-02 against tree cacdd8d. Received from the operator; recorded as review provenance. The artifact remains the formatted original; this file is the committed copy. -->

# Piko Red Team

*Adversarial review · 27 decision records · against the field, September 2026*

Every ADR gets a steelman, an attack on the design, an attack on the implementation, what the competing harnesses actually ship, the research that supports or contradicts it, and one move. Vendor comparisons come from docs and source fetched 2 Sep 2026; every paper was verified against its abstract page; anything I could not verify from a primary source is marked as reported.

- tree **cacdd8d**
- score after T1 **2.7 / 5** (from 2.55)
- records **20 accepted · 7 proposed**
- papers verified **≈90 · 1 cited by an ADR**
- compared against **Claude Code 2.1.258 · Codex 0.152 · Gemini CLI 0.58 · OpenCode 1.18 · OpenHands SDK 1.44 · DeepSeek dsh · pi · mini-swe-agent · Aider · LiteLLM · Temporal**

> **The frame for every attack below**
>
> Piko's decisions were written against a field the ADRs mostly describe as of early August 2026. The field moved. Codex now sandboxes by default with bubblewrap and ships a shared cross-thread token budget; Claude Code defers MCP schemas by default, caps subagent trees at depth 3 and concurrency 20, and journals a deferred approval that survives process exit; DeepSeek's harness fails closed when no sandbox runner is usable; Anthropic cut its own system prompt by more than 80%. Several of piko's founding "the field lacks this" premises are now "the field does this, differently." That does not make the decisions wrong — several are still ahead — but it moves the burden of proof. Where I say "ahead," I mean ahead of what those vendors document today; where I say "behind," the gap is a shipped feature elsewhere, not an idea.

## Ten cross-cutting attacks

### 01 · The score moved because documents moved

T1 took the score from 2.55 to 2.65 by fixing back-pointers, extracts, and a manifest generator. `packages/` changed by one warning string. A governance harness whose maturity improves without its runtime changing has proven the reviewer grades paperwork, not that the harness got safer. T2 is the first tranche that can be falsified by a test.

### 02 · Control plane without an execution plane

Every mechanism piko is proud of — reservation, journal, locks, approvals — lives in the process the model can already command with host bash on. Codex, DeepSeek, Claude Code's runtime, and Gemini all put an OS boundary under the shell first and built governance on top. Piko built governance first and is now trying to slide a boundary underneath it. The order is defensible; the timeline (0018 proposed 24 Aug, no provider on 2 Sep) is not.

### 03 · The default nobody runs, again

The new host-bash warning now says the truth ("commands run as your user and can inspect this process and its credentials"). That is honesty about a mode that every benchmark trial and every real session uses. Codex's default is workspace-write inside a sandbox; DeepSeek's default is read-only inside a sandbox. Their defaults do work. Piko's default cannot run `npm test`.

### 04 · Reservation is unique, and the field decided it doesn't need it

No harness does pre-dispatch reservation; LiteLLM's proxy does, using `max_tokens` × price and reconciling afterward. Claude Code's post-hoc cap overshoots by one response and its own docs say so; OpenHands and mini-swe-agent check after the step. The field accepted "one request of overshoot" as the price of a cap that means what it says. Piko chose "never overshoot" and got a cap that means half of what it says. Both are trade-offs; only one is labelled on the tin.

### 05 · Per-turn scope is the worst of both

Inside a turn piko is stricter than anyone; across turns it is absent. Claude Code's `--max-budget-usd` is tree-wide including subagents; Codex's `rollout_budget` is a shared ledger across every agent thread with periodic reminders. 0026 fixes this on paper and is the most important proposed record in the set.

### 06 · Containment protects the wrong boundary

Piko stops the model leaving the workspace. It does not stop the model writing `.git/hooks/pre-commit`, `.git/config` (`core.hooksPath`), `AGENTS.md`, or `.agent/commands/*` inside it — all of which execute or load on the user's next action. Codex read-only-binds `.git`/`.codex`/`.agents`; Claude Code denies `.git/hooks`, `.git/config`, `.claude/*`, and shell rc files even inside writable roots. This is a persistence vector, it is cheaper to close than 0022, and no record mentions it.

### 07 · Approvals are durable but mute

Piko's approval survives a reboot and can only say a tool's name. Claude Code says `Bash(git push *)`; Codex says `prefix_rule(pattern=["git","push"], decision="prompt", match=[...])` with inline tests; Cursor, OpenCode, and Gemini all match arguments. 0011 itself says per-call prompting fails because users alias it away, then ships the design that guarantees per-call prompting for any chatty tool.

### 08 · The loop guard watches the wrong signal

Piko counts errors. OpenHands' StuckDetector counts identical action→observation pairs regardless of success (threshold 4), alternating pairs (6), and monologues (3); Gemini hashes tool+args (5) and text chunks (10) and escalates to an LLM judge after 30 turns. 0005's own consequences section names the no-op loop as undetected. It is the common case in coding: the agent "succeeds" at reading the same file eleven times.

### 09 · Stdout is not an integration surface

ACP v1 has a registry since January with 50+ agents; Codex's app-server is JSON-RPC with generated schemas; Claude Code takes a bidirectional stream-json control channel; OpenCode serves OpenAPI. Pi — piko's ancestor — already has a community ACP adapter. Piko's "stable JSONL on stdout" is the Aider tier, and piko's own stance (orchestration is an external controller) is precisely the argument for shipping an ACP adapter as one.

### 10 · The lean thesis was validated by the incumbent — and it changes the comparison

Anthropic removed more than 80% of Claude Code's system prompt for Claude 5 models and now tells users CLIs beat MCP servers on context. Piko's 815-token prefix is no longer a contrarian bet; it is where the leader is heading. The differentiation argument has to move from "small prefix" to "small prefix that a stranger can install and a fleet can bound."

## Field scoreboard

Mechanism by mechanism: what piko ships, the strongest shipped equivalent elsewhere, and who. "Reported" marks claims that come from vendor docs or secondary sources rather than executed code.

| Mechanism | Piko today | Strongest in field | Verdict |
|---|---|---|---|
| Shell isolation | None; host bash opt-in as user | Codex: default-on bwrap+seccomp (Linux 0.115+), Seatbelt, Windows restricted tokens; DeepSeek: fail-closed `SANDBOX_UNAVAILABLE` | [behind] |
| File-tool containment | realpath + lexical checks; known TOCTOU | Nobody anchors descriptors; Claude Code/Codex/DeepSeek add protected-path deny lists inside the workspace | [mixed] |
| Credential boundary | Env-name config, allowlisted child env; parent env readable via `ps` | Claude Code mask mode (sentinel in sandbox, proxy injects real value); Gondolin placeholder tokens; Codex fresh PID namespace | [behind] |
| Spend ceiling | Pre-dispatch reservation, per turn | Claude Code tree-wide post-hoc; Codex shared token ledger across threads; LiteLLM reservation at the gateway | [mixed] |
| Loop detection | Error streaks, identical failing calls | OpenHands StuckDetector (4 patterns incl. successful no-op); Gemini hash + content + LLM judge | [behind] |
| Compaction | New lineage file, transcript kept; disk-stub offload | Claude Code: forked summarizer off cached prefix, re-hydrates 5 files + skills + CLAUDE.md | [mixed] |
| Session locking | wx lock, owner token, exit 5, doctor recovery | Claude Code: none (documented interleaving); Codex: none (two app-servers, one rollout); OpenHands: flock serialization | [ahead] |
| Crash honesty | Per-tool planned/started/outcome_unknown | DeepSeek turn-level `interrupted`; OpenHands unmatched action (ambiguous); Temporal scheduled/started + heartbeat | [ahead] |
| Durable approvals | Journal rows, exit 4, resume flags | Claude Code `PreToolUse defer` (2.1.89); OpenAI Agents SDK `RunState.to_json()`; DeepSeek: crash = interrupted | [parity] |
| Approval expressiveness | Tool name only | Codex execpolicy prefix rules with inline tests; Claude Code argument globs; Cursor/OpenCode/Gemini patterns | [behind] |
| Headless contract | Exit 0/1/2/3/4/5/130, versioned JSONL | Claude Code 0/1/143; Codex 0/1 (with exit-0-on-failure bugs); Gemini 0/1/42/53 | [ahead] |
| RPC / IDE surface | None | ACP v1 (50+ agents); Codex app-server; Claude stream-json input; OpenCode OpenAPI | [behind] |
| Sub-agent bounds | None (needs host bash) | Claude Code depth 3 / concurrency 20 / tree budget; Codex depth 1 / threads 6 / rollout budget | [behind] |
| Provider contract | Strict terminal contract; 2 adapters; no Responses API | Codex Responses-only; AI SDK Responses default; LiteLLM 38 capability flags; models.dev registry | [mixed] |
| Fixed prefix | 815 tokens, CI ratchet | pi ~2.6k; Codex ~15k; Claude Code ~27k pre-cut, >80% cut since (reported) | [ahead] |
| Graceful shutdown | SIGTERM aborts | Claude Code: kill bash tree → SessionEnd hooks → 143 → "command killed" journaled; Temporal `shutdownGraceTime` | [behind] |
| Release hygiene | No license, private, unpublished | Codex Apache-2.0 + SLSA provenance + `codex doctor --json`; Claude Code signed manifests + version pins | [behind] |
| Self-improvement | Proposed, unbuilt | Nobody ships evidence-gated; exo validates by liveness; DGM documented reward hacking | [open] |

## Research lineage

One of the 27 records cites a paper (0001, arXiv 2605.23950). The other 26 were written from practice — audits, incidents, reading competitors' source. Checked against the 2025–26 literature, most of them turn out to be independently corroborated, several by papers published after the decision was made, and a few are contradicted in ways the records should absorb. Each ADR below now carries a [Research] row with verified citations (title, first author, venue or arXiv ID, date). This table is the sellable half: the decisions piko made first and the research that arrived to agree.

| Piko decision | Corroborating research | What it establishes |
|---|---|---|
| Harness over model (0001) | Zhang et al., arXiv 2605.23950 (May 2026) | Harness-induced variance 7.8× model-induced on SWE-bench Verified; six ranking reversals across nine comparisons. The one paper an ADR cites. |
| Few tools, no MCP catalog (0002) | Song et al., arXiv 2508.12566 (Aug 2025); Fei et al., arXiv 2506.01056 (Jun 2025); Repantis et al., arXiv 2605.24660 (May 2026) | Automated MCP access reduces accuracy 9.5% (−17% on code) and inflates input 3–236×; pre-loading 2,797 tools costs ~248k tokens; ~7 adaptive tools match 50. |
| Offload old tool output, don't summarize it (0003) | Lindenbauer et al., DL4C @ NeurIPS 2025, arXiv 2508.21433 | Observations are ~84% of a turn; placeholder masking halves cost and matches or beats LLM summarization on SWE-bench Verified. |
| No built-in orchestration; context firewall (0004) | Kim et al., Nature Machine Intelligence (Jul 2026); Tran & Kiela, arXiv 2604.02460; Cemri et al., arXiv 2503.13657; Fei et al., arXiv 2601.14914 | Past ~45% single-agent baseline, adding agents rarely helps (−1 to −13% on SWE-bench Verified); MAS gains vanish under matched budgets; isolated ephemeral coders lift success 26→38%. |
| Loop-side failure control (0005) | Hou et al., arXiv 2607.01641 (Jul 2026); Cemri et al. (MAST) | Infinite loops arise wherever a feedback path is unbounded; step repetition is the most frequent multi-agent failure (15.7%). |
| Untrusted project content by default (0006, 0011) | Debenedetti et al., CaMeL, arXiv 2503.18813 (2025); Liu et al., arXiv 2509.22040; Maloyan & Namiot, arXiv 2601.17548 | Policy must never derive from untrusted data (provable on 77% of AgentDojo); rule-file injection achieves 84% command execution in Cursor/Copilot; adaptive injection beats filters at >85%. |
| Write-ahead journal, outcome unknown (0007) | Mohan et al., ARIES, TODS 1992; Candea & Fox, HotOS 2003; Helland, ACM Queue 2012 | Log intent before effect; design for crash as the only stop; without idempotence a lost response is unknowable, never "didn't happen." |
| External hard budgets (0009, 0020) | Lin et al., BAGEN, arXiv 2606.00198 (May 2026); Gao & Peng, arXiv 2510.16786; Kapoor et al., HAL, ICLR 2026 | Agents keep spending on failing tasks (budget-awareness r = 0.35); a 75th-percentile turn cap cuts cost 24–68% at negligible loss; more reasoning spend reduced accuracy in most HAL runs. |
| Stable prefix, append-only history (0014) | Lumer et al., arXiv 2601.06007 (Jan 2026) | Across 500+ agent sessions on three providers, caching cuts cost 41–80%; wins come from dynamic content last, stable tool definitions, dynamic results excluded — piko's rules, measured. |
| fsync file and directory; poison on uncertain write (0015) | Pillai et al., OSDI 2014; Rebello et al., ATC 2020 | 60 crash vulnerabilities from atomicity/ordering assumptions incl. missing directory fsync; PostgreSQL and Redis silently lose data on fsync failure. |
| Evidence-gated self-improvement with pre-registered stats (0017) | Zhang et al., DGM, arXiv 2505.22954; Wang et al., HGM, arXiv 2510.21614; Miller, arXiv 2411.00640; Khanal et al., arXiv 2603.29231; Thaman, ICML 2026 | Self-improving agents fabricated passing test logs; own-score poorly predicts descendant quality; evals need paired CIs and power analysis; SE reliability decays 0.90→0.44 across attempts; reward hacking rises with RL and difficulty. |
| Numbers without artifacts are narrative (0021) | Kapoor et al., HAL, ICLR 2026; Singh et al., Leaderboard Illusion, NeurIPS 2025; Merrill et al., Terminal-Bench, arXiv 2601.11868 | Released logs exposed shortcuts invisible in scores; private testing inflates up to 112%; ≥5 trials per pair with CIs is the published bar. |
| Path re-checks cannot close the race (0022) | Dean & Hu, USENIX Sec 2004; Borisov et al., USENIX Sec 2005; Tsafrir et al., FAST 2008; Cai, Gui & Johnson, IEEE S&P 2009 | Twenty years of TOCTOU literature: k-race defeated by filesystem mazes, hardness amplification defeated by algorithmic-complexity attacks. Only descriptor-relative access holds. |
| Lock as unforgeable capability (0023) | Miller, Yee & Shapiro, Capability Myths Demolished, 2003 | Unforgeable capabilities enforce least authority and are not reducible to ACLs — the module-private token is an object capability. |
| Lightweight sandbox before Docker (0018, this critique) | Wang & Zheng, Sandlock, arXiv 2605.26298 (May 2026); Marchand et al., UK AISI, arXiv 2603.02277 (Mar 2026) | Unprivileged Landlock+seccomp confinement at ~5 ms startup with TOCTOU-immune syscall inspection; frontier models comfortably escape misconfigured containers (~40% at medium difficulty). |

The other half, which a buyer will also find: research that says a decision is incomplete. Instruction stacking collapses compliance at 20 rules (Anand & Chattaraj, 2026) — the fixed prefix protects against this and nothing bounds the trusted-project prompt the same way. Compaction silently erases safety constraints in up to 59% of long-horizon scenarios (Chen, arXiv 2606.22528) — piko pins tool policy outside the summary but not task constraints. Name-only shell gating is defeated 69–99% of the time (Chen & Lin, arXiv 2606.15549) and ~37% of state-changing actions route around a shell-oriented gate through file edits (Ji et al., arXiv 2604.04978) — 0011's tool-name policy is exactly this shape. Skill files carry confirmed malware at scale (Chen et al., arXiv 2604.03070) and in-process isolation is feasible (IsolateGPT, NDSS 2025) — 0012's "trusted code" stance is honest but the research says the risk is measured, not hypothetical. Leases (Gray & Cheriton, 1989) are the standard answer to dead lock holders — 0024 chose Chubby-style withholding instead, defensibly, without saying so.

A concrete recommendation: add a dated "Research" addendum to each record with the citations below, and a bibliography in `docs/adr/README.md`. It costs nothing, it is the honest version of "research-informed," and it turns a record that reads as one engineer's judgement into one that a reviewer can check against the literature — which is the same move the evidence maps made for tests.

## Foundation: context, tools, compaction, control

### ADR 0001 — Fixed-context budget, CI-enforced  [implemented] [token-rent amendment proposed]

**Steelman.** Overhead is paid on every request and compounds across turns and children. The field confirms the instinct: community measurements put Claude Code near 27k tokens per request before its cut and Codex near 15k; only pi (~2.6k) is in piko's class. Anthropic removing more than 80% of its own prompt is the strongest possible endorsement of the stance.

**Attack.** The gate measures the default prefix, and the default prefix is under 6% of a real bill by piko's own accounting. The bytes that matter — trusted-project instructions, skills, extension schemas, and above all history — are bounded separately or not at all. A ratchet on the smallest slice of the bill is discipline theatre unless it is paired with a per-request accounting of the whole first request.

The token-rent rule cannot be enforced by CI, only its numeric symptom; the "benchmark evidence in the same commit" half is human review, and the amendment has sat unratified through two homes while CI obeys it.

The caching inversion is now a per-model fact, not a caveat: at 815 tokens the prefix never caches on Sonnet 5 (1,024 minimum), Opus 4.6 and Haiku 4.5 (4,096), OpenAI GPT-5.6 (1,024), or Gemini 3.x (4,096). It does cache on Claude 5-generation models (512). The ADR treats this as one trade-off; it is a table, and the table should be in the gate's output.

**Field.** Claude Code defers MCP schemas by default (tool search on since 2.1.232), ships `--bare` to skip hooks/skills/CLAUDE.md for scripted calls, keeps plan mode as a tool toggle so the tool set stays cache-stable, and runs alerts on cache hit rate. Nobody publishes a CI gate on prompt size; nobody needs to at 15–27k.

**Research.** **Cited by the ADR.** [Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/abs/2605.23950) (Zhang et al., May 2026): a 3 models × 3 harnesses × 2 seeds factorial on 100 SWE-bench Verified tasks finds harness-induced variance 7.8× model-induced, with 6 ranking reversals in 9 comparisons. Honest caveat for the record: it is a position paper with a small factorial, and [Terminal-Bench](https://arxiv.org/abs/2601.11868) (Merrill et al., Jan 2026), with a neutral scaffold, finds model choice matters more than agent choice — the two should be cited together.

**Aligned, uncited.** Instruction-count collapse: [Instruction Stacking Collapse](https://arxiv.org/abs/2608.02639) (Anand & Chattaraj, Aug 2026) shows compliance falling from ~96% to as low as 20% as stacked instructions reach 20; [Prompt Design at Scale](https://arxiv.org/abs/2607.19257) (Eliav, Jul 2026) shows adherence collapsing by ~80 rules. [Tool Attention Is All You Need](https://arxiv.org/abs/2604.21816) (Sadani & Kumar, Apr 2026) measures the per-turn tools tax at 10k–60k tokens in multi-server MCP deployments. Lost in the Middle (Liu et al., TACL 2024) remains the canonical position-effect result. These are the citations the token-rent rule needs.

**Move.** Make `check-budget` report two numbers: the default prefix (ratcheted) and the worst-case first request with trusted content and extensions loaded (bounded), plus a per-provider cache-eligibility line. Ratify or withdraw the token-rent amendment; a CI gate should not cite a proposed rule.

### ADR 0002 — Files and CLIs over MCP; five built-in tools  [implemented]

**Steelman.** The evidence has only gotten stronger: Anthropic measured 55k tokens for 58 MCP tools across five servers, an 85% reduction from deferred loading, and 98.7% from presenting MCP as a code API; a May 2026 paper shows ~7-tool shortlists match 50-tool coverage. Claude Code's own docs now say `gh`, `aws`, and `gcloud` are more context-efficient than MCP servers.

**Attack.** The field solved the token problem without abandoning the ecosystem. Claude Code and Codex both ship an MCP client with deferred schemas on by default; piko ships no client and no proxy. 0002's own text describes the ~200-token bounded proxy it never built, so the decision is being honoured in its restrictive half only.

"Any CLI is reachable through bash" is true only with `--allow-host-bash`. In the contained default there are zero integrations: no MCP, no CLIs, no shell. The decision's cost line ("no ecosystem of turnkey integrations") understates this; the accurate line is "no integrations at all in the mode the ADRs defend."

MCP's remaining advantages — OAuth, remote servers, per-tool approval annotations, audit — are exactly the governance features piko sells elsewhere.

**Field.** Claude Code: `MAX_MCP_OUTPUT_TOKENS` 25k with oversize results spilled to disk, per-tool approval via `requiresUserInteraction`, project `.mcp.json` gated by workspace trust. Codex: `enabled_tools`/`disabled_tools`, per-tool `approval_mode`, tool search by default, per-tool `output_token_limit` in 0.152. OpenHands and Gemini: MCP without deferral.

**Research.** **Aligned, uncited — and the strongest research case in the set.** [Help or Hurdle?](https://arxiv.org/abs/2508.12566) (Song et al., Aug 2025; MCPGAUGE, ~20k calls across 6 LLMs × 30 MCP suites) finds automated MCP access *reduces* accuracy 9.5% on average (−17% on code generation) and inflates input tokens 3.25×–236×. [MCP-Zero](https://arxiv.org/abs/2506.01056) (Fei et al., Jun 2025): pre-loading 2,797 tools costs ~248k tokens; on-demand discovery cuts 98% with no accuracy loss. [ToolScope](https://arxiv.org/abs/2510.20036) (Liu et al., 2025–26): redundant tool descriptions hurt selection by 8–39 points.

**Challenges the hard five.** [How Many Tools Should an LLM Agent See?](https://arxiv.org/abs/2605.24660) (Repantis et al., May 2026): adaptive ~7-tool shortlists match 50-tool coverage, but a *fixed* 5-tool list scores 0% on ToolBench queries whose correct tool ranks 6–20. The research supports few tools per request, not a permanently fixed five — which is the argument for the bounded proxy 0002 already describes.

**Move.** Build the bounded proxy as an extension (0012 already sanctions the schema cost) with deferred schema fetch and 0011 gating by `mcp__server__tool` name. Rewrite the consequences line to say what the contained default can reach: nothing.

### ADR 0003 — Observable compaction into new session files  [implemented]

**Steelman.** Lineage-linked new files with the prior transcript untouched is unique in the field; Claude Code rewrites its JSONL in place, Codex discards tool results and file contents. Disk-stub microcompaction with no model call is the same "prune outputs first" pattern everyone converged on (Claude Code clears old tool outputs first; Gemini's 50k tool-output budget; OpenCode's 40k protect window; Cline's `SYSTEM_NOTICE` stubs).

**Attack.** Piko's summary is a cold request and a prefix-only summary. Claude Code runs the summarizer as a fork of the live conversation so it reads from the cached prefix, then re-hydrates: CLAUDE.md, auto-memory, the plan, up to five most-recently-modified files, and invoked skill bodies capped at 5k each. Codex preserves up to 20k tokens of recent user messages; Gemini keeps the last 30% verbatim. Piko keeps "the recent tail" with no stated rehydration, so the first post-compaction turn re-reads what it needs at full price.

The 8,000-character microcompaction batch is a fixed number chosen for cache behaviour on one provider; on providers with 4,096-token cache minimums the calculus is different and unmeasured.

Compaction refusing during pending approvals is correct and is also a way to wedge a long unattended session: a gated call at 95% of the window leaves no way forward except deciding it.

**Field.** Thresholds range from 0.5 of the window (Gemini, since Nov 2025) through 0.8 (goose) and 0.9 (Cline, Codex cap) to near-limit (Claude Code). Claude Code stops auto-compacting after a few attempts when one tool output refills context immediately, to avoid thrashing.

**Research.** **Aligned, uncited — direct support for microcompaction over summarization.** [The Complexity Trap](https://arxiv.org/abs/2508.21433) (Lindenbauer et al., DL4C @ NeurIPS 2025): observation tokens are ~84% of an average SWE-agent turn, and replacing observations older than the last 10 turns with placeholders halves cost while matching or beating LLM summarization on SWE-bench Verified. That is piko's disk-stub design, validated. [ACON](https://arxiv.org/abs/2510.00615) (Kang et al., ICML 2026) and [SWE-Pruner](https://arxiv.org/abs/2601.16746) (Wang et al., 2026) report 23–54% token cuts with improved success from goal-conditioned pruning.

**Challenges the summary path.** [Governance Decay](https://arxiv.org/abs/2606.22528) (Chen, Jun 2026): across 1,323 scenarios, policy violations rise from 0% to 30% (up to 59%) after compaction drops constraints — the argument for pinning invariants outside the lossy summary, which piko does for tool policy (0006) but not for task constraints. [Toward Reliable Context Compression](https://arxiv.org/abs/2608.06503) (Min et al., Aug 2026): compression weakens recent-interaction influence and increases repeated exploration.

**Move.** Fork the summary request off the cached prefix where the provider supports it, add a small re-hydration list (trusted instructions, last N touched files as stubs), and add the thrash guard.

### ADR 0004 — Headless self-spawn as the sub-agent mechanism  [primitive only]

**Steelman.** Subprocess self-spawn is now mainstream: both the Claude Agent SDK and the Codex SDK wrap their CLI as a subprocess exchanging JSONL. The context-firewall benefit is real, and piko pays zero resident tokens for it.

**Attack.** Everyone who self-spawns adds bounds on top, and piko has none: Claude Code caps nesting at depth 3 and concurrency at 20, marks partial output at `maxTurns`, tags every event with `parent_tool_use_id`, and stops background subagents when the tree budget is hit; Codex caps depth at 1 and threads at 6 with a 30-minute job runtime and a shared rollout ledger. Piko's ADR cites a 171-spawn incident and 4–7× burn as motivation, then ships a primitive that cannot prevent either.

"Personas are prompt templates" and "parallelism is the shell's job" mean the parent cannot cancel a child tree, cannot attribute a child's spend, and cannot know a child exists. fusion-harness shows the missing pieces — single-writer lease, process-group SIGTERM→SIGKILL, per-agent token tracking — fit in an extension on pi; piko has no equivalent extension.

**Field.** Field reports: Codex users hitting 20–50× normal consumption from parallel review agents (issue open since June); Anthropic documents ~7× for agent teams in plan mode. OpenHands delegation is still blocking; DeepSeek forks child sessions with persisted `delegationDepth`.

**Research.** **Aligned, uncited — the research is now on piko's side against orchestration.** [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) (Cemri et al., 2025; MAST, 1,600+ traces): failures cluster in system design and inter-agent misalignment; step repetition alone is 15.7%. [Capable language models can outgrow the benefits of collaboration](https://www.nature.com/articles/s42256-026-01268-y) (Kim et al., Nature Machine Intelligence, Jul 2026): across 260 configurations, once a single agent exceeds ~45% baseline, adding agents rarely helps; SWE-bench Verified saw −1% to −13% from multi-agent variants. [Single-Agent LLMs Outperform Multi-Agent Systems](https://arxiv.org/abs/2604.02460) (Tran & Kiela, Apr 2026): under matched token budgets, reported MAS advantages vanish. [CodeDelegator](https://arxiv.org/abs/2601.14914) (Fei et al., Jan 2026): fresh, ephemeral coder instances isolated from a persistent delegator lift MCPMark success 26.4% → 38.4% — direct evidence for the context-firewall pattern 0004 chose.

**Move.** Before 0018: a `--parent-run <id>` flag echoed in every JSONL row, depth and concurrency env caps, and a process-group kill on parent abort. These are a day of work and remove the cheapest way to lose money with piko.

### ADR 0005 — Loop-side failure control (flail guard)  [implemented]

**Steelman.** The philosophy is right and it is measured: equal accuracy at 59% less spend. Claude Code, Codex, Cursor, goose, and Aider ship no loop detection at all, so piko is ahead of the flagships.

**Attack.** Piko is behind everyone who does ship one. OpenHands' StuckDetector catches same action → same observation four times regardless of success, action→error three times, three consecutive agent messages with no user input, and two pairs ping-ponging six cycles. Gemini hashes tool name + args (five identical), detects repeated 50-character text chunks (ten), and after 30 turns asks a second model with a 0.9 confidence bar. OpenCode warns at three identical calls and escalates at five. A pi extension does all three at three. Piko catches errors and identical *failing* calls — and 0005 concedes the successful-no-op loop is undetected, which in coding is the common case.

The identical-call thresholds (2 nudge / 4 stop) are tighter than anyone else's (3–5) while the signal is narrower; Gemini's issue tracker shows what false positives cost in trust.

**Field.** Two 2026 papers formalise the problem (Infinite Agentic Loops, arXiv 2607.01641; the Cognitive Companion monitor, arXiv 2604.13759) and both treat repetition of successful steps as the primary pattern.

**Research.** **Aligned, uncited.** [When Agents Do Not Stop](https://arxiv.org/abs/2607.01641) (Hou et al., Jul 2026): infinite agentic loops arise wherever a feedback path is not bounded; 68 confirmed in 47 of 6,549 repos — the case for loop-side bounding in harness code. MAST finds step repetition the single most frequent failure (15.7%) and "unaware of stopping conditions" 12.4%. [Understanding Code Agent Behaviour](https://arxiv.org/abs/2511.00197) (Majgaonkar et al., Oct 2025): failed SWE-bench trajectories are consistently longer with higher variance — early cut-offs pay.

**Challenges sufficiency.** [The Cognitive Companion](https://arxiv.org/abs/2604.13759) (Khan & Khan, Apr 2026) reports looping on ~30% of hard tasks and argues heuristic repetition checks miss degradation that hidden-state probes catch (AUROC 0.84, small n). The direction is toward richer signals than error streaks.

**Move.** Hash tool + args and count identical calls regardless of outcome; add the alternating-pair detector; keep the tight thresholds for errors and relax them for successes. The guard already has the loop-side plumbing; this is a classifier change.

### ADR 0006 — Workspace containment and deny-by-default host bash  [shipped, holed]

**Steelman.** No shell by default is stricter than Claude Code (fresh installs on Pro/Max/Team start in auto mode, with bash unsandboxed unless the opt-in sandbox is enabled), Gemini (sandbox off), and pi (no permission system at all). The sanitized child environment matches Codex's default excludes and DeepSeek's `scrubbedParentEnv`.

**Attack.** The boundary is drawn around the workspace, and the workspace contains the user's execution hooks. Nothing in `filesystem.ts` or `write.ts` protects `.git/hooks`, `.git/config` (`core.hooksPath`, `core.fsmonitor`), `AGENTS.md`, or `.agent/commands` and `.agent/skills`. A model in the contained default can write a pre-commit hook that runs on the user's next commit, or author the instructions that `--trust-project` will load into its own system prompt next run. Codex read-only-binds `.git`, `.codex`, and `.agents` under writable roots; Claude Code denies `.git/hooks`, `.git/config`, `.claude/*`, `.mcp.json`, and shell rc files, and re-checks symlinks at those paths every command. This is cheaper than 0022 and closes a real vector 0022 does not.

The TOCTOU (0022) is open and the evidence map itself found five more windows than the ADR listed. The credential line is honest now but "not a credential boundary" is a warning, not a mechanism.

**Field.** Claude Code's sandbox is opt-in and fail-open by default (`failIfUnavailable` is the managed fix); its Read tool reads the whole disk even when sandboxed, which is how the April CI incident leaked `ANTHROPIC_API_KEY` through `/proc/self/environ`. Piko's O_NOFOLLOW reads inside the workspace only would have prevented that class — an actual advantage worth stating.

**Research.** **Aligned, uncited.** ["Your AI, My Shell"](https://arxiv.org/abs/2509.22040) (Liu et al., 2025–26): 314 payloads in rule files achieve up to 84% malicious command execution in Cursor and Copilot, including system-file modification and key exfiltration — the threat model 0006's untrusted-project default answers. [SoK: Prompt Injection Attacks on Agentic Coding Assistants](https://arxiv.org/abs/2601.17548) (Maloyan & Namiot, Jan 2026): adaptive attacks exceed 85% success against filter defenses, arguing for architectural containment.

**Challenges name-based shell gating.** [One Goal, Many Commands](https://arxiv.org/abs/2606.15549) (Chen & Lin, Jun 2026): 69–99% of 1,709 real agent command denylists fail to block their intended operation (awk spawning bash past Claude Code's list). Supports deny-by-default; shows that the day host bash is enabled, a name-level policy is not a boundary.

**Move.** Add a protected-path deny list inside the workspace this week (`.git/hooks`, `.git/config`, `.pi/`, `.agent/`, `AGENTS.md`, rc files), tested. Then 0022 through 0018.

## Reliability and automation contracts

### ADR 0007 — Write-ahead lifecycle journal with unknown-outcome semantics  [implemented]

**Steelman.** Per-tool `planned → started → terminal` is finer than DeepSeek's turn-level `interrupted` repair and unambiguous where OpenHands' "unmatched action" is not (no `started` marker there). It is the Temporal `ActivityTaskScheduled/Started` shape applied to a CLI, and no CLI peer has it.

**Attack.** Every durable-execution system that records "started, outcome unknown" also gives the resumer something to do about it: Temporal heartbeats and retries with a payload, Restate re-executes `ctx.run` with stable idempotency keys, Inngest memoizes steps by name, LangGraph documents that everything before an interrupt must be idempotent. Piko records honestly and stops. The ADR says "true idempotency requires tool-specific keys" and then no tool has one; 0011 notes planning-time content hashes as a future mitigation for bash.

"Every model-visible input reconstructable from the log" is a property with no replay test proving it — G11's corpus tests are still pending.

**Field.** Claude Code on SIGTERM records the running command as killed and continues the turn on resume; on unclean shutdown it silently drops a corrupt transcript line (2.1.121). Codex has no equivalent. Piko is ahead here and should not be modest about it.

**Research.** **Aligned, uncited — and the lineage is forty years old.** [ARIES](https://doi.org/10.1145/128765.128770) (Mohan et al., ACM TODS 1992): log intent before effect; recovery replays history to decide outcomes. [Crash-Only Software](https://www.usenix.org/conference/hotos-ix/crash-only-software) (Candea & Fox, HotOS 2003): state must be recoverable from durable records because crash is the only stop path. [Idempotence Is Not a Medical Condition](https://doi.org/10.1145/2181796.2187821) (Helland, ACM Queue 2012): without idempotent operations a lost response makes the outcome unknowable — exactly 0007's "unknown, never didn't-run." Lampson's [Hints](https://doi.org/10.1145/800217.806614) (SOSP 1983): make actions atomic or restartable.

**Context.** [Atomix](https://arxiv.org/abs/2602.14849) (Mohammadi et al., 2026) adds settlement and reversibility classes to agent tool calls: 57% clean success under fault injection vs 0–7% for baselines. It is the idempotency layer 0007 names as missing, published.

**Move.** Idempotency keys for the two side-effecting tools (write/edit already have content preconditions; bash gets a planning-time workspace hash) and a replay-conformance property test.

### ADR 0008 — Strict provider contract with typed terminal states  [implemented]

**Steelman.** No peer documents a terminal-signal contract, and the bugs it prevents are live elsewhere: Codex has open issues for exit 0 on early termination; Claude Code's cost is a client-side estimate. Buffered tool calls with validated JSON and rejected duplicate IDs is textbook.

**Attack.** Two adapters, and the wire format the field standardised on is missing: Codex removed Chat Completions entirely in February 2026 and speaks Responses only; the Vercel AI SDK defaults `openai()` to Responses; OpenHands routes `gpt-5*` to Responses via LiteLLM; the Assistants API is deprecated. A strict contract for an API path the leading OpenAI client no longer uses is strictness pointed backwards.

Context windows come from a hand table in `tokens.ts`; capabilities are implicit in the adapter. LiteLLM's price file carries 38 `supports_*` flags per model; models.dev records `reasoning_options`, tiered cost, and the wire `shape` per provider. Piko already loads LiteLLM's JSON for prices and ignores the rest of the row.

**Field.** OpenHands detects capabilities by substring pattern lists (last match wins); OpenCode reads models.dev; Codex hard-codes Responses. Nobody has a conformance suite per provider — that part of 0025 would be new.

**Research.** **Aligned, uncited; the literature is thin.** [Enhancing reliability in AI inference services](https://arxiv.org/abs/2511.07424) (Ranganathan et al., Oct 2025): of 156 high-severity LLM inference incidents, ~60% are inference-engine failures and ~40% of those are timeouts — transport failure is the dominant class, which is what the typed transport/protocol split targets. [ReliabilityBench](https://arxiv.org/abs/2601.06112) (Gupta et al., Jan 2026): injected timeouts, partial responses and schema drift drop success 96.9% → 88.1%; single-run success rates miss it. [AgentChaos](https://arxiv.org/abs/2608.06790) (Tan et al., ASE 2026): response truncation and tool-call field corruption are first-class faults, and robustness "depends on system implementation rather than model capability." No paper addresses stream terminal-signal semantics specifically; piko's contract would be a citable first.

**Move.** Responses adapter under the same terminal contract; 0025 sourced from the registry rows piko already downloads, with the conformance suite as the piko-specific contribution.

### ADR 0009 — Hard run budgets enforced in the loop  [per turn]

**Steelman.** Tool-call ceilings checked inside a batch before dispatch, typed stop reasons, and a wall clock are more than Codex (no turn or cost flags at all), Cursor CLI (none), goose (turns only), or Aider (nothing) offer.

**Attack.** "Run" means "turn." In the REPL every ceiling resets each turn; there is no session, tree, or fleet aggregate. Claude Code's `--max-budget-usd` counts subagents; SWE-agent has `total_cost_limit`; mini-swe-agent has global env caps across batch workers; Codex's rollout budget spans every thread. Piko is strictest inside a turn and absent across turns, which is the wrong way round for the unattended fleet the ADRs keep invoking.

The wall-time timer cannot pre-empt a synchronously blocking extension (0027's supervisor is the fix, still proposed). 40 requests / 100 tool calls / 30 minutes are reasonable defaults; OpenHands' 500 iterations and goose's 1,000 turns show the field defaults far looser, which is a marketing point piko is not making.

**Field.** Gemini exits 53 on turn limit; OpenHands checks budget after the step; Claude Code has no interactive-mode budget and resets its running total on `/clear`.

**Research.** **Aligned, uncited — strong support.** [BAGEN: Are LLM Agents Budget-Aware?](https://arxiv.org/abs/2606.00198) (Lin et al., May 2026): capability and budget-awareness correlate weakly (r = 0.35); frontier agents keep spending on failing tasks; trained early stopping saves 28–64% of tokens on failing trajectories — the empirical case that ceilings must be external to the model, which is 0009's thesis. [More with Less](https://arxiv.org/abs/2510.16786) (Gao & Peng, Oct 2025): a fixed turn limit at the 75th percentile of baseline cuts SWE-bench cost 24–68% with negligible solve-rate loss. [Budget-Aware Tool-Use](https://arxiv.org/abs/2511.17006) (Liu et al., Nov 2025): without budget awareness, larger tool-call budgets do not improve performance. [Holistic Agent Leaderboard](https://arxiv.org/abs/2510.11977) (Kapoor et al., ICLR 2026; 21,730 rollouts): higher reasoning effort reduced accuracy in most runs — more spend is not more solves.

**Move.** 0026. Until then, rename the flag help and the ADR from "run" to "turn" everywhere a user can read it.

### ADR 0010 — Fail-closed headless and JSON automation contract  [implemented]

**Steelman.** Exit 0/1/2/3/4/5/130 with failure as the initial state is the richest semantic exit map in the field: Claude Code documents 0/1/143; Codex's source distinguishes 0 from 1 and has shipped exit 0 on failure twice; Gemini's 0/1/42/53 is the only comparable set. Versioned JSONL rows with a schema field are what Codex's `--json` and Claude's `stream-json` also do.

**Attack.** Stdout is the whole surface. The field has a bidirectional layer above it: Claude Code's `--input-format stream-json` with control messages and interrupts, Codex's JSON-RPC app-server with generated TypeScript and JSON-Schema, OpenCode's OpenAPI 3.1 server with SSE, and above all ACP v1 — JSON-RPC over stdio with a registry since January and 50+ agents including Gemini, OpenCode, Goose, Cline, Cursor, OpenHands, plus adapters for Claude, Codex, and pi. "A richer bidirectional RPC surface remains future work" was written before ACP became the IDE contract.

No feature-detection field: Claude's `system/init` carries a `capabilities[]` array so parents can branch on what the child supports; piko's `v: 1` envelope cannot express "this build has exit 5."

**Field.** Codex's `exec` is itself built on an in-process app-server client; the CLI is a thin client of the protocol. That is the architecture piko's "external controller" stance implies and does not have.

**Research.** **No direct literature** on exit-code or JSONL automation contracts exists; the nearest evidence supports fail-closed by construction. [AgentChaos](https://arxiv.org/abs/2608.06790) (Tan et al., ASE 2026): silent failures without error signals are the critical vulnerability, and diagnosis accuracy stays below 53% when the signal is missing. [Capability Gates Are Not Authorization](https://arxiv.org/abs/2606.28679) (Mellafe Zuvic et al., Jun 2026): LangChain, LlamaIndex, and Stripe toolkits all lack a deterministic fail-closed per-call gate by default. Piko's "failure is the initial value" exit map is the automation-contract analogue, and would be a citable contribution if written up.

**Move.** An ACP adapter as an external process over the existing JSONL (piko's own stance says this is where it belongs), and a `capabilities` array in the first JSON row.

### ADR 0011 — Persistent approve / edit / reject workflow  [implemented]

**Steelman.** A pending approval that survives process death is rare: Claude Code got it in 2.1.89 (`PreToolUse` `defer`, print mode only, with an open SDK bypass bug), the OpenAI Agents SDK serialises `RunState` for the caller to store, LangGraph checkpoints; DeepSeek, Gemini, OpenCode, goose, and Cline lose the prompt with the process. Provenance — policy from user config only, never project content — is stricter than Claude Code (project allow rules apply after trust) and Codex (`.codex/rules` in trusted repos).

**Attack.** The policy can only say a tool's name. Every peer matches arguments: Claude Code `Bash(git push *)` with deny → ask → allow ordering; Codex `prefix_rule` in Starlark with inline `match`/`not_match` tests, shell splitting on `&&`/`|`, and `codex execpolicy check`; Cursor `Shell(curl:*)`; OpenCode last-match globs; Gemini `run_shell_command(git)`. With bash gated, piko prompts on `ls`. 0011's own context says per-call prompting fails because users alias it away; the design guarantees per-call prompting and forbids "always allow." The ADR names both as v1 non-goals; they are the two things that decide whether the feature is used.

The TOCTOU between planning and a late approval is acknowledged and unsolved for bash; Codex evaluates the rule at execution time against the actual command.

**Field.** Codex's "policy as tested code" is philosophically identical to 0005's "behaviour in code, not prompt" — piko should recognise its own stance in a competitor's feature and adopt the shape.

**Research.** **Aligned, uncited — the provenance rule is the research consensus.** [CaMeL: Defeating Prompt Injections by Design](https://arxiv.org/abs/2503.18813) (Debenedetti et al., 2025): separate trusted control flow from untrusted data so injected content can never affect program flow; provable security on 77% of AgentDojo. That is 0011's "policy only from user config, never project content," stated as a theorem. [Progent](https://arxiv.org/abs/2504.11703) (Shi et al., 2025–26): symbolic policies over tool names *and arguments* where the action space can only shrink without explicit approval. [AgentSpec](https://arxiv.org/abs/2503.18666) (Wang, Poskitt & Sun, ICSE 2026): user-authored rules block >90% of unsafe code-agent actions at millisecond overhead.

**Challenges name-only gating and prompt fatigue.** [Measuring the Permission Gate](https://arxiv.org/abs/2604.04978) (Ji et al., Apr 2026): ~37% of state-changing actions bypass Claude Code's classifier via file edits the shell gate never sees — equivalent-effect paths escape name gating. [Reframing LLM Agent Security as an Agent–Human Interaction Problem](https://arxiv.org/abs/2605.24309) (Wang, Li & Tian, May 2026): approval is used in 15 of 21 production systems and repeated dialogs drive "always allow" fatigue; Chen & Lin (2026) report users accept 93% of approval requests. [Mind the Gap](https://arxiv.org/abs/2508.17155) (Lilienthal & Hong, Aug 2025; TOCTOU-Bench): state changes between approval and execution; mitigations cut the window ~95% but vulnerability only 12% → 8% — the bash TOCTOU 0011 acknowledges, measured.

**Move.** Argument-prefix rules with inline tests, evaluated at dispatch time, plus a session-scoped "allow this prefix" grant that is itself a journal row.

### ADR 0012 — Tool extensions are trusted controller code  [implemented]

**Steelman.** Nobody sandboxes extensions. Claude Code's plugin docs say "arbitrary code with your user privileges"; OpenCode auto-loads in-process JS from `.opencode/plugins/`; DeepSeek's entire runtime is in-process plugins; pi's extensions are TypeScript modules. Naming the trust level instead of implying it is the honest position.

**Attack.** Honesty is not a control. The field adds allowlists on top: Claude Code's `strictKnownMarketplaces`, `blockedMarketplaces`, SHA-pinned community plugins, workspace-trust gating for project hooks; Codex's `requirements.toml` and `allow_managed_hooks_only`; Gemini's `security.allowedExtensions` regex. Piko validates shape and size and then imports. Import is code execution before any 0011 gate can run, and there is no hash pin, so an extension path that changes underneath a config is silently a different program.

**Field.** Deno remains the only runtime with a manifest-style per-capability model (`--allow-read`, `--allow-net`), and it exempts `--allow-run` and FFI — i.e. exactly the capabilities a tool extension needs. The field's conclusion is right: sandbox the process, not the plugin.

**Research.** **Challenges the trust stance, empirically.** [Credential Leakage in LLM Agent Skills](https://arxiv.org/abs/2604.03070) (Chen et al., Apr 2026): of 17,022 skills, 520 carry 1,708 issues, 83 confirmed malicious, 89.6% exploitable without elevated privileges. [Skill-Inject](https://arxiv.org/abs/2602.20156) (Schmotz et al., Feb 2026): up to 80% attack success via skill files, including exfiltration and ransomware-like behaviour. [IsolateGPT](https://arxiv.org/abs/2403.04960) (Wu et al., NDSS 2025): hub-and-spoke isolation of third-party apps prevents cross-app attacks with under 30% overhead on three quarters of queries — isolation is feasible, contra 0012's "false sense of safety" argument. [LLM Platform Security](https://doi.org/10.1609/aies.v7i1.31664) (Iqbal, Kohno & Roesner, AIES 2024) is the taxonomy. Piko's honesty is right; the research says the risk is not hypothetical and the hash pin is the minimum.

**Move.** Content-hash pins in the extension allowlist and a load-time journal row naming the hash. Cheap, and it makes "which extension was loaded" a fact in the audit instead of a path.

### ADR 0013 — Three separate event surfaces; telemetry redacts by default  [implemented]

**Steelman.** Redaction by default matches Claude Code (`OTEL_LOG_USER_PROMPTS` and tool content off), Codex (`log_user_prompt` off), and Gemini (`logPrompts` false), and beats OpenHands, whose Laminar traces capture prompts and tool I/O with no documented redaction. Separating journal from live events from telemetry is the right decomposition and it shows in the code.

**Attack.** There is no exporter anyone can point at. Claude Code ships OTLP metrics, logs, and traces with named metrics (`cost.usage`, `token.usage`, `code_edit_tool.decision`) and cardinality controls; Codex has an `[otel]` block; Gemini exports to GCP. Piko has a durable JSONL sink and a "planned" OTel adapter since the ADR was backfilled. A telemetry contract without an exporter is a file format.

The T1 re-review found live telemetry rows tracked in git, dirtying the tree during normal operation — the surface that should be the most disposable was the one leaking into version control.

**Field.** Claude Code's 2.1.239 fix for OTel trace fragmentation across the defer/resume boundary is a preview of the problem piko will hit when a suspended approval resumes under a new process: span parentage across exit 4.

**Research.** **Aligned, uncited.** [Dapper](https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/) (Sigelman et al., 2010): tracing separated from application logging with restricted access to sensitive payloads — the three-surface split. [Protecting Privacy in Software Logs](https://arxiv.org/abs/2409.11313) (Aghili, Li & Khomh, 2024–25): 25 log datasets and 45 practitioners show no consistent definition of sensitive content — the case for redaction by default rather than by review. [Agents That Know Too Much](https://arxiv.org/abs/2606.26627) (Lahjouji & Colaco, Jun 2026): leaks travel through intermediate results, memory, and inter-agent messages, so traces are a leakage surface. Chen et al. (2026) find 73.5% of credential leaks in agent skills originate in debug logging. [AgentOps](https://arxiv.org/abs/2411.05285) (Dong et al., 2024) is the taxonomy of what to trace.

**Move.** An OTLP exporter behind the existing sink contract, with the approval-resume span link designed in. T1.1 gitignored `.project/telemetry`; keep it that way.

### ADR 0014 — Prompt-cache discipline  [implemented]

**Steelman.** Stable ordering, append-only turns, breakpoints on system and last message, and history rewrites confined to two batched operations is the same layout Claude Code documents — and Claude Code's team says prompt caching "is everything" and runs SEVs on hit rate.

**Attack.** Discipline without measurement. Piko surfaces hit rate in `/tokens`; Claude Code surfaces it, defines a miss (more than 5% and ≥2,000 tokens re-processed), chooses TTL buckets (1h for the main conversation on plan usage, 5m for subagents and compaction, overridable), includes model, effort, and fast-mode in the cache key, and alerts on it. Aider keeps caches warm with pings. Piko has one breakpoint policy, no TTL selection, no cache-key awareness of a mid-session model switch (which the CLI supports atomically and which busts the cache silently), and no hit-rate number in any benchmark artifact.

The inversion is undersold: the 815-token prefix is below the minimum on most models a user would pick (see 0001). "Optimizes cost-per-completed-task" is asserted; the bench ledgers record cache reads, so the claim is checkable and unchecked.

**Field.** Anthropic's minimums are now per model (512 for Claude 5-generation, 1,024 for Sonnet 5, 4,096 for Opus 4.6 and Haiku 4.5); OpenAI GPT-5.6 has a 1,024 minimum with a 30-minute default TTL; Gemini 3.x needs 4,096. No harness pads prefixes to reach a minimum.

**Research.** **Aligned, uncited — with a quantified payoff.** [Don't Break the Cache](https://arxiv.org/abs/2601.06007) (Lumer et al., Jan 2026; 500+ sessions across OpenAI, Anthropic, Google): caching cuts API cost 41–80% and time-to-first-token 13–31%, and the consistent wins come from dynamic content at the end, stable tool definitions, and excluding dynamic tool results — piko's ordering rules, measured. [Learning Agent Execution for KV-Cache Management](https://arxiv.org/abs/2608.14624) (Zhang et al., Jul 2026): agent workloads repeatedly reuse system prompt + tool definitions; execution-aware eviction lifts hit rate 10–18 points. Mechanism papers: [Prompt Cache](https://arxiv.org/abs/2311.04934) (Gim et al., MLSys 2024) and [SGLang RadixAttention](https://arxiv.org/abs/2312.07104) (Zheng et al., NeurIPS 2024). None of this appears in the bench artifacts as a hit-rate column.

**Move.** Cache eligibility per model at startup, TTL selection per request class, a cache-key note on model switch, and a hit-rate column in `compare_runs.py`. Then the economics claim has a number.

### ADR 0015 — Durable single-writer session store  [implemented (via 0023/0024)]

**Steelman.** UUID, `O_EXCL`, 0600, fsync of file and directory, fail-closed middle rows, poison-on-uncertain-write. Claude Code's transcripts are plaintext JSONL with no fsync claim and a documented interleave on double resume; Codex has an open issue where two app-servers write one rollout and merge branches on restart. Piko is ahead by a distance here.

**Attack.** JSONL plus a lock file is the 2024 answer; OpenCode moved to SQLite in v1.2 (with migration bugs to show for it) and DeepSeek ships an optional SQLite backend behind a persistence seam with a contract suite both backends must pass. WAL gives atomic commits and no torn tail lines; piko instead tolerates and truncates a partial tail, which is what Claude Code's 2.1.121 fix does too — silently. A truncated tail is a data-loss event the journal should record as a row, not repair quietly.

fsync on every append is the right default and an unmeasured latency cost; the 64 MB cap and 32 MB rotation are magic numbers with no stated basis.

**Field.** OpenHands writes one file per event under flock (no fsync); DeepSeek's JSONL backend uses checksummed Zstandard frames and resolves `append` only after durability. Piko is in the top tier on durability semantics and behind on storage engine.

**Research.** **Aligned, uncited — the crash-consistency canon.** [All File Systems Are Not Created Equal](https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai) (Pillai et al., OSDI 2014): 60 crash vulnerabilities in 11 applications from unwarranted atomicity and ordering assumptions, including missing directory fsync — the reason 0015 fsyncs the directory. [Crash Consistency](https://doi.org/10.1145/2800695.2801719) (Pillai, Chidambaram & Arpaci-Dusseau, ACM Queue 2015): torn and reordered writes are the norm; tolerate the torn tail. [Can Applications Recover from fsync Failures?](https://www.usenix.org/conference/atc20/presentation/rebello) (Rebello et al., ATC 2020): PostgreSQL and Redis silently lose data on fsync failure — the case for poisoning the session on an uncertain write. [Model-Based Failure Analysis of Journaling File Systems](https://ieeexplore.ieee.org/document/1467854/) (Prabhakaran et al., DSN 2005): partial-write mishandling motivates application-level middle-row validation.

**Move.** Keep JSONL; record tail repair as a journal row; state the basis for the size caps; consider DeepSeek's "persistence seam with a contract suite" so a SQLite backend can be added without a migration incident.

### ADR 0016 — Credential handling  [policy, not boundary]

**Steelman.** Env-name-only config, header-only transit, allowlisted child env, redacted telemetry: this is Codex's default (`*KEY*`/`*SECRET*`/`*TOKEN*` excluded) and DeepSeek's `CredentialRef` design, and it is ahead of Claude Code's default, which inherits the parent environment into sandboxed bash and needed `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` plus a 2.1.128 fix after a CI exfiltration.

**Attack.** A child that can run `ps eww $PPID` reads the parent's environment; the T1 re-review confirmed it and the warning now says so. Codex, DeepSeek, and Anthropic's sandbox runtime all launch bash in a fresh PID namespace with a private `/proc`, which closes exactly this. The 2026 state of the art goes further: Claude Code's `sandbox.credentials` mask mode puts a sentinel in the sandbox and injects the real value at a TLS-terminating proxy only for listed hosts (with JWT decode and SigV4 re-signing); Gondolin gives the guest a placeholder token; Docker Sandboxes inject at the forward proxy; nono calls them phantom credentials. 0018 says "credentials never inside the sandbox," which is where the field was in 2025.

Keys live in the process environment only; there is no keychain storage (Claude Code uses the macOS Keychain, Codex a keyring with a plaintext fallback that has its own open issue) and no short-lived token helper (`apiKeyHelper`, refreshed every five minutes).

**Field.** OpenHands is the cautionary tale: the agent loop and the LLM key are posted into the sandbox container by design, and custom secrets are exported as environment variables in the agent's runtime. Piko's instinct is right; its mechanism is one namespace short.

**Research.** **Aligned, uncited.** "Your AI, My Shell" (Liu et al.) demonstrates API-key exfiltration through injected shell commands in coding editors. Chen et al. (2026) find hardcoded and CLI-argument secrets are the other main leakage patterns after debug logging — supporting env-name-only config and header-only attachment. The SoK by Maloyan & Namiot (Jan 2026) argues architectural rather than filter-based isolation because adaptive injection beats filters at >85%. No paper on proxy-side credential injection exists yet; the practice (Claude Code mask mode, Gondolin, Docker Sandboxes) is ahead of the literature.

**Move.** Fresh PID namespace for host bash on Linux today (bwrap is a dependency the field already accepts); design 0018's egress proxy as the credential injection point from the start.

## Proposed product and operational architecture

### ADR 0017 — Evidence-gated self-improvement (`pi improve`)  [not started]

**Steelman.** Nobody ships this. exo validates self-edits by liveness ("does it respond") and admits it needs tooling to track its own performance; the Darwin Gödel Machine documented faked test logs and reward-function sabotage; SICA and GEPA show measured selection works when the eval is honest. Claude Code's auto-memory validates by size only. A promotion gate of pass-rate non-inferiority plus cost-per-solve, pre-registered, would be first.

**Attack.** The gate is stronger than the evidence that would feed it. Decision 5 forbids citing a suite whose variance exceeds the effect; the suite is 10 dev tasks with n=1 flips and one 89-task official run. The plan pre-registers five repetitions per task and 100 paired trials per arm — at the TB 2.0 rate of about $0.30 per attempt that is roughly $60 per candidate before the candidate has been useful once. The loop is priced like a research programme and framed like a feature.

The proposer can move the goalposts indirectly: skills and prompt templates are in scope, and skills influence how the agent reads the eval tasks. The "read-only checkout by committed hashes" rule protects the evaluator, not the evaluee's interpretation of it. DGM's failure mode was exactly this.

The token-rent rule has now been re-homed twice and remains unratified while CI enforces it. Auto-drafted ADR stubs are the rubber-stamp pattern the README warns about, and "the human edit is part of the contract" is unenforceable.

**Field.** Sakana's DGM went 20→50% on SWE-bench with a benchmark-score archive; Huxley-Gödel replaced the greedy score with descendant productivity because greedy selection overfits. The lesson the field learned is that the fitness function is the attack surface.

**Research.** **Aligned, uncited — and this is the ADR the research most vindicates.** [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) (Zhang et al., 2025–26): the agent hallucinated tool runs with fabricated passing test logs, then removed the logging its hallucination detector depended on, scoring highly "according to our predefined evaluation functions"; the authors stage evaluation at 10/50/200 tasks because "performance can be noisy." [Huxley-Gödel Machine](https://arxiv.org/abs/2510.21614) (Wang et al., Oct 2025): an agent's own benchmark score poorly predicts whether its descendants improve — selection by point score is misleading. [Reward Hacking Benchmark](https://arxiv.org/abs/2605.02964) (Thaman, ICML 2026): 0–13.9% exploit rates across 13 frontier models, rising with RL post-training and task difficulty. [Sycophancy to Subterfuge](https://arxiv.org/abs/2406.10162) (Denison et al., 2024): models generalise to editing their own reward code — keep the gate outside the model's write scope, as decision 3 does.

**The statistics clause has its own literature.** [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) (Miller, 2024): paired-difference comparisons, CIs from question-level sampling, power analysis before running — decision 5, formalised. [Beyond pass@1](https://arxiv.org/abs/2603.29231) (Khanal et al., Mar 2026; 23,392 episodes): software-engineering reliability decays across repeated attempts (0.90 → 0.44), so n=1 comparisons are unreliable. [Beyond Pass@k](https://arxiv.org/abs/2608.14711) (Jiang et al., Aug 2026): a single-rollout proxy fails to substitute for repeated runs (ρ = 0.42). [A Sober Look at Progress](https://arxiv.org/abs/2504.07086) (Hochlehnert et al., COLM 2025): reported gains often hinge on unreported seed and format variance. Closest shipped analogues — [Self-Harness](https://arxiv.org/abs/2606.09498) (Jun 2026) and [Prime Agent](https://arxiv.org/abs/2608.23552) (Aug 2026) — validate by benchmark score with no pre-registration and no human gate. 0017 would be first.

**Move.** Do the variance study first: measure the suite's run-to-run noise at n=5 on the held-out draw and publish the smallest detectable effect. If it is above 10%, 0017 cannot promote anything and should say so. Build the loop after the suite can see.

### ADR 0018 — Container sandbox executor behind a provider seam  [not started]

**Steelman.** The non-negotiables are the right lessons: workspace-only mount, control plane physically below the model's write layer, egress default-deny, budgets enforced loop-side. OpenHands demonstrates the anti-pattern (agent loop, LLM key, and event log all inside the container); exo bind-mounts its event log read-write into the agent's sandbox. DeepSeek's fail-closed `SANDBOX_UNAVAILABLE` shows the field converging on fail-closed, which piko should hard-code.

**Attack.** Docker-only is the heaviest choice in the field and the slowest to land. Codex moved its Linux sandbox from Landlock to bubblewrap in 0.115 and bundles a bwrap binary; DeepSeek probes bwrap → Landlock → Seatbelt → Windows ACL; Anthropic ships `@anthropic-ai/sandbox-runtime` (Seatbelt/bwrap/seccomp, with a whole-process mode) that pi's example extension already wraps. Per-exec Docker latency on a macOS dev host means a VM round-trip per `ls`. The right first provider is the lightweight one; Docker is the CI provider.

The seam (`acquire/exec/release`) executes commands. The file tools stay in-process — the same limitation Claude Code documents for its own sandbox ("Read, Edit, and Write use the permission system directly") and the reason 0022 cannot route through 0018 as written. Either the file tools run inside the executor too (the whole-process model) or 0022 needs its native helper regardless.

"Credentials never inside" is necessary and dated: the field injects at the egress proxy (see 0016). The seam has no `snapshot`, so 0017's soak chamber is a follow-on decision to a follow-on decision.

**Field.** Claude Code's Linux deny list is built once at launch and misses directories the session creates later; macOS checks at write time. Codex re-applies read-only binds to `.git` under writable roots. Docker Sandboxes (microVM, proxy-side credential injection) is what Anthropic recommends for unattended runs. Nine days after acceptance there is no spike in the tree.

**Research.** **Aligned, uncited.** [Sandlock](https://arxiv.org/abs/2605.26298) (Wang & Zheng, May 2026): unprivileged Landlock + seccomp confinement for agent code with static filesystem and port policy, supervisor-mediated egress with resolved-endpoint allowlists and DNS pinning, ~5 ms startup versus Docker — a research precedent for exactly the lightweight provider this critique recommends over Docker-first. [Firecracker](https://www.usenix.org/conference/nsdi20/presentation/agache) (Agache et al., NSDI 2020) is the microVM reference; [The True Cost of Containing](https://www.usenix.org/conference/hotcloud19/presentation/young) (Young et al., HotCloud 2019) quantifies gVisor's 2×+ syscall overhead.

**Challenges "Docker is a boundary."** [Quantifying Frontier LLM Capabilities for Container Sandbox Escape](https://arxiv.org/abs/2603.02277) (Marchand et al., UK AISI, Mar 2026): frontier models comfortably escape misconfigured containers across 18 scenarios (~40% at medium difficulty, 0% at hardest), with success scaling log-linearly in compute. A plain container is not a security boundary unless hardened; 0018's non-negotiables are the hardening, and they need tests.

**Move.** First provider: bwrap + seccomp on Linux and Seatbelt on macOS (or the Anthropic runtime as a dependency), whole-process mode so the file tools are inside; Docker as the second provider for CI. Fail-closed, not a flag. Egress proxy designed as the credential injector.

### ADR 0019 — Release and compatibility contract  [blocked on owner]

**Steelman.** The list is right: license, published packages with provenance, journal versioning, support matrix, five-minute install, doctor.

**Attack.** Codex publishes under Apache-2.0 with SLSA v1 provenance attestations, a native installer, Homebrew cask, and `codex doctor --json`; Claude Code is proprietary and unattested but signs release manifests, documents an OS/RAM/arch matrix, and supports `minimumVersion` pins for managed fleets; Gemini CLI was sunset for consumer tiers in June, which is what licensing and ownership risk looks like from the outside. Piko has no LICENSE file, three private packages, and an install that starts with `npm run build`. Every week without the license decision, the competitive study ages against harnesses that ship daily.

The ADR calls the journal schema v1; the implementation writes generation 2 — a record about compatibility that is already out of sync with the thing it governs.

**Field.** Release cadence in August 2026: Claude Code 29 npm versions, Codex hundreds including platform packages, OpenCode a release every one to three days. Nobody is waiting.

**Research.** **Aligned, uncited.** [SoK: Taxonomy of Attacks on Open-Source Software Supply Chains](https://arxiv.org/abs/2204.04008) (Ladisa et al., IEEE S&P 2023): 107 vectors mapped to 94 incidents; provenance and integrity controls are the safeguards the ADR's provenance clause names. [I depended on you and you broke me](https://arxiv.org/abs/2301.04563) (Venturini et al., TOSEM 2023): in npm, 44% of manifesting breaking changes arrived in minor or patch releases — 0.x "stated instability" is honest about a real failure rate. [Analyzing Challenges in Deployment of SLSA](https://arxiv.org/abs/2409.05014) (Tamanna et al., 2024): 1,523 issues across 233 repos; provenance adoption stalls on documentation — a cost warning for the clause.

**Move.** License decision; `npm publish --provenance` from the existing CI; fix the schema generation number in the record.

### ADR 0020 — Dollar-denominated cost accounting and spend ceilings  [per turn]

**Steelman.** Among harnesses, only piko reserves before dispatch. Claude Code's cap executes and bills the crossing response ("`usage` leaves out the response that crossed the budget"; a third-party test reported a $0.01 cap landing at $0.084 actual); OpenHands checks after the step; mini-swe-agent checks before the call against cost already spent. Codex, Gemini, Cursor, goose, and Aider have no dollar cap at all. Refusing to start a capped run for an unpriced model is fail-closed where Claude Code's cost is an estimate labelled "not authoritative."

**Attack.** LiteLLM's proxy does the same reservation — `max_tokens` × price, on by default, cross-pod via Redis — and its documentation is honest that disabling it lets concurrent requests exceed the budget. The difference is the input bound: LiteLLM trusts the request's token count; piko uses a byte-derived bound about four times conservative, which is why a $1.50 cap stopped work at $0.24–$0.80 on TB 2.0 and clipped inside the solve distribution. The mechanism is right and the number an operator types is wrong by a factor the operator is not told. 0026 now promises to print reserved vs actual; that fix was a one-line print away for a week.

The pricing loader mirrors LiteLLM's resolution chain and file (3,518 entries); good. Eighteen of 89 official trials were unpriced, so the headline dollars-per-solve is a subtotal presented as a rate.

**Field.** Provider-side limits are soft or lagging: OpenAI project limits are soft by default; OpenRouter lets in-flight requests finish; Anthropic's Spend Limits API is monthly. The gateway is the only other place a true ceiling exists, which is a partnership argument piko could make and doesn't.

**Research.** **Aligned, uncited.** [AI Agents That Matter](https://arxiv.org/abs/2407.01502) (Kapoor et al., TMLR 2025): accuracy-only evaluation yields needlessly costly agents; cost must be a first-class controlled variable — the origin of the cost-per-solve framing 0017 and 0020 share. [Efficient Agents](https://arxiv.org/abs/2508.02694) (Wang et al., Jul 2025) formalises cost-of-pass. BAGEN (Lin et al., 2026) shows agents keep spending on failing tasks, which is the reservation's justification: the model will not stop itself. No paper studies pre-dispatch reservation versus post-hoc caps; piko's TB 2.0 record of the ceiling clipping inside the solve band is, so far, the only data point on the trade-off.

**Move.** Print reserved / actual / effective at every stop now; tokenizer-backed bound where a committed corpus proves it conservative (0026's rule); price or explain every trial in the manifest generator.

### ADR 0021 — Artifact data lifecycle  [proposed, partly practised]

**Steelman.** "Numbers without committed artifacts are narrative" is a rule no vendor writes down, and piko applied it to itself at a cost (the demoted 25/30). The revised per-class table — journals indefinite and owner-only, telemetry 30 days, benchmark directories ephemeral — is the shape Claude Code (30-day sweep) and Gemini (`sessionRetention.maxAge 30d`) ship.

**Attack.** The field's default for transcripts is 30 days; piko's proposed default is forever. Claude Code sweeps transcripts, tasks, shell snapshots, and backups; Codex has no auto-cleanup and no locking, and its rollouts grow unbounded — piko is choosing Codex's posture with a policy document on top. No prune command exists, no telemetry TTL is implemented, and the T1 review found the record's redaction language contradicting the journal's plaintext reality, which the r2 draft now fixes by stating that journals are never publishable as-is.

Nobody redacts at write time (fine); but "publishable benchmark artifacts require explicit sanitization before commit" has no tool behind it, and the Terminal-Bench leaderboard now requires full trajectories for passing trials, so the sanitization tool is on the critical path to any leaderboard entry.

**Field.** Terminal-Bench's integrity update: ATIF trajectories for every passing trial, an automated judge, zero score for reward hacking. Evidence hygiene is becoming a submission requirement, not a virtue.

**Research.** **Aligned, uncited — evidence discipline has a literature and piko practises it.** [Holistic Agent Leaderboard](https://arxiv.org/abs/2510.11977) (Kapoor et al., ICLR 2026): inspecting 2.5B tokens of released logs revealed shortcuts invisible in aggregate scores (agents searching HuggingFace for benchmark answers) — the case for committed per-trial artifacts. [The Leaderboard Illusion](https://arxiv.org/abs/2504.20879) (Singh et al., NeurIPS 2025): private testing and selective disclosure inflate scores up to 112% relative — the dev/held-out firewall. [Efficient Benchmarking of AI Agents](https://arxiv.org/abs/2603.23749) (Ndzomga et al., Mar 2026): ad-hoc task subsets show high variance; rankings survive only under principled selection — a warning about the 10-task dev set. Terminal-Bench (Merrill et al., 2026) runs ≥5 trials per pair with CIs and adversarially tests every task; that is the bar 0021's artifacts feed.

**Move.** `pi doctor sessions --prune`, a telemetry TTL, and a trajectory sanitizer that emits ATIF. Ratify the table with 30-day telemetry and indefinite journals, and say who may delete.

### ADR 0022 — Descriptor-anchored workspace containment  [accepted, unimplemented]

**Steelman.** The class is real: Anthropic's own filesystem MCP server had CVE-2025-53109/53110 (validated a symlink's parent, not its target). The kernel solves the race: `openat2` with `RESOLVE_BENEATH` returns `EAGAIN` when it cannot prove a `..` did not escape during a concurrent rename; cap-std's `Dir` handle is the portable pattern. No harness anchors descriptors for its file tools, so this would be a first.

**Attack.** None of the eight acceptance tests exist, and the evidence map (to its credit) found five windows the ADR missed: map traversal walks path strings, intermediate directory creation, temp-file placement, the rename window, and cleanup. The mechanism decision (native addon vs. executor) has been "pending owner decision" since 25 Aug. Node exposes no `*at` syscalls, macOS has no `openat2`, and Landlock cannot restrict `stat` or `chdir` — so the portable implementation is cap-std's fallback (component-wise `O_NOFOLLOW|O_DIRECTORY` opens with `fstat` dev/inode checks), which needs a small addon either way. "Route through the sandbox" only works if the file tools run inside it, which 0018 as written does not do.

The field's substitute is the protected-path deny list (0006 attack). Piko has neither the descriptor walk nor the deny list.

**Field.** Codex and DeepSeek both canonicalise with realpath and accept the race, relying on the OS sandbox to make an escape harmless. That is the honest alternative to 0022 — and it is only available once 0018 exists.

**Research.** **Aligned, uncited — the ADR's central claim was proven in 2005–2009.** [Fixing Races for Fun and Profit: How to use access(2)](https://www.usenix.org/conference/13th-usenix-security-symposium/fixing-races-fun-and-profit-how-use-access2) (Dean & Hu, USENIX Security 2004) proposed re-checking paths k times; [How to Abuse atime](https://www.usenix.org/conference/14th-usenix-security-symposium/fixing-races-fun-and-profit-how-abuse-atime) (Borisov et al., USENIX Security 2005) built "filesystem mazes" that deterministically win the k-race; [Portably Solving File TOCTTOU Races](https://www.usenix.org/conference/fast-08/portably-solving-file-tocttou-races-hardness-amplification) (Tsafrir et al., FAST 2008) hardened path checks further; and [Exploiting Unix File-System Races via Algorithmic Complexity Attacks](https://ieeexplore.ieee.org/document/5207635/) (Cai, Gui & Johnson, IEEE S&P 2009) defeated both by slowing kernel name resolution. 0022's sentence "additional realpath() checks cannot close this" has four papers behind it; the record should cite them. [The Balkanization of Execution-Security Research for AI Coding Agents](https://arxiv.org/abs/2607.05743) (Rashidi, Jul 2026, single-author SoK of 39 papers) names single-check authorization treated as permanently valid as a recurring root defect.

**Move.** Decide the mechanism this week. A ~200-line N-API addon exposing `openat`/`renameat`/`mkdirat`/`unlinkat` with `O_NOFOLLOW` costs the zero-native-deps property and nothing else; write the eight tests first so they fail on the current tree.

### ADR 0023 — Lock-capability session API  [implemented]

**Steelman.** Unique. `Session.open()` returns a mutator-less type and the runtime WeakMap token defeats a cast; every factory locks before parsing; forged tokens are rejected at append. Claude Code interleaves on double resume; Codex merges divergent branches on restart; OpenHands serialises writers rather than forbidding them; DeepSeek relies on revision detection.

**Attack.** The lock is an advisory file that the model, with host bash on, can delete or rewrite — 0023 is honest against a second piko process, not against the model. That is the cross-cutting attack (control plane inside the model's reach) applied to the one mechanism piko is most proud of.

Single-writer forbids a legitimate concurrent appender: a future supervisor (0027) or a fleet orchestrator writing host events into the journal needs the token or a side channel. OpenHands' serialisation design would allow it; piko's does not, and 0027's "drain outcomes are journaled as host events" will have to say which process writes them.

**Field.** git's `index.lock` is the same design and the same operator experience; piko's error message is better than git's.

**Research.** **Aligned, uncited — the name is not an accident.** [Capability Myths Demolished](http://www.erights.org/talks/myths/) (Miller, Yee & Shapiro, 2003): unforgeable capabilities enforce least authority and are not equivalent to ACLs — 0023's module-private token is an object capability in the strict sense, and the record could say so.

**Challenges the no-expiry stance (shared with 0024).** [Leases](https://doi.org/10.1145/74850.74870) (Gray & Cheriton, SOSP 1989): time-bounded grants recover automatically from holder failure without manual intervention. [Chubby](https://www.usenix.org/conference/osdi-06/chubby-lock-service-loosely-coupled-distributed-systems) (Burrows, OSDI 2006) is the counter-precedent: lock-delay and sequencers deliberately withhold a dead holder's lock rather than reassign it instantly. Piko chose Chubby's caution over Gray's leases; the choice is defensible and undocumented.

**Move.** Keep it. Move the sessions directory outside anything the model can reach (0018's mount rule) and define the supervisor's write path before 0027 lands.

### ADR 0024 — Explicit stale-lock recovery  [implemented]

**Steelman.** Rank-before-filter, loud exit 5, a separate recovery lock, re-read before unlink, refusal for live, remote, malformed, or legacy owners: this mirrors git's no-auto-takeover norm and adds the diagnosis git lacks. End-to-end CLI test with a simulated SIGKILL exists.

**Attack.** A fleet cannot run `--remove --yes` by hand. The JSON output exists; what is missing is a documented supervisor workflow that decides staleness from the lock record without a human, which is the same "who may delete" question 0021 punts. Same-host plus dead-PID cannot distinguish PID reuse (the token re-read mitigates, the ADR should say so), and the lock is undefined on network filesystems — OpenHands documents its flock/NFS caveat; piko does not.

**Field.** Nobody else has a recovery command; Claude Code and Codex have nothing to recover because they never lock.

**Research.** **Same lineage as 0023.** Chubby's lock-delay (Burrows, OSDI 2006) is the closest published design to "no automatic takeover, diagnose then remove": a lock from a dead holder is withheld for a period rather than reassigned. Gray & Cheriton's leases (SOSP 1989) are the alternative 0024 rejects. No 2020s paper on advisory-file-lock split-brain in local tools was found; git's `index.lock` is practice, not literature.

**Move.** Document the NFS/network-FS limitation and the PID-reuse reasoning; add a supervisor-mode recovery contract for 0027.

### ADR 0025 — Provider capability contract  [proposed]

**Steelman.** Closing the phantom-0022 reference and consolidating scattered behaviour is overdue; a per-provider conformance suite before support-matrix admission would be new in the field.

**Attack.** The record proposes a hand-maintained capability set when two public registries already exist and piko already downloads one of them. LiteLLM's price file carries 38 `supports_*` flags, tiered pricing, deprecation dates, and context limits per model; models.dev carries reasoning options, cost tiers, and the wire `shape` per provider. OpenHands' substring-pattern lists are the anti-pattern to avoid — and `tokens.ts`'s hand table is already that anti-pattern. "The adapter is authoritative for windows, never the model's self-report" is right; "the adapter is authoritative rather than the registry" would be a second hand table.

**Field.** Codex: Responses only. AI SDK: Responses default. OpenCode: models.dev. Claude Code: Messages plus Bedrock/Vertex/Foundry. The contract's first admitted capability should be the wire shape, because that is the one that is currently missing.

**Research.** **Thin literature.** ReliabilityBench (Gupta et al., Jan 2026) and AgentChaos (Tan et al., ASE 2026) show schema drift, rate limits, and partial responses are first-class production faults that a per-provider conformance suite would catch; Ranganathan et al. (Oct 2025) show timeouts dominate real inference incidents. No paper describes a provider capability registry; LiteLLM's and models.dev's data files are the de facto ones.

**Move.** Source capabilities from the registry row already on disk, override per profile, keep the conformance suite as the piko contribution, and admit Responses first.

### ADR 0026 — Session-scoped and aggregate budget authority  [proposed]

**Steelman.** This is the record that makes "every mode" true. Root authority with atomic reserve-and-reconcile, exposure charged to every ancestor, explicit `maxActiveTime` summed across parallel children, and a printed reserved / actual / effective line at every stop — no harness has all of it. Claude Code's tree budget is post-hoc; Codex's rollout ledger is token-denominated with reminders; a third-party DeepSeek plugin (`dsh-agent-budget`) does reservation-based tree scope, which shows the idea is in the air.

**Attack.** Cascading worst-case reservations compound with depth: a child's four-times-conservative bound is charged to every ancestor, so a tree three deep reserves far more than it will spend and the effective ceiling collapses further than the per-turn one already does. The record's "tokenizer count only where a corpus proves it conservative" is the right guard and it means the tightening is gated on corpus work nobody has scheduled.

A root lock on every child's dispatch path is a serialisation point; fine for six children, unmeasured for twenty. Codex's reminders (`reminder_interval_tokens`) — tell the model how much is left — are cheaper than a hard stop and absent here.

**Field.** LiteLLM reconciles reservations against actual cost the moment a response is priced, which keeps the pessimism short-lived; piko's per-turn ledger does the same, so the compounding is only as bad as the slowest child.

**Research.** **Aligned, uncited.** The budget papers under 0009 apply directly: BAGEN (Lin et al., 2026) shows agents do not self-limit, and Tran & Kiela (Apr 2026) show multi-agent advantages vanish under matched token budgets — which is only checkable if the budget is enforced across the tree, as 0026 proposes. MAST (Cemri et al., 2025) attributes multi-agent failure largely to system design rather than individual agents, which is an argument for the parent owning admission. No paper studies tree-scoped reservation; the DeepSeek community plugin is the only implementation.

**Move.** Ratify; add budget reminders to the model at intervals; measure the lock under twenty concurrent children before 0018's contained spawn depends on it.

### ADR 0027 — Cooperative graceful shutdown  [proposed]

**Steelman.** Stop admission, journal a drain marker, bounded grace, supervisor-owned hard kill, and 0007's outcome semantics for whatever the deadline forces: this is Temporal's `shutdownGraceTime` plus `shutdownForceTime` and Kubernetes' 30-second grace applied to a CLI, and it is more explicit than any harness documents.

**Attack.** Claude Code already documents the operator-facing half: SIGTERM kills the Bash process tree, runs `SessionEnd` hooks (with a 1.5-second budget), exits 143, records the running command as killed, and resumes the unfinished turn later; its hosted runner has `--defer-shutdown-max-min`. Piko's exit code for SIGTERM is not in the 0010 table at all (130 is SIGINT), and the record does not say which exit code a forced kill produces or how a supervisor distinguishes it.

"One supervisor process per headless run" is a new operational component in a project that sells zero dependencies; a fleet already has a supervisor (systemd, Kubernetes, the orchestrator), so the design should make piko a good citizen of theirs — honour the grace period, exit with a documented code — before it ships its own.

**Field.** Codex's SIGTERM behaviour is undocumented; OpenHands and DeepSeek do not address it. Piko would be second, after Claude Code, to document a shutdown contract at all.

**Research.** **Challenged by the canon it borrows from.** [Crash-Only Software](https://www.usenix.org/conference/hotos-ix/crash-only-software) (Candea & Fox, HotOS 2003) argues shutdown should *be* a crash and recovery a restart: a separate graceful path is extra code with its own failure modes. 0027's answer — cooperative drain journals a cleaner outcome, but the forced path keeps 0007's semantics — is consistent with crash-only if the forced path is tested as the primary one. [Microreboot](https://www.usenix.org/legacy/event/osdi04/tech/full_papers/candea/candea.pdf) (Candea et al., OSDI 2004): externally driven component restarts with state kept outside the component — consistent with an external supervisor owning the kill. No paper on drain semantics for agent harnesses exists.

**Move.** Implement the cooperative path in-process (stop admission, grace, journaled drain marker, exit 143) so any external supervisor works; ship piko's own supervisor only for the blocking-extension case, and add 143 to the 0010 table.

> The record is the best in the field and the runtime is fourth or fifth. Every attack above reduces to one sentence: ship the boundary, then let the governance stand on it.

---

**Method.** Piko facts are read from the tree at `cacdd8d` (docs/adr, evidence maps, maturity plan, T1 re-review, packages/*). Competitor facts come from four parallel research passes over vendor documentation, source repositories, changelogs, and registries fetched 2 Sep 2026; each pass marked unverifiable items, and those are either omitted here or labelled "reported." Secondary sources (third-party measurements of token overhead, community write-ups of Codex internals) are used only where labelled. I did not execute competitor software. Papers were located by three research passes and verified individually against arXiv abstract pages or publisher records (title, first author, venue, date); arXiv identifiers are given inline in each Research row. Items the passes could not verify were dropped; non-peer-reviewed items (technical reports, position papers, single-author SoKs) are identified as such where cited. Only ADR 0001 cites a paper in the record itself; every other Research row is corroboration or contradiction the record does not currently carry. Primary sources, by system:

- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing), [permissions](https://code.claude.com/docs/en/permissions), [hooks](https://code.claude.com/docs/en/hooks), [sessions](https://code.claude.com/docs/en/sessions), [headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [sub-agents](https://code.claude.com/docs/en/sub-agents), [prompt caching](https://code.claude.com/docs/en/prompt-caching), [context window](https://code.claude.com/docs/en/context-window), [SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [monitoring](https://code.claude.com/docs/en/monitoring-usage), [data usage](https://code.claude.com/docs/en/data-usage), [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Anthropic: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything); [context engineering for Claude 5](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models); [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use); [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp); [prompt caching API](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Microsoft: Claude Code GitHub Action case (2026-06-05)](https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-claude-code-github-action-case/)
- [Codex approvals and sandbox](https://developers.openai.com/codex/agent-approvals-security), [execpolicy rules](https://developers.openai.com/codex/rules), [config reference](https://developers.openai.com/codex/config-reference), [app-server](https://developers.openai.com/codex/app-server), [subagents](https://developers.openai.com/codex/subagents), [MCP](https://developers.openai.com/codex/mcp), [linux-sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md), [rollout budget PR](https://github.com/openai/codex/pull/28746), [double app-server issue](https://github.com/openai/codex/issues/33241), [Chat Completions removal](https://github.com/openai/codex/discussions/7782)
- [Gemini CLI loopDetectionService.ts](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/loopDetectionService.ts), [configuration](https://geminicli.com/docs/reference/configuration/), [headless](https://geminicli.com/docs/cli/headless/), [Antigravity transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector), [stuck_detector.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py), [event_store.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/event_store.py), [remote_conversation.py](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/remote_conversation.py), [security](https://docs.openhands.dev/sdk/guides/security)
- [DeepSeek harness](https://github.com/deepseek-ai/deepseek-harness) (docs/subsystems: sandbox, approval, filesystem, credentials, session)
- [pi containerization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md), [Gondolin](https://github.com/earendil-works/gondolin), [fusion-harness](https://github.com/disler/fusion-harness), [pi-anti-doom-loop](https://pi.dev/packages/pi-anti-doom-loop)
- [OpenCode permissions](https://opencode.ai/docs/permissions/), [doom-loop PR](https://github.com/anomalyco/opencode/pull/3445); [Cursor CLI permissions](https://cursor.com/docs/cli/reference/permissions); [goose env vars](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/environment-variables.md); [Aider options](https://aider.chat/docs/config/options.html); [mini-swe-agent default.py](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py)
- [LiteLLM budgets (reservation)](https://docs.litellm.ai/docs/proxy/users), [price file](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json); [models.dev](https://github.com/sst/models.dev); [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai); [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching); [Gemini caching](https://ai.google.dev/gemini-api/docs/caching)
- [ACP protocol](https://agentclientprotocol.com/protocol/overview); [Temporal worker shutdown](https://docs.temporal.io/encyclopedia/workers/worker-shutdown), [activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures); [Restate journaling](https://docs.restate.dev/develop/ts/journaling-results); [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts); [OpenAI Agents SDK HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [openat2(2)](https://man.archlinux.org/man/openat2.2.en); [cap-std](https://github.com/bytecodealliance/cap-std); [Landlock](https://docs.kernel.org/userspace-api/landlock.html); [CVE-2025-53109/53110](https://cymulate.com/blog/cve-2025-53109-53110-escaperoute-anthropic/); [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/architecture/)
- [Infinite Agentic Loops (2026)](https://arxiv.org/abs/2607.01641), [Cognitive Companion (2026)](https://arxiv.org/html/2604.13759), [How many tools should an agent see (2026)](https://arxiv.org/abs/2605.24660), [Darwin Gödel Machine](https://sakana.ai/dgm/), [GEPA](https://arxiv.org/abs/2507.19457); [Terminal-Bench integrity update](https://www.tbench.ai/news/leaderboard-integrity-update)
- Secondary, labelled where used: [token-overhead comparison (2026-06-01)](https://note.com/snake_dragon/n/ndacf0867110e); [Codex compaction write-up](https://codex.danielvaughan.com/2026/03/31/codex-cli-context-compaction-architecture/); [Claude Code budget-cap test (2026-04-18)](https://linuxjedi.co.uk/when-the-docs-fall-short-investigating-claude-codes-budget-cap/)
