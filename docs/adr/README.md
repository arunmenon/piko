# Architecture decision records

One file per decision, numbered, never edited after acceptance (supersede instead).
Format: Context (the forces), Decision (what we chose), Consequences (what it costs
and enables). Backfilled 2026-08-19 for decisions made during initial development;
new decisions get an ADR in the same change that implements them.

| # | Decision | Status |
|---|---|---|
| 0001 | Fixed-context budget, CI-enforced | accepted |
| 0002 | Files and CLIs over MCP; five built-in tools | accepted |
| 0003 | Observable compaction into new session files | accepted |
| 0004 | Headless self-spawn as the sub-agent mechanism | accepted |
| 0005 | Loop-side failure control (flail guard) over prompt-side | accepted |
| 0006 | Workspace containment and deny-by-default host bash | accepted |
| 0007 | Write-ahead lifecycle journal with unknown-outcome semantics | accepted |
| 0008 | Strict provider contract with typed terminal states | accepted |
| 0009 | Hard run budgets enforced in the loop | accepted |
| 0010 | Fail-closed headless and JSON automation contract | accepted |
| 0011 | Persistent approve/edit/reject workflow | accepted |
| 0012 | Tool extensions are trusted controller code (amends 0002) | accepted |
| 0013 | Three separate event surfaces; telemetry redacts by default | accepted |
| 0014 | Prompt-cache discipline | accepted |
| 0015 | Durable single-writer session store | accepted |
| 0016 | Credential handling | accepted |
| 0017 | Evidence-gated self-improvement (`pi improve`) | **proposed** |
| 0018 | Container sandbox executor behind a provider seam | accepted |
| 0019 | Release and compatibility contract | **proposed** |
| 0020 | Dollar-denominated cost accounting and spend ceilings (amends 0009) | accepted |
| 0021 | Artifact data lifecycle | accepted |
| 0022 | Descriptor-anchored workspace containment (amends 0006) | accepted |
| 0023 | Lock-capability session API (amends 0015) | accepted |
| 0024 | Explicit stale-lock recovery (amends 0015) | accepted |
| 0025 | Provider capability contract (depends on 0008) | accepted |
| 0026 | Session-scoped and aggregate budget authority (amends 0009, 0020) | accepted |
| 0027 | Cooperative graceful shutdown | accepted |

Headers may carry `Amends` / `Amended-by` / `Depends on` lines; the records
they link are never edited beyond those pointers and dated addenda.

Status transitions are separated from implementation: the session or agent
that implements an ADR never flips its status. `proposed -> accepted` is an
act of the owner (or a reviewing session the owner has delegated), recorded
in the status line — an implementer accepting its own governing decision is
the rubber-stamp pattern 0017 warns against.

Research addenda are dated corroboration or contradiction added after the fact:
each record's `## Research (2026-09-02)` section cites work from the red-team
review of the same date (docs/reviews/2026-09-02-red-team-review.md), marked
`corroborates` or `challenges`, and none of it changes a decision.

## Bibliography

Every work cited by a Research addendum, once, alphabetically by first author.

- Agache et al. "Firecracker: Lightweight Virtualization for Serverless
  Applications". NSDI 2020.
  https://www.usenix.org/conference/nsdi20/presentation/agache
- Aghili, Li & Khomh. "Protecting Privacy in Software Logs". arXiv 2409.11313
  (2024). https://arxiv.org/abs/2409.11313
- Anand & Chattaraj. "Instruction Stacking Collapse". arXiv 2608.02639 (2026).
  https://arxiv.org/abs/2608.02639
- Borisov et al. "Fixing Races for Fun and Profit: How to Abuse atime". USENIX
  Security 2005.
  https://www.usenix.org/conference/14th-usenix-security-symposium/fixing-races-fun-and-profit-how-abuse-atime
- Burrows. "The Chubby lock service for loosely-coupled distributed systems".
  OSDI 2006.
  https://www.usenix.org/conference/osdi-06/chubby-lock-service-loosely-coupled-distributed-systems
- Cai, Gui & Johnson. "Exploiting Unix File-System Races via Algorithmic
  Complexity Attacks". IEEE S&P 2009.
  https://ieeexplore.ieee.org/document/5207635/
