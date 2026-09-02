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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it. No paper on
drain semantics for agent harnesses exists.

- challenges: "Crash-Only Software", Candea & Fox, HotOS 2003. Shutdown should
  be a crash and recovery a restart, because a separate graceful path is extra
  code with its own failure modes. This record is consistent with that canon
  only if the forced path is tested as the primary one, which the acceptance
  regression above must therefore keep doing.
- corroborates: "Microreboot", Candea et al., OSDI 2004. Externally driven
  component restarts with state kept outside the component, consistent with an
  external supervisor owning the kill deadline.

## Proposed amendment (2026-09-02, awaiting owner decision R0-4)

Drafted from the 2026-09-02 red-team review and section 4 of
docs/red-team-remediation-plan-2026-09.md. This is a draft for the owner to
accept or reject. It changes nothing until the owner records the decision; the
Decision text above stands exactly as proposed until then.

- The in-process cooperative path is the primary contract: SIGTERM stops
  admission, a bounded grace period runs, a drain marker is journaled, and the
  process exits 143. Any external supervisor (systemd, Kubernetes, a fleet
  orchestrator) then works without piko shipping one, which is what a project
  that sells zero dependencies should offer first.
- Piko's own supervisor is optional and exists only for the blocking-extension
  case, where a synchronously blocking extension can defeat an in-process
  deadline. It is a named fallback, not a component of every headless run.
- The supervisor's journal write path for host events is named as part of the
  design, so 0023's single-writer rule is not violated when drain markers and
  forced-kill outcomes are recorded.
- 143 is added to 0010's exit-code table as termination by signal, forced or
  cooperative; see 0010's addendum of the same date.
