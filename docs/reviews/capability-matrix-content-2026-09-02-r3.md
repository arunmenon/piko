# capability-matrix (artifact content, revision 3, 2026-09-02)

Extraction of the published artifact after the T1 per-turn scope correction. Supersedes capability-matrix-content-2026-09-01-r2.md. Content digest sha256:b5d8e0d40b54d92d. Layout flattened; wording verbatim.

---
Engineering Strategy · Competitive Capability Study · September 2026 

# Where piko stands: a capability matrix against the leading agentic harnesses 

Thirteen harnesses, eleven dimensions, 143 cells — verified by a 13-agent grounding workflow, then independently replicated by a second investigator whose blind pass agreed on 63% of cells and killed two of our exclusivity claims. Both correction rounds are in the page. 

1 · Method and evidence 

## How each cell earned its mark 

Three-stage method. Stage one: census from the Harbor benchmark framework's agent registry (41 harnesses) filtered to 13 candidates, with draft grades from session research. Stage two — the stage that mattered: a 13-agent grounding workflow, one adversarial verifier per row, instructed to confirm or refute every cell from primary sources only (vendor docs and repos fetched live; local pinned sources for rows we had read at source) under a no-guess rule: anything unestablishable returns "unverified." Stage three: an independent replication by a second investigator (blind re-investigation, then a cell diff), which agreed on 90 of 143 cells, killed two exclusivity claims, and drove the adjudicated regrade this page now shows. 

