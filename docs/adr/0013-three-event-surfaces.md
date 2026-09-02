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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Dapper", Sigelman et al., Google technical report, 2010.
  Tracing kept separate from application logging, with restricted access to
  sensitive payloads; the three-surface split, thirteen years earlier.
- corroborates: "Protecting Privacy in Software Logs", Aghili, Li & Khomh,
  arXiv 2409.11313, 2024. Across 25 log datasets and 45 practitioners there is
  no consistent definition of sensitive content, which is the case for redacting
  by default rather than by review.
- corroborates: "Agents That Know Too Much", Lahjouji & Colaco,
  arXiv 2606.26627, 2026. Leaks travel through intermediate results, memory and
  inter-agent messages, so traces are themselves a leakage surface.
- corroborates: "Credential Leakage in LLM Agent Skills", Chen et al.,
  arXiv 2604.03070, 2026. 73.5% of credential leaks in agent skills originate in
  debug logging, the strongest argument for redacting telemetry at write time.
- corroborates: "AgentOps", Dong et al., arXiv 2411.05285, 2024. The taxonomy of
  what an agent system should trace, against which the three surfaces divide.
