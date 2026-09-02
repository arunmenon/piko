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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "When Agents Do Not Stop", Hou et al., arXiv 2607.01641, 2026.
  Infinite agentic loops arise wherever a feedback path is unbounded, with 68
  confirmed across 47 of 6,549 repositories; the case for bounding in harness
  code rather than prompt language.
- corroborates: "Why Do Multi-Agent LLM Systems Fail?" (MAST), Cemri et al.,
  arXiv 2503.13657, 2025. Step repetition is the single most frequent failure at
  15.7%, and unawareness of stopping conditions is 12.4%.
- corroborates: "Understanding Code Agent Behaviour", Majgaonkar et al.,
  arXiv 2511.00197, 2025. Failed SWE-bench trajectories are consistently longer
  with higher variance, so early cut-offs pay.
- challenges: "The Cognitive Companion", Khan & Khan, arXiv 2604.13759, 2026.
  Looping occurs on about 30% of hard tasks, and heuristic repetition checks
  miss degradation that hidden-state probes catch (AUROC 0.84, small n). Error
  streaks are a narrower signal than the failure this record targets.
