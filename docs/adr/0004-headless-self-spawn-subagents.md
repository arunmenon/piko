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
