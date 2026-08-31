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
| 0018 | Container sandbox executor behind a provider seam | **proposed** |
| 0019 | Release and compatibility contract | **proposed** |
| 0020 | Dollar-denominated cost accounting and spend ceilings (amends 0009) | accepted |
| 0021 | Artifact data lifecycle | **proposed** |
| 0022 | Descriptor-anchored workspace containment (amends 0006) | accepted |
| 0023 | Lock-capability session API (amends 0015) | accepted |
| 0024 | Explicit stale-lock recovery (amends 0015) | accepted |

Headers may carry `Amends` / `Amended-by` / `Depends on` lines; the records
they link are never edited beyond those pointers and dated addenda.

Status transitions are separated from implementation: the session or agent
that implements an ADR never flips its status. `proposed -> accepted` is an
act of the owner (or a reviewing session the owner has delegated), recorded
in the status line — an implementer accepting its own governing decision is
the rubber-stamp pattern 0017 warns against.
