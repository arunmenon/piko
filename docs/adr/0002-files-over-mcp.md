# 0002 — Files and CLIs over MCP; five built-in tools

Status: accepted (2026-08-12, extended 2026-08-18 with map; backfilled 2026-08-19)
Amended-by: 0012 (explicitly listed extensions are the sanctioned exception to "never resident schemas")

## Context

MCP tool definitions cost 100-500 tokens each and live in every request; measured
single-server costs run 13.7k-55k tokens, and tool overprovision measurably degrades
model performance ("the dumb zone"). Meanwhile models understand read/write/edit/bash
deeply from training data, and any CLI is reachable through bash with zero schema cost.

## Decision

Ship exactly five built-in tools: map, read, write, edit, bash. Integrations are
files the model reads on demand (skills, READMEs) or CLIs it runs, never resident
schemas. No MCP client in core. If MCP is ever needed, use a single bounded proxy
tool (~200 tokens) that fetches schemas on demand, per the pi-mcp-adapter pattern.

## Consequences

- Fixed context stays inspectable and small; capability comes from the shell.
- The praxis integration validated the corollary: methodology layers install as
  markdown into `.agent/`, requiring no adapter code at all.
- Costs: no ecosystem of turnkey integrations; each external service needs a CLI
  or a documented skill. Accepted as the lean trade.
