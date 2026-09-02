# 0027 - Cooperative graceful shutdown

Status: proposed (2026-09-02; drafted from maturity plan T2 5c under owner amendment 1, ratification pending)
Depends on: 0007, 0009

## Context

`process.once('SIGTERM', () => controller.abort(...))` is the whole
shutdown story today. Under a supervisor every restart aborts in-flight
work, and a synchronously blocking extension can defeat any in-process
deadline. Plan gap G4 has described the intended drain since 2026-08-24
without a record.

## Decision (proposed)

- SIGTERM stops admission of new turns, journals a drain marker, and
  grants a configured grace period for in-flight operations to reach a
  durable terminal state.
- A supervisor process owns the hard-kill deadline, so a blocked event
  loop cannot extend it.
- Outcome semantics are 0007's, not a promise of tidiness: after a fully
  cooperative drain the run is journaled `canceled`. If the deadline
  forces termination, the run may be marked `canceled`, but any
  dispatched provider or tool operation without a durable terminal
  acknowledgement remains `outcome_unknown`. "No outcome_unknown rows" is
  a valid expectation only for the cooperative path.
- Drain outcomes are journaled as host events so a resumed session can
  tell a cooperative cancel from a forced one.

## Acceptance regression

A blocking-extension fixture proves the deadline holds and the forced
path leaves the in-flight operation `outcome_unknown` with the run
`canceled`; a cooperative-path test proves a clean `canceled` run with no
unknown rows; a fleet-style restart of an idle headless run leaves no
unknown rows.

## Consequences

- Unattended deployments get a defined restart contract.
- One supervisor process per headless run; small, and the same process
  the plan's fleet posture needs anyway.
