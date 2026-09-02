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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Help or Hurdle?", Song et al., arXiv 2508.12566, 2025. Across
  about 20k calls over 6 models and 30 MCP suites, automated MCP access reduces
  accuracy 9.5% on average and 17% on code generation while inflating input
  tokens 3.25 to 236 times.
- corroborates: "MCP-Zero", Fei et al., arXiv 2506.01056, 2025. Pre-loading
  2,797 tools costs about 248k tokens; on-demand discovery cuts 98% of that with
  no accuracy loss, which is the bounded proxy this record describes.
- corroborates: "ToolScope", Liu et al., arXiv 2510.20036, 2025. Redundant tool
  descriptions degrade tool selection by 8 to 39 points.
- challenges: "How Many Tools Should an LLM Agent See?", Repantis et al.,
  arXiv 2605.24660, 2026. Adaptive shortlists of about 7 tools match 50-tool
  coverage, but a fixed 5-tool list scores 0% on ToolBench queries whose correct
  tool ranks 6 to 20. The evidence supports few tools per request, not a
  permanently fixed five.

## Addendum (2026-09-02, what the contained default can reach)

The consequences above understate the reach of the default configuration. In
the contained default the tools can reach files inside the workspace only: no
network, and no shell. There is no MCP client, so there are no integrations at
all in the mode the records defend. "Any CLI is reachable through bash" holds
only with `--allow-host-bash`.

The bounded MCP proxy this record describes (about 200 tokens, schemas fetched
on demand) remains unbuilt. Per the 2026-09 remediation plan (R0-5) it is a
stated non-goal through tranche 3, revisited only against evidence of a real
user need. The restrictive half of this decision shipped; the permissive half
did not, and the record should be read that way.
