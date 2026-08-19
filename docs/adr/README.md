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
| 0011 | Persistent approve/edit/reject workflow | **proposed** |