- Candea & Fox. "Crash-Only Software". HotOS 2003.
  https://www.usenix.org/conference/hotos-ix/crash-only-software
- Candea et al. "Microreboot: A Technique for Cheap Recovery". OSDI 2004.
  https://www.usenix.org/legacy/event/osdi04/tech/full_papers/candea/candea.pdf
- Cemri et al. "Why Do Multi-Agent LLM Systems Fail?" (MAST). arXiv 2503.13657
  (2025). https://arxiv.org/abs/2503.13657
- Chen. "Governance Decay". arXiv 2606.22528 (2026).
  https://arxiv.org/abs/2606.22528
- Chen & Lin. "One Goal, Many Commands". arXiv 2606.15549 (2026).
  https://arxiv.org/abs/2606.15549
- Chen et al. "Credential Leakage in LLM Agent Skills". arXiv 2604.03070 (2026).
  https://arxiv.org/abs/2604.03070
- Dean & Hu. "Fixing Races for Fun and Profit: How to use access(2)". USENIX
  Security 2004.
  https://www.usenix.org/conference/13th-usenix-security-symposium/fixing-races-fun-and-profit-how-use-access2
- Debenedetti et al. "CaMeL: Defeating Prompt Injections by Design".
  arXiv 2503.18813 (2025). https://arxiv.org/abs/2503.18813
- Denison et al. "Sycophancy to Subterfuge". arXiv 2406.10162 (2024).
  https://arxiv.org/abs/2406.10162
- Dong et al. "AgentOps". arXiv 2411.05285 (2024).
  https://arxiv.org/abs/2411.05285
- Eliav. "Prompt Design at Scale". arXiv 2607.19257 (2026).
  https://arxiv.org/abs/2607.19257
- Fei et al. "CodeDelegator". arXiv 2601.14914 (2026).
  https://arxiv.org/abs/2601.14914
- Fei et al. "MCP-Zero". arXiv 2506.01056 (2025).
  https://arxiv.org/abs/2506.01056
- Gao & Peng. "More with Less". arXiv 2510.16786 (2025).
  https://arxiv.org/abs/2510.16786
- Gim et al. "Prompt Cache". MLSys 2024, arXiv 2311.04934.
  https://arxiv.org/abs/2311.04934
- Gray & Cheriton. "Leases: An Efficient Fault-Tolerant Mechanism for
  Distributed File Cache Consistency". SOSP 1989.
  https://doi.org/10.1145/74850.74870
- Gupta et al. "ReliabilityBench". arXiv 2601.06112 (2026).
  https://arxiv.org/abs/2601.06112
- Helland. "Idempotence Is Not a Medical Condition". ACM Queue 2012.
  https://doi.org/10.1145/2181796.2187821
- Hochlehnert et al. "A Sober Look at Progress". COLM 2025, arXiv 2504.07086.
  https://arxiv.org/abs/2504.07086
- Hou et al. "When Agents Do Not Stop". arXiv 2607.01641 (2026).
  https://arxiv.org/abs/2607.01641
- Iqbal, Kohno & Roesner. "LLM Platform Security". AIES 2024.
  https://doi.org/10.1609/aies.v7i1.31664
- Ji et al. "Measuring the Permission Gate". arXiv 2604.04978 (2026).
  https://arxiv.org/abs/2604.04978
- Jiang et al. "Beyond Pass@k". arXiv 2608.14711 (2026).
  https://arxiv.org/abs/2608.14711
- Kang et al. "ACON". ICML 2026, arXiv 2510.00615.
  https://arxiv.org/abs/2510.00615
- Kapoor et al. "AI Agents That Matter". TMLR 2025, arXiv 2407.01502.
  https://arxiv.org/abs/2407.01502
- Kapoor et al. "Holistic Agent Leaderboard". ICLR 2026, arXiv 2510.11977.
  https://arxiv.org/abs/2510.11977
- Khan & Khan. "The Cognitive Companion". arXiv 2604.13759 (2026).
  https://arxiv.org/abs/2604.13759
- Khanal et al. "Beyond pass@1". arXiv 2603.29231 (2026).
  https://arxiv.org/abs/2603.29231
