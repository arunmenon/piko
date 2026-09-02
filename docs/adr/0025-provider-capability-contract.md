# 0025 - Provider capability contract

Status: accepted (2026-09-02 by owner delegation, "take the recommendations", with the registry-sourced amendment below; proposed 2026-09-02, renumbered from the plan's phantom "ADR 0022" reference)
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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it. The review
found no paper describing a provider capability registry; LiteLLM's price file
and models.dev are the de facto ones.

- corroborates: "ReliabilityBench", Gupta et al., arXiv 2601.06112, 2026. Schema
  drift, rate limits and partial responses are first-class production faults
  that a per-provider conformance suite would catch.
- corroborates: "AgentChaos", Tan et al., ASE 2026, arXiv 2608.06790. Robustness
  depends on system implementation rather than model capability, which is the
  argument for admission by conformance rather than by reputation.
- corroborates: "Enhancing reliability in AI inference services", Ranganathan
  et al., arXiv 2511.07424, 2025. Timeouts dominate real inference incidents, so
  timeout behaviour belongs in the declared capability set.

## Amendment (2026-09-02, R0-9 registry-sourced capabilities; accepted 2026-09-02 by owner delegation)

Drafted from the 2026-09-02 red-team review and section 4 of
docs/red-team-remediation-plan-2026-09.md. This is a draft for the owner to
accept or reject. It changes nothing until the owner records the decision; the
Decision text above stands exactly as proposed until then.

- Capabilities are sourced from the LiteLLM registry row piko already downloads
  for pricing, rather than hand-maintained. That row carries per-model support
  flags, tiered pricing, deprecation dates and context limits; piko reads the
  price fields today and discards the rest, and a second hand table would repeat
  the anti-pattern `tokens.ts` already shows.
- A profile may override any registry field. The override is explicit and
  recorded, so a wrong or stale registry row never blocks a working provider.
- The adapter never trusts the model's self-report for windows or capabilities.
  The registry is the default source and the profile is the override, which
  restates "the adapter is authoritative" as authoritative over the model, never
  over the operator.
- The per-provider conformance suite stays exactly as drafted. It is the part of
  this record with no equivalent in the field and the reason the contract is
  worth having.
- The Responses API is the first capability admitted through the contract,
  because the wire shape is the one currently missing.
