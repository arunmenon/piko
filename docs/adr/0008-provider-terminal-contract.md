# 0008 — Strict provider contract with typed terminal states

Status: accepted (2026-08-19, implemented in the v0.2 tranche; backfilled same day)

## Context

The original providers accepted whatever arrived: a network cut mid-stream
became a normal end of turn, a half-received tool call could execute, and
`max_tokens` truncation looked like completion. Headless callers then trusted
exit code 0 on incomplete answers. Separately, malformed stream data was
silently skipped, which converted deterministic protocol bugs into silent
degradation and retry billing.

## Decision

A stream is successful only when the provider's own terminal signal was seen
(`[DONE]` / final finish_reason for OpenAI-compatible, `message_stop` for
Anthropic). Everything else raises a typed error: `ProviderProtocolError` for
malformed or contradictory protocol data (never retried — deterministic), and
`ProviderTransportError` for network-level failure (retryable). Every request
runs under a deadline that wraps all retries, not per attempt. Responses are
size-capped. `max_tokens` and other non-natural stops surface as distinct stop
reasons that the loop and CLI treat as incomplete, not success.

## Consequences

- Truncated answers cannot masquerade as finished work, and half-received tool
  calls cannot execute.
- Retry spend on unrecoverable protocol errors is eliminated by type, not
  heuristics.
- Costs: strictness against real-world sloppy proxies means some previously
  "working" (silently degraded) setups now fail loudly; each new provider
  adapter must implement the terminal-state contract, not just parse happy-path
  chunks.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Enhancing reliability in AI inference services", Ranganathan
  et al., arXiv 2511.07424, 2025. Of 156 high-severity LLM inference incidents,
  about 60% are inference-engine failures and about 40% of those are timeouts,
  so transport failure is the dominant class the typed transport and protocol
  split targets.
- corroborates: "ReliabilityBench", Gupta et al., arXiv 2601.06112, 2026.
  Injected timeouts, partial responses and schema drift drop success from 96.9%
  to 88.1%, a degradation single-run success rates miss.
- corroborates: "AgentChaos", Tan et al., ASE 2026, arXiv 2608.06790. Response
  truncation and tool-call field corruption are first-class faults, and
  robustness depends on system implementation rather than model capability.
