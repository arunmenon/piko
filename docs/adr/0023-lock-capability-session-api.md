# 0023 - Lock-capability session API

Status: accepted (2026-08-25; ratified with owner amendments, recorded below)
Amends: 0015

## Context

0015 promises single-writer sessions, and the CLI honors it, but the review
proved the library boundary does not: `Session.open()` returns a fully
mutable session without acquiring the lock, and two openers of one journal
interleaved conflicting lifecycle transitions (accept and reject of the
same approval), corrupting the journal into
`SessionCorruptionError: ... cannot be decided from planned`. An invariant
the type system does not enforce is a convention, and 0015's amendment now
records that honestly. This ADR makes the invariant structural.

## Decision

Split the session API by capability:

- `SessionView` (read-only): everything `Session.open()` legitimately
  serves today: reading rows, lineage, cost summaries, audit. No append
  methods exist on this type.
- `LockedSession` (append-capable): obtained only through
  `Session.openLocked()`, which acquires the wx lock file and embeds a
  non-forgeable owner token; every append path verifies it holds the live
  token before writing. `close()` releases the lock; the token dies with it.
- `Session.open()` returns `SessionView`. This is a breaking change for
  any `@pi/core` consumer that mutated through it; the CLI already follows
  the locked path and needs only type-level migration.
- The capability requirement covers EVERY path that yields a mutable
  session (owner amendment): creation, branching, compaction, and
  continuation as well as open. No public API may create an unlocked
  mutable session; `Session.create()` returns a `LockedSession` that
  already holds the lock it created.
- The lock is acquired BEFORE parsing, repairing, or publishing a journal
  and retained through the entire mutation lifecycle; repair and
  reconciliation tools take `LockedSession` too. There is no unlocked
  mutation path left in the public surface.
- The owner token is private to the module and runtime-verified on every
  append; `close()` is idempotent.

## Acceptance regression

Two `openLocked()` calls on one journal: the second fails. A `SessionView`
has no append methods (compile-time). A forged token (constructed rather
than obtained from `openLocked`) is rejected at append time. The review's
double-open interleaving scenario becomes impossible to express, and a
dedicated test proves `Session.create()` is not an unlocked mutation
escape hatch: the session it returns holds the lock, and a second
opener against the fresh journal fails until it is closed.

## Consequences

- 0015's single-writer property becomes enforced at the API boundary
  instead of promised in prose; the amendment's caveat can be retired.
- One semver-major break of the library surface; acceptable pre-1.0 and
  worth it before any external consumer exists.
- The lock file gains a second role (token anchor), which 0024's recovery
  workflow must respect when cleaning stale locks.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Capability Myths Demolished", Miller, Yee & Shapiro, technical
  report, 2003. Unforgeable capabilities enforce least authority and are not
  reducible to access control lists; the module-private token here is an object
  capability in the strict sense, and the record can say so.
- corroborates: "The Chubby lock service for loosely-coupled distributed
  systems", Burrows, OSDI 2006. Lock-delay and sequencers deliberately withhold
  a dead holder's lock rather than reassign it, the published precedent for this
  record's refusal to take over automatically.
- challenges: "Leases: An Efficient Fault-Tolerant Mechanism for Distributed
  File Cache Consistency", Gray & Cheriton, SOSP 1989,
  doi 10.1145/74850.74870. Time-bounded grants recover from holder failure
  without manual intervention, which is the standard answer this record declines
  by giving the lock no expiry.

## Addendum (2026-09-02, capability framing and expiry)

- Object capability, strictly. The module-private token is an object capability
  in the sense of Miller, Yee and Shapiro: unforgeable, held rather than named,
  and conferring exactly the authority to append to one journal. The record used
  "capability" as a description; it is also the term of art, and the strict
  reading is the one intended.
- No expiry is a choice, not an omission. Gray and Cheriton's leases are the
  standard automatic recovery from a dead holder. This record instead takes
  Chubby's withholding stance: a dead holder's lock is diagnosed and removed by
  an explicit act (0024), never reassigned on a timer. The cost is that recovery
  needs an operator, or later a supervisor; the benefit is that no second writer
  is ever admitted on the strength of a clock.
- Single writer and the supervisor. 0027's host events (drain markers and
  forced-kill outcomes) need a journal write path that does not break this rule.
  That path is defined in 0027, so the supervisor writes through the token
  holder or a named side channel rather than opening the journal itself.
