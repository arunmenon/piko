# 0004 — Headless self-spawn as the sub-agent mechanism

Status: accepted (2026-08-12, backfilled 2026-08-19)

## Context

Benchmark evidence says sub-agents help specifically as context firewalls (isolated
noisy work returning only conclusions), while built-in orchestration is a major
source of runaway token spend (agent teams at 4-7x single-agent burn; one reported
171-spawn incident). Built-in sub-agent machinery also grows the fixed context and
the audit surface.

## Decision

No sub-agent machinery in core. The sub-agent primitive is the harness itself run
headless: `pi -p "<task>"` spawned via bash, with stdout carrying only the final
reply, progress on stderr, distinct exit codes, and per-child budget flags
(--max-turns, --max-tool-calls, --max-time, token budgets). Parallelism is the
shell's job; personas are prompt templates.

## Consequences

- The context-firewall benefit with zero resident cost; every child is itself a
  fully auditable session.
- Composes with methodology layers (praxis personas) and meta-harnesses that treat
  harnesses as swappable backends.
- Costs: no automatic result aggregation, no cross-child cancellation tree, no
  cache inheritance between parent and child (children re-pay the prefix). These
  are v0.3+ concerns (structured child-run identities) if real use demands them.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Why Do Multi-Agent LLM Systems Fail?" (MAST), Cemri et al.,
  arXiv 2503.13657, 2025. Across more than 1,600 traces, failures cluster in
  system design and inter-agent misalignment, with step repetition alone at
  15.7%.
- corroborates: "Capable language models can outgrow the benefits of
  collaboration", Kim et al., Nature Machine Intelligence, 2026. Across 260
  configurations, once a single agent exceeds about 45% baseline, adding agents
  rarely helps; SWE-bench Verified saw losses of 1% to 13% from multi-agent
  variants.
- corroborates: "Single-Agent LLMs Outperform Multi-Agent Systems", Tran &
  Kiela, arXiv 2604.02460, 2026. Under matched token budgets, the reported
  advantages of multi-agent systems vanish.
- corroborates: "CodeDelegator", Fei et al., arXiv 2601.14914, 2026. Fresh
  ephemeral coder instances isolated from a persistent delegator lift MCPMark
  success from 26.4% to 38.4%, direct evidence for the context-firewall pattern
  this record chose.

## Addendum (2026-08-19)

0006 later made host bash deny-by-default, which interacts with this decision:
in the default contained configuration piko has no delegation path at all, and
enabling sub-agents means granting `--allow-host-bash`. This coupling is
accepted for now — spawning is process execution and honestly carries its trust
level — but it makes a future "contained spawn" primitive (children launched
inside the sandboxed executor, without general host bash) the natural follow-on
decision when the container/microVM executor (roadmap v0.3) lands.