- Kim et al. "Capable language models can outgrow the benefits of
  collaboration". Nature Machine Intelligence (2026).
  https://www.nature.com/articles/s42256-026-01268-y
- Ladisa et al. "SoK: Taxonomy of Attacks on Open-Source Software Supply
  Chains". IEEE S&P 2023, arXiv 2204.04008. https://arxiv.org/abs/2204.04008
- Lahjouji & Colaco. "Agents That Know Too Much". arXiv 2606.26627 (2026).
  https://arxiv.org/abs/2606.26627
- Lampson. "Hints for Computer System Design". SOSP 1983.
  https://doi.org/10.1145/800217.806614
- Lilienthal & Hong. "Mind the Gap" (TOCTOU-Bench). arXiv 2508.17155 (2025).
  https://arxiv.org/abs/2508.17155
- Lin et al. "BAGEN: Are LLM Agents Budget-Aware?". arXiv 2606.00198 (2026).
  https://arxiv.org/abs/2606.00198
- Lindenbauer et al. "The Complexity Trap". DL4C at NeurIPS 2025,
  arXiv 2508.21433. https://arxiv.org/abs/2508.21433
- Liu et al. "Budget-Aware Tool-Use". arXiv 2511.17006 (2025).
  https://arxiv.org/abs/2511.17006
- Liu et al. "Lost in the Middle". TACL 2024. Link not recorded in the review.
- Liu et al. "ToolScope". arXiv 2510.20036 (2025).
  https://arxiv.org/abs/2510.20036
- Liu et al. "Your AI, My Shell". arXiv 2509.22040 (2025).
  https://arxiv.org/abs/2509.22040
- Lumer et al. "Don't Break the Cache". arXiv 2601.06007 (2026).
  https://arxiv.org/abs/2601.06007
- Majgaonkar et al. "Understanding Code Agent Behaviour". arXiv 2511.00197
  (2025). https://arxiv.org/abs/2511.00197
- Maloyan & Namiot. "SoK: Prompt Injection Attacks on Agentic Coding
  Assistants". arXiv 2601.17548 (2026). https://arxiv.org/abs/2601.17548
- Marchand et al. "Quantifying Frontier LLM Capabilities for Container Sandbox
  Escape". UK AISI, arXiv 2603.02277 (2026). https://arxiv.org/abs/2603.02277
- Mellafe Zuvic et al. "Capability Gates Are Not Authorization".
  arXiv 2606.28679 (2026). https://arxiv.org/abs/2606.28679
- Merrill et al. "Terminal-Bench". arXiv 2601.11868 (2026).
  https://arxiv.org/abs/2601.11868
- Miller. "Adding Error Bars to Evals". arXiv 2411.00640 (2024).
  https://arxiv.org/abs/2411.00640
- Miller, Yee & Shapiro. "Capability Myths Demolished" (2003).
  http://www.erights.org/talks/myths/
- Min et al. "Toward Reliable Context Compression". arXiv 2608.06503 (2026).
  https://arxiv.org/abs/2608.06503
- Mohammadi et al. "Atomix". arXiv 2602.14849 (2026).
  https://arxiv.org/abs/2602.14849
- Mohan et al. "ARIES". ACM TODS 1992. https://doi.org/10.1145/128765.128770
- Ndzomga et al. "Efficient Benchmarking of AI Agents". arXiv 2603.23749 (2026).
  https://arxiv.org/abs/2603.23749
- Pillai et al. "All File Systems Are Not Created Equal". OSDI 2014.
  https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai
- Pillai, Chidambaram & Arpaci-Dusseau. "Crash Consistency". ACM Queue 2015.
  https://doi.org/10.1145/2800695.2801719
- Prabhakaran et al. "Model-Based Failure Analysis of Journaling File Systems".
  DSN 2005. https://ieeexplore.ieee.org/document/1467854/
- Ranganathan et al. "Enhancing reliability in AI inference services".
  arXiv 2511.07424 (2025). https://arxiv.org/abs/2511.07424
- Rashidi. "The Balkanization of Execution-Security Research for AI Coding
  Agents". arXiv 2607.05743 (2026). https://arxiv.org/abs/2607.05743
