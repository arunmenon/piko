# 0027 - Cooperative graceful shutdown

Status: accepted (2026-09-02 by owner delegation, "take the recommendations", with the in-process-first amendment below; proposed 2026-09-02 from maturity plan T2 5c under owner amendment 1)
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

## Amendment (2026-09-02, R0-4 in-process cooperative path first; accepted 2026-09-02 by owner delegation)

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

## Addendum (2026-09-02, cooperative path shipped)

Built under maturity plan T2 5c against the amendment above: the in-process
cooperative path is the contract, and the supervisor is the named fallback for
the one case that path cannot cover.

**What SIGTERM now does, in headless and in the REPL.** It stops admission: the
agent takes a `requestDrain()` that no further model request and no further tool
dispatch may pass. The two admission gates are the only places the agent changed.
A call refused at the dispatch gate is journaled `tool_skipped`, because it
demonstrably never ran; work already dispatched is left alone. A
`run_drain_requested` row is appended by the process holding the lock, carrying
the signal name, the grace period in milliseconds, and the instant admission
stopped. The row is additive on the existing v2 shape, so
`JOURNAL_SCHEMA_VERSION` does not move. The grace period is
`--shutdown-grace <seconds>`, the `shutdownGraceSeconds` config key, then a
default of 10; zero means abort immediately.

**Outcome semantics, both paths.** Cooperative: every in-flight operation
reaches its own terminal row inside the grace period, the turn ends `canceled`
at the next admission gate, and the journal carries no `outcome_unknown` rows.
Forced: the deadline aborts the run signal, which is the only thing that
produces unknown rows, so every dispatched provider or tool operation without a
durable terminal acknowledgement is marked `outcome_unknown` exactly as 0007
requires, and the run is still journaled `canceled`. Nothing about 0007's
semantics was softened to make the cooperative path look tidy: the tidiness is a
consequence of not aborting, not a change of rule.

**Exit codes.** 143 for termination by SIGTERM on both paths, distinct from
SIGINT's 130, which is unchanged. 143 is added to `HEADLESS_EXIT_CODES`, so it
appears in the `capabilities` row of every `--json` run, and to the README
table. One refinement the plan text did not anticipate: 143 replaces the exit
code only for work the drain actually cut short, meaning a run with no terminal
row or one that ended `canceled`. A turn that had already reached `completed`,
`suspended`, or `budget_exceeded` when the signal landed keeps the code that
describes it, because that status is still the truth about the run and a fleet
operator reading 143 over a completed answer would be reading a lie. The REPL,
which has no single run to describe, exits 143 whenever it drains.

**The `--json` terminal row** carries `drain: "cooperative" | "forced"` beside
the `turn_done` event when a drain happened, and carries nothing new otherwise.
It is an additive field on the envelope, so `v` stays 1.

**The supervisor.** `--supervise` is headless-only and optional. It re-executes
this CLI as a child in its own process group with the same arguments minus the
flag, forwards SIGTERM (and SIGINT), waits the grace period plus a two-second
margin, then SIGKILLs the child's whole process group and reports 143 with one
line on stderr. It never opens, locks, or writes the session journal: 0023's
single writer is the child, and the amendment's talk of a supervisor write path
is satisfied by not needing one. A child killed mid-tool leaves a `tool_started`
row with no terminal row, and the next open of that journal marks it
`outcome_unknown`. That is the honest record and it is what the regression
asserts. A fleet with its own supervisor (systemd's `TimeoutStopSec` then
SIGKILL, a Kubernetes `terminationGracePeriodSeconds`) already owns this
deadline and should not run `--supervise`.

**Limitations, stated rather than implied.**

- A synchronously blocking extension defeats the in-process path completely: no
  timer fires, no drain marker is written, and the journal shows only the
  started row. The supervisor bounds the damage in wall-clock time; it cannot
  make the record better than "unknown", and nothing can.
- The drain marker is best-effort. A journal that refuses the append (a
  poisoned write path, a full disk) logs one line to stderr and the drain
  continues; the run's own terminal row remains authoritative.
- Where the signal lands inside a turn is not under piko's control. A SIGTERM
  that arrives after the last model response has already been consumed leaves a
  `completed` run and exit 0, which the fleet regression asserts as one of two
  admissible outcomes rather than pretending the race does not exist.
- The supervisor adds one process per headless run and puts the child in its own
  process group, so a terminal's Ctrl+C reaches the supervisor and is forwarded
  rather than being delivered to the child directly.

Regressions, all against real spawned processes with the fake provider
(`packages/cli/tests/shutdown.test.ts`): cooperative drain of an in-flight tool
call ends `canceled` with no unknown rows and exit 143; a forced drain of a tool
that outlives a one-second grace leaves that call `outcome_unknown` with the run
`canceled`, exit 143, and the drain row present; a blocking-extension fixture
under `--supervise` is killed at the deadline, exits 143, and its journal
reopens with the tool `outcome_unknown`; a fleet-style SIGTERM with nothing
dispatched leaves no unknown rows; the REPL drains and exits 143; the `--json`
terminal row names the path; SIGINT still exits 130.
