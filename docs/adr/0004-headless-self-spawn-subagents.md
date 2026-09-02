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

## Addendum (2026-08-19)

0006 later made host bash deny-by-default, which interacts with this decision:
in the default contained configuration piko has no delegation path at all, and
enabling sub-agents means granting `--allow-host-bash`. This coupling is
accepted for now — spawning is process execution and honestly carries its trust
level — but it makes a future "contained spawn" primitive (children launched
inside the sandboxed executor, without general host bash) the natural follow-on
decision when the container/microVM executor (roadmap v0.3) lands.

## Addendum (2026-09-02, parent run and depth cap)

The consequences above listed "structured child-run identities" as a v0.3+
concern. The red-team review (R2-4) showed the cost of leaving the tree
entirely unbounded, so two of the cheapest bounds ship now.

- `--parent-run <id>` sets the `parentRunId` that the embedder option and the
  telemetry envelope already carried but the CLI never populated. The id is
  accepted under exactly telemetry's rule (any non-empty string), reaches every
  runtime span and event, and is echoed on every `--json` row and on the
  `--usage` summary. A parent can therefore stitch a child's stream and its
  telemetry back to the run that spawned it without a trace backend.
- `PI_DEPTH` carries nesting depth. A run reads it at startup (absent means 0,
  a malformed value is refused rather than guessed) and every bash tool call
  exports depth plus one to its child shell, set explicitly on each call so an
  inherited value can never let two generations claim the same number.
  `--max-depth <n>` (default 2) refuses a run started deeper than the cap with
  exit 1 and a single stderr line, before any provider setup or model call. The
  read-only surfaces (`--help`, `--audit`, `doctor sessions`) stay usable at any
  depth; only a run is refused.

What this is and is not. The cap bounds accidental recursion, not an adversary:
a model holding host bash is already trusted with process execution and can
export its own `PI_DEPTH` inside a single tool call. Depth is also the only
tree-wide bound today. Concurrency (how many children may run at once) and
aggregate spend across a run tree are 0026's subject and are not decided here.
Cross-child cancellation and cache inheritance remain open as before.
