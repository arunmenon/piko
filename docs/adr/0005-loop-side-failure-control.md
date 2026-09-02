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

## Addendum (2026-09-02, successful-repeat detection)

Red-team finding R2-3 (docs/red-team-remediation-plan-2026-09.md section 6 item
3): the guard as accepted read only error signals, and any success cleared both
counters. A model that read the same file eleven times successfully was never
nudged, and a model alternating between two calls was invisible because each
call reset the other's count. The consequence above that says looping on
successful no-op calls is "not yet detected" is superseded by this addendum; the
accepted text is left as written.

What changed in the loop:

- Every settled outcome is classified, not only failures. The classifier hashes
  the tool name plus a canonical JSON rendering of the arguments (object keys
  sorted, depth- and cycle-bounded), so the same call written with keys in a
  different order counts as the same call, and the guard's memory stays constant
  per distinct call rather than proportional to argument size.
- Error thresholds are unchanged: nudge at 5 consecutive failures or 2 identical
  failing calls, stop at 10 or 4.
- Identical *succeeding* calls get their own relaxed thresholds, defaults nudge
  at 4 and stop at 8, because a succeeding repeat is weaker evidence of a loop
  than a failing one.
- An alternating-pair detector counts the A,B,A,B run ending at the newest call
  in A,B cycles: defaults nudge at 6 cycles and stop at 8. Any third distinct
  call breaks the run.
- A success no longer clears the identical-success counters. Only a genuinely
  new call (a signature this turn has not made before) clears them, which is the
  only progress signal available without reading tool semantics.
- All eight thresholds are configurable through the existing `flailGuard`
  options shape; `false` still disables the whole guard.
- The success and alternating cases get their own harness messages. The success
  texts say the calls are succeeding but repeating, so the model is not told it
  is failing when it is not, and the CLI reports which pattern fired instead of
  printing a failure count for a run of successes.

Tuning status: the four new defaults (4/8 successful repeats, 6/8 alternating
cycles) were chosen on the dev set only. They must be checked on the held-out
draw before any benchmark claim is made about them, per the dev-set firewall;
that bench run is not part of this change. Tests: eleven identical successful
reads nudge then stop, key-order-independent signatures, an alternating pair
detected, a genuinely new call resetting the counters, and the unchanged error
thresholds and wording (packages/core/tests/guard.test.ts).
