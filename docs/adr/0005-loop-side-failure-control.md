# 0005 — Loop-side failure control (flail guard) over prompt-side

Status: accepted (2026-08-18, backfilled 2026-08-19)

## Context

Doom-looping (repeating a failing approach while burning tokens) is the most
complained-about failure mode across all major harnesses, with no shipped answer.
Prompt-side mitigation ("try different approaches") costs fixed tokens on every
request and depends on model compliance — precisely what is absent while flailing.
Our own benchmark measured a single failed grind at 231k tokens.

## Decision

Failure control lives in the loop, not the prompt: the harness counts consecutive
tool failures and identical-call repeats; at configurable thresholds it injects a
one-time ~30-token nudge, then force-ends the turn with a demanded final report,
keeping the transcript API-valid. Zero fixed-context cost; disableable.

## Consequences

- Measured effect: equal accuracy at 59% less total spend on the benchmark re-run;
  worst failed grind cut 79%.
- The guard reads only error signals; looping on successful no-op calls is not yet
  detected (progress heuristics are follow-up work), and thresholds are heuristic.
- Establishes a design preference: behavioral guarantees belong in harness code
  where they are testable, not in prompt language where they are suggestions.