- The grounding changed 38 of 143 cells — in both directions. Competitors were upgraded 24 times (Claude Code's hard budget cap, mini-swe-agent's enforced cost limit, DeepSeek's fail-closed approvals); piko's own row lost two grades (isolation to absent, benchmark evidence to partial). Every verdict carries its source and fact in the committed grounding artifact. 

- Evidence grades per row: A = source-read/benchmarked by us (Terminus-2, Exo, fusion-harness, pi-mono, piko); B = primary-doc verified via the grounding pass (production tier, OpenHands, Aider, mini-swe-agent, DeepSeek — upgraded from C after its documentation site was read in full). 

- Full verdicts: docs/reviews/capability-matrix-grounding-2026-09-01.json (143 grounded cells with sources) and docs/reviews/2026-09-01-capability-matrix-replication.md (the replication report and our adjudication: which findings we accepted after re-verifying their sources ourselves, which we rejected and why). 

- The D2 rubric, made explicit after replication: strong = an enforced ceiling that cannot be exceeded (pre-dispatch reservation); partial = an enforced stop that can overshoot or is mode-restricted (OpenHands' per-task stop, mini-swe-agent's post-response cost limit, Claude Code's print-mode cap); absent = accounting without enforcement. Durability grading now distinguishes resumable history, durable append, in-process serialization, cross-process locking, and stale-lock recovery — only the last two earn strong. 

2 · The field 

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

3 · The matrix 

## Eleven dimensions, graded 

● strong / engineered ◐ partial / present with gaps ○ absent / out of scope ? unverified 

Harness (evidence) 
Context mgmt Cost enforce Tools & ext. Sub-agents Approvals Isolation Session durability Automation Provider breadth Bench evidence Maturity 

| Piko (A) ● ● ◐ ◐ ● ○ ● ● ◐ ◐ ○ |
| Claude Code (B) ● ◐ ● ● ● ◐ ◐ ● ◐ ○ ● |
| Codex CLI (B) ● ○ ● ● ● ● ◐ ● ◐ ◐ ● |
| Gemini CLI (B) ◐ ○ ● ◐ ● ◐ ◐ ◐ ○ ◐ ● |
| OpenCode (B) ● ○ ● ● ◐ ○ ◐ ● ● ○ ● |
| OpenHands (B) ◐ ◐ ● ◐ ◐ ● ● ● ● ● ● |
| Aider (B) ◐ ○ ◐ ○ ◐ ○ ◐ ◐ ● ● ◐ |
| pi-mono (A) ● ○ ◐ ◐ ◐ ◐ ◐ ● ● ◐ ● |
| Exo (A) ◐ ○ ◐ ◐ ○ ● ◐ ◐ ● ○ ○ |
| Terminus-2 (A) ● ○ ◐ ○ ○ ● ◐ ● ● ● ◐ |
| mini-swe-agent (B) ◐ ◐ ○ ○ ◐ ◐ ○ ◐ ● ● ◐ |
| DeepSeek harness (B) ◐ ○ ● ● ● ◐ ◐ ◐ ◐ ○ ◐ |
| fusion-harness (A) ◐ ○ ◐ ● ◐ ○ ◐ ◐ ● ○ ◐ |

4 · Reading the columns 

## After grounding: piko tops no column alone — its edge lives one level down 

The draft of this study gave piko four outright wins. The grounding pass took them away, honestly: at glyph resolution, every column piko leads is shared. What survives is mechanism depth — differences the glyphs are too coarse to show — and one uncomfortable discovery about a competitor. 

### Where the draft was wrong about the field 

- "Only harness with a hard dollar ceiling" is dead — twice over. Claude Code ships --max-budget-usd (print mode, v2.1.217+); mini-swe-agent enforces a cost_limit checked around each call; and the replication surfaced OpenHands' MAX_BUDGET_PER_TASK , a real per-task dollar stop (post-spend, can overshoot the final request — verified against its docs by us). Piko's distinction is mechanism, not existence: pre-dispatch reservation of each request's worst-case cost, enforced per user turn (the whole run in headless mode; session-scoped under proposed ADR 0026), so the turn ceiling cannot be exceeded rather than merely reacted to. 

- DeepSeek harness is a governance competitor, not a price story. Its documentation (read in full by the grounding agent, upgrading the row from unverified) describes fail-closed approvals, an append-only typed session-event log as source of truth, durable child sessions, MCP client, and OS-level sandbox backends (bwrap/Landlock, Seatbelt, Windows ACL). That is piko's own specialty, executed by a well-resourced lab — the single most strategically important finding of this study. 

- Terminus-2 was underrated across six cells (proactive summarization, cost accounting, MCP injection, Docker isolation, job resume, a Python SDK) — the "minimal baseline" framing was a year stale. 

- Aider's benchmark evidence outranks ours (public polyglot leaderboard with per-run costs) while its maturity was overrated (release cadence stalled since Aug 2025). pi-mono, transferred to earendil-works/pi at ~100k stars with a documented micro-VM isolation path, is a production platform, not a lean experiment. 

- Exo shrank under its own source : no MCP client despite config types for one, fork-only orchestration, zero approval flow — four cells down from our podcast-era impressions, consistent with our pinned study. 

### Where the draft was wrong about piko 

- Isolation: absent, not partial. Our own row verifier applied the study's rubric to us: a reproduced escape (ADR 0022, accepted, unimplemented), no OS sandbox, README barring untrusted workloads. Path checks that a race defeats do not earn "partial" under a rubric that gives Terminus a "strong" for real containers. 

- Benchmark evidence: partial, not strong. The transparency practice (per-trial ledgers, corrections, firewalls) is real and unusual — but the score itself is a cost-bounded floor at n=1, and the rubric grades the evidence, not the virtue. 

- Sub-agents: partial, not absent (replication). Under the rubric's own mode-restriction rule, piko's primitive headless self-spawn via explicitly enabled host execution (ADR 0004) earns partial — while being nothing like native contained delegation with unified accounting, which is not shipped. 

- The residual exclusivity framing fell to replication. OpenHands documents a per-task dollar stop (MAX_BUDGET_PER_TASK) and process-safe locked event-log appends — both re-verified by us against its documentation before accepting. "Mechanisms the field genuinely lacks" was retired for the narrower, defensible composition claim in the verdict. 

### What actually survives as piko's edge 

- Cost enforcement with reservations — among all implementations inspected by both investigations, the only one that blocks the request before spend, with journaled exposure. Scope caveat, corrected 2026-09-02: the ceiling is enforced per user turn (the whole run in headless mode); a session-scoped aggregate is ADR 0026, proposed. Peers that enforce (OpenHands, mini-swe-agent, Claude Code) cap after the fact or in one mode. 

- Session integrity, stated narrowly — the replication found OpenHands documents process-safe locked event-log appends (flock, with a stated NFS caveat), so "the field lacks locking" is retired. Piko's narrower, still-unique composition: lock-capability mutation (compile-time and runtime), hard-link defense, and explicit stale-lock diagnosis with single-target recovery. Claude Code's docs still state double-resume interleaves one transcript; Codex and DeepSeek establish durability but not cross-process locking. 

- The CI-ratcheted footprint and the evidence-governance loop (dev-set firewalls, dated retractions, this grounding pass itself) — practices no other candidate documents. 

So what After two correction rounds the position is: piko tops no column, holds no exclusive mechanism, and differentiates on composition — reservation-based spend enforcement plus lock-capability sessions plus stale-lock recovery plus evidence ratchets in one runtime, each individually matched somewhere in the field, nowhere combined. The isolation cell (absent, where even research baselines score strong) gates everything; DeepSeek and OpenHands are the governance competitors to beat head-to-head. 0022/0018 are existential. 

5 · Candidate notes 

## One honest paragraph each 

| Harness | What it actually is, and what we'd steal |
| Claude Code | The capability bar: rich context, mature subagents, hooks/skills/MCP, OS sandboxing (Seatbelt/bubblewrap with egress proxying), and — corrected by grounding — a hard per-run budget cap in print mode. Documented durability gap: double-resume interleaves one transcript (no locking). Steal: subagent-offload, and the deferred-MCP-schema pattern. |
| Codex CLI | The engineering-rigor peer: tested exec policies, sandbox modes, native session rollouts, an approval-aware app-server protocol. Closest to piko in contract-mindedness, far ahead in isolation. Steal: the execpolicy idea — policy as tested code. |
| Gemini CLI | Massive-context strategy (the model's window does the work), Apache-licensed, huge adoption; capability posture broad but less contract-governed. Provider-locked in practice. |
| OpenCode | The community's multi-model TUI: 75+ providers, LSP integration, server/SDK mode, plugins. Provider breadth and DX are the draw; no OS sandbox, cost is metering. Steal: LSP-informed editing. |
| OpenHands | The platform wing: Docker/K8s sandboxes, REST/SDK, strong published SWE-bench lineage, and the field's closest thing to a peer budget control (per-task cost cap, post-hoc). Heavier than a CLI; a different species, and the most instructive one for piko's 0018. |
| Aider | The veteran: git-native auditability, repo-map context, provider breadth via litellm — and benchmark evidence upgraded to strong (public polyglot leaderboard, per-run costs published). Maturity downgraded: release cadence stalled since Aug 2025. Still the standard for git discipline; no longer the standard-bearer for momentum. |
| pi-mono | Piko's design ancestor, regraded up: transferred to earendil-works/pi at ~100k stars, npm-published, with documented isolation paths (Gondolin micro-VM, Docker) that move its sandbox cell to partial. The lean thesis at production scale — proof the architecture piko forked can carry a platform, and a preview of piko's own ceiling. |
| Exo | Still the most ambitious architecture we read (Firecracker-tier sandboxing, real ops engineering) — but grounding shrank four cells against fresh source: no MCP client despite config types for one, fork-only orchestration versus roadmap claims, zero approval flow, cost accounting without any limit. Its pricing-loader pattern remains stolen into ADR 0020; its gaps remain a cautionary tale about architecture outrunning enforcement. |
| Terminus-2 | Upgraded six cells by grounding: proactive summarization with a subagent Q&A handoff, per-step cost accounting, MCP server injection, containerized execution, job-level resume, and a Python SDK. The 'minimal baseline' framing was stale; it is a serious harness that also anchors the public leaderboard. |
| mini-swe-agent | Radical minimalism with real SWE-bench pedigree — and, corrected by grounding, an enforced cost_limit (default $3.00) checked before every model call plus confirm-by-default approvals. The ~100-line agent quietly ships two of the controls we thought were piko's alone. |
| DeepSeek harness | The study's biggest revision: nine cells regraded after its documentation was read in full. Fail-closed approvals, append-only typed session log, durable child sessions, MCP client, OS-level sandbox backends on three platforms. Not a price story — a governance competitor in piko's own specialty. Publishes no benchmark evidence. The ~$2 benchmark arm through our adapter is now the most interesting experiment on the list. |
| fusion-harness | The multi-model wing, source-reviewed: read-only N-model fan-out, single-writer lease, DAG collaboration, ACK-verified merges — genuinely novel orchestration on pi. Meters cost per agent, caps rounds and timeouts, ships no dollar ceiling. Steal: read-only fan-out + sole-writer as an execution pattern, and escalation-tier fusion as an experiment our TB 2.0 data is begging for. |

The standing, in one statement 

Two verification rounds each made this page more honest: the grounding pass took away piko's four column wins; the independent replication (62.9% cell agreement) then killed the residual "mechanisms the field lacks" framing — OpenHands enforces a per-task dollar stop and locks its event log. What survives both rounds, in the replication's own words, is composition: no other harness inspected combines pre-dispatch spend reservation, durable lifecycle accounting, lock-capability sessions with stale-lock recovery, and evidence-budget ratchets in one runtime. The strategy stands sharpened: isolation (0022/0018) is existential; DeepSeek and OpenHands are the governance competitors to measure against head-to-head; and the process that produced this page — verify, replicate, adjudicate, correct in public — is the part no competitor currently ships at all. 

Provenance. Census: the Harbor framework's agent registry (41 harnesses). Grades: a 13-agent grounding workflow (run wf_eb2809e6-9a2; 143 per-cell verdicts with sources in docs/reviews/capability-matrix-grounding-2026-09-01.json), followed by an independent replication (blind re-investigation, 90/143 agreement, report and adjudication in docs/reviews/2026-09-01-capability-matrix-replication.md). Grades shown are post-adjudication: replication findings were accepted only after we re-verified their cited sources ourselves (OpenHands budget and EventLog docs checked directly), and rejected findings are recorded with reasons. Disputed strong-vs-partial cells reflecting rubric strictness variance are disclosed rather than hidden. Sources reflect primary documentation as fetched 2026-09-01. The rubric is stated in section 1; the committed artifacts let any reader re-derive every cell.
