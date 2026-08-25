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
