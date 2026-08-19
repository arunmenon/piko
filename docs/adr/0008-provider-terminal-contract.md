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
