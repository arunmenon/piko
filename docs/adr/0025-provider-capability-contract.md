# 0025 - Provider capability contract

Status: proposed (2026-09-02; renumbered from the plan's phantom "ADR 0022" reference, owner ratification pending)
Depends on: 0008

## Context

Provider adapters share a strict terminal contract (0008), but the policies
around them are not recorded together: which adapters are admitted, which
features each supports, who is authoritative for model and context-window
limits, how profiles and aliases resolve, retry-after-response and billing
rules, usage normalization, and the conformance suite a provider must pass
before it enters the support matrix. The implementation plan (G14) has
cited this decision as "ADR 0022" since 2026-08-24; that number was
consumed by descriptor-anchored containment, so the plan pointed at a
record that did not exist.

## Decision (proposed)

One record defines, for every admitted provider: the capability set it
declares (tool calling, streaming, cache control, reasoning budgets,
long-context tiers); the source of truth for context-window and pricing
limits (the pricing table for cost, the adapter for windows, never the
model's self-report); profile and alias resolution order; retry-after-
response and billable-retry rules consistent with 0020's reservation
math; usage normalization into 0007's usage rows; and a conformance suite
(providers.test.ts and sse.test.ts as the seed) that runs green before a
provider is listed as supported. The Responses API path for OpenAI's
newer models is admitted through this contract, not ad hoc.

## Consequences

- Closes plan gap G14 and the dangling reference.
- A provider that cannot pass the conformance suite is unsupported rather
  than partially working.
- One more record to maintain; small, because most clauses already exist
  as scattered tests and adapter behavior.