- Rebello et al. "Can Applications Recover from fsync Failures?". ATC 2020.
  https://www.usenix.org/conference/atc20/presentation/rebello
- Repantis et al. "How Many Tools Should an LLM Agent See?". arXiv 2605.24660
  (2026). https://arxiv.org/abs/2605.24660
- Sadani & Kumar. "Tool Attention Is All You Need". arXiv 2604.21816 (2026).
  https://arxiv.org/abs/2604.21816
- Schmotz et al. "Skill-Inject". arXiv 2602.20156 (2026).
  https://arxiv.org/abs/2602.20156
- Shi et al. "Progent". arXiv 2504.11703 (2025).
  https://arxiv.org/abs/2504.11703
- Sigelman et al. "Dapper, a Large-Scale Distributed Systems Tracing
  Infrastructure" (2010).
  https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/
- Singh et al. "The Leaderboard Illusion". NeurIPS 2025, arXiv 2504.20879.
  https://arxiv.org/abs/2504.20879
- Song et al. "Help or Hurdle?". arXiv 2508.12566 (2025).
  https://arxiv.org/abs/2508.12566
- Tamanna et al. "Analyzing Challenges in Deployment of SLSA". arXiv 2409.05014
  (2024). https://arxiv.org/abs/2409.05014
- Tan et al. "AgentChaos". ASE 2026, arXiv 2608.06790.
  https://arxiv.org/abs/2608.06790
- Thaman. "Reward Hacking Benchmark". ICML 2026, arXiv 2605.02964.
  https://arxiv.org/abs/2605.02964
- Tran & Kiela. "Single-Agent LLMs Outperform Multi-Agent Systems".
  arXiv 2604.02460 (2026). https://arxiv.org/abs/2604.02460
- Tsafrir et al. "Portably Solving File TOCTTOU Races with Hardness
  Amplification". FAST 2008.
  https://www.usenix.org/conference/fast-08/portably-solving-file-tocttou-races-hardness-amplification
- Venturini et al. "I depended on you and you broke me". TOSEM 2023,
  arXiv 2301.04563. https://arxiv.org/abs/2301.04563
- Wang & Zheng. "Sandlock". arXiv 2605.26298 (2026).
  https://arxiv.org/abs/2605.26298
- Wang et al. "Efficient Agents". arXiv 2508.02694 (2025).
  https://arxiv.org/abs/2508.02694
- Wang et al. "Huxley-Gödel Machine". arXiv 2510.21614 (2025).
  https://arxiv.org/abs/2510.21614
- Wang et al. "SWE-Pruner". arXiv 2601.16746 (2026).
  https://arxiv.org/abs/2601.16746
- Wang, Li & Tian. "Reframing LLM Agent Security as an Agent-Human Interaction
  Problem". arXiv 2605.24309 (2026). https://arxiv.org/abs/2605.24309
- Wang, Poskitt & Sun. "AgentSpec". ICSE 2026, arXiv 2503.18666.
  https://arxiv.org/abs/2503.18666
- Wu et al. "IsolateGPT". NDSS 2025, arXiv 2403.04960.
  https://arxiv.org/abs/2403.04960
- Young et al. "The True Cost of Containing". HotCloud 2019.
  https://www.usenix.org/conference/hotcloud19/presentation/young
- Zhang et al. "Darwin Gödel Machine". arXiv 2505.22954 (2025).
  https://arxiv.org/abs/2505.22954
- Zhang et al. "Learning Agent Execution for KV-Cache Management".
  arXiv 2608.14624 (2026). https://arxiv.org/abs/2608.14624
- Zhang et al. "Stop Comparing LLM Agents Without Disclosing the Harness".
  arXiv 2605.23950 (2026). https://arxiv.org/abs/2605.23950
- Zheng et al. "SGLang RadixAttention". NeurIPS 2024, arXiv 2312.07104.
  https://arxiv.org/abs/2312.07104

First author not recorded in the review, listed by title:

- "Prime Agent". arXiv 2608.23552 (2026). https://arxiv.org/abs/2608.23552
- "Self-Harness". arXiv 2606.09498 (2026). https://arxiv.org/abs/2606.09498
