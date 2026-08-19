# 0013 — Three separate event surfaces; telemetry redacts by default

Status: accepted (2026-08-19, backfilled same day)

## Context

One event bus serving crash recovery, interactive UI, and observability is a
classic false economy: the three consumers need different stability promises,
different retention, and different privacy postures. A durable row that a UI
also renders cannot change without breaking one of them.

## Decision

Three deliberately distinct contracts:

1. The session journal (0007): durable facts required for crash recovery and
   replay. Strictest correctness bar; consumers are the harness itself.
2. `AgentEvent`: the live in-process stream driving the REPL and the versioned
   `--json` output (0010). Additive evolution under 0010's rules.
3. Telemetry: a versioned envelope (`TELEMETRY_SCHEMA_VERSION = 1`) of spans
   and events for observability sinks (durable JSONL today, OTel adapter
   planned), with credential-shape redaction on by default — private data
   must be opted in, never scrubbed after the fact.

An event may appear on several surfaces, but each surface owns its schema; no
surface derives its contract from another's rows.

## Consequences

- Each surface can evolve at its own pace: journal changes are migration
  events, AgentEvent changes are compat-checked, telemetry is fire-and-forget.
- Redaction-by-default makes telemetry safe to enable in shared environments
  and citable in a privacy review.
- Costs: some triple bookkeeping in the loop, and contributors must pick the
  right surface for new signals (the decision table lives in this ADR: durable
  fact -> journal; user-visible progress -> AgentEvent; measurement -> telemetry).
