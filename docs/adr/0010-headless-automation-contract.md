# 0010 — Fail-closed headless and JSON automation contract

Status: accepted (2026-08-19, implemented across the initial build and the v0.2 tranche; backfilled same day)

## Context

Headless `pi -p` is piko's composition primitive: sub-agent spawns, CI, bench
harnesses, and meta-harness backends all consume it programmatically. Early
versions could exit 0 with an incomplete answer, and progress/answer streams
were the only machine interface. An automation surface that fails open is
worse than none.

## Decision

The headless contract is versioned and fail-closed:

- stdout carries only the final reply (or, with `--json`, a versioned JSONL
  event stream with typed rows such as `usage_summary` v1); all progress and
  diagnostics go to stderr.
- Exit codes are semantic and default to failure: 0 only for a verified
  completed turn, 2 for budget_exceeded, 3 for incomplete/unknown terminal
  states, 130 for user cancellation, 1 for errors — the initial value is
  failure, and success must be proven by a terminal status.
- The `--json` stream is the stable automation surface; its schema carries a
  version field and additions are backward compatible. Human-readable output
  makes no stability promise.

## Consequences

- A parent process can trust exit codes and parse events without scraping
  prose; the bench/eval tooling consumes the same typed rows it ships.
- Fail-closed semantics surface real problems in CI instead of laundering
  them into green runs.
- Costs: exit-code and event-schema changes are now breaking changes requiring
  versioning discipline; a richer bidirectional RPC surface remains future
  work (roadmap v0.3) and must not fork this contract.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it. The review
found no direct literature on exit-code or JSONL automation contracts; these two
are the nearest evidence, and both support fail-closed by construction.

- corroborates: "AgentChaos", Tan et al., ASE 2026, arXiv 2608.06790. Silent
  failures without an error signal are the critical vulnerability, and diagnosis
  accuracy stays below 53% when the signal is missing; the case for failure as
  the initial exit value.
- corroborates: "Capability Gates Are Not Authorization", Mellafe Zuvic et al.,
  arXiv 2606.28679, 2026. LangChain, LlamaIndex and the Stripe toolkit all lack
  a deterministic fail-closed per-call gate by default, so a fail-closed
  automation contract is less common than it sounds.

## Amendment (2026-08-25, exit code 5 and typed lock-contention error)

0024 adds one exit code to the headless contract: 5 means the newest
resumable session is locked and nothing was resumed or created. It is a
deliberate, versioned extension of the code set (0 success, 1 error,
4 suspended awaiting approval, 5 locked newest head); scripts that treated
all nonzero as failure keep working, scripts that react to lock contention
can now distinguish it. In --json mode the run_error event carries
code: "locked_session_head" for the same purpose, and pi doctor sessions
emits doctor_session / doctor_recover / doctor_error rows under the same
versioned envelope, keeping argument errors on the typed stdout channel.

## Addendum (2026-09-02, exit codes)

143 is the exit code for termination by signal, whether the shutdown was forced
or cooperative. It is delivered with 0027 in tranche 2; this addendum records
the contract now so an operator writing a supervisor unit knows what to expect,
and so 0027 has a code to point at.

The complete code list, restored:

| Code | Meaning |
|---|---|
| 0 | verified completed turn |
| 1 | error |
| 2 | budget_exceeded |
| 3 | incomplete or unknown terminal state |
| 4 | suspended awaiting approval (0011) |
| 5 | newest resumable session is locked; nothing was resumed or created (0024) |
| 130 | user cancellation (SIGINT) |
| 143 | terminated by signal (SIGTERM), forced or cooperative (0027) |

The 2026-08-25 amendment above lists 0, 1, 4 and 5. That was a restatement in
the context of the newly added code 5, not a change to the set: 2, 3 and 130
were never withdrawn and remain part of the accepted contract. The rule that
failure is the initial value and success must be proven by a terminal status is
unchanged; 143 joins 130 as a signal outcome, not a success.

## Addendum (2026-09-02, capabilities row)

R2-11 of the red-team remediation plan adds one backward-compatible field to
this contract, corrected by R2-5 below. A headless `--json` run emits a
dedicated first row that carries a `capabilities` object alongside the existing
`v` and `sessionId` fields (and `parentRunId` when one was given). The row has
no `event`: it is the contract, not a turn event. An adapter reads it to
discover what it is talking to instead of inferring it from a piko version
string:

- `journalSchemaVersion`: the journal schema generation this build writes
  (`JOURNAL_SCHEMA_VERSION`).
- `tools`: the tool names available for this run, after built-ins, host-bash
  gating, and extensions are resolved.
- `exitCodes`: the full exit-code set a caller must interpret, as documented
  above and amended for 0024.
- `budgetScope`: `turn`, the scope every budget ceiling is enforced against
  (ADR 0009 scope note; ADR 0026 proposes session scope).

Event rows are byte-identical to what they were, and a consumer that ignores
unknown rows and fields is unaffected. This is an additive extension of the
versioned schema, so `v` stays 1. It is deliberately a read-only
self-description and not an RPC surface: the bidirectional adapter work remains
future work under R0-6.

### Correction (R2-5): which rows carry capabilities

The original shape attached `capabilities` to the first `Agent.run()` event.
Any run that failed before that event produced no capabilities at all, which is
exactly when a caller most needs to know what it is talking to: a provider
transport failure before the first event, an extension or config failure, a
suspended session resumed without a decision, a locked newest head, and the
`--max-depth` refusal all emitted either a bare `run_error` or, for the depth
refusal, no stdout bytes whatsoever. The corrected contract is:

- **Full capabilities**, all four fields and no `partial` flag: the dedicated
  first row, emitted as soon as setup succeeds and before the turn is iterated.
  Setup succeeding is what makes `tools` knowable, so this is the earliest
  honest point for the complete form.
- **Partial capabilities**, `journalSchemaVersion`, `exitCodes` and
  `budgetScope` with `partial: true` and `tools` omitted: every `run_error`
  row. A failure can land before the tool set is resolved, so the tool names
  are omitted rather than guessed, and `partial: true` says so explicitly, so
  an absent list is never read as an empty list. A run that got past setup and
  then failed emits the full row first and the partial `run_error` row after
  it; the fuller row wins for any consumer that keeps the first one it sees.
- **No capabilities**: every event row other than the contract row, exactly as
  before. `doctor sessions --json` also carries none: it is a separate
  read-only surface with its own `doctor_*` row types, and it never runs a
  turn.

The `--max-depth` refusal, which previously wrote nothing to stdout in `--json`
mode, now emits a `run_error` row with the partial form and still exits 1. The
non-JSON surface is unchanged: one line on stderr, exit 1. Exit codes are
unchanged on every one of these paths.
