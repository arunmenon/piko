# 0015 — Durable single-writer session store

Status: accepted (2026-08-19, backfilled same day; implemented in the v0.2 tranche)
Amended-by: 0023, 0024

## Context

0007 records what the journal means; nothing recorded how it survives. The
original store had second-resolution IDs with 16 random bits (a reproduced
collision silently erased a session), world-readable files, overwrite-semantics
creation, and tolerant parsing that let corruption anywhere pass silently.
Sessions contain everything the user and model said, including secrets that
scrolled through tool output.

## Decision

- Creation: UUID identifiers, `O_EXCL` (never overwrite), mode `0600`, with
  fsync of both the file and its directory; the sessions directory is `0700`.
- Single writer: a `wx`-created lock file with an owner token; a stale-lock
  takeover inspects the token so an old releaser cannot unlink a successor's
  lock. Concurrent opens fall back to a fresh session rather than interleave.
- Corruption policy: a partial JSON tail (the expected crash artifact) is
  tolerated and truncated; corrupt or schema-invalid rows anywhere else fail
  closed with the line number. Ambiguous mid-write failures poison the
  in-memory session against further appends until reopened and reconciled.
- Size and rotation ceilings bound file growth; lineage rows link branches,
  compactions, and continuations so history is followable across files.

## Consequences

- A crash cannot silently lose or merge conversations, another local user
  cannot read them, and two processes cannot interleave one file — the
  properties 0011's suspended approvals depend on.
- Costs: fsync on the append path costs latency; fail-closed middle-row
  parsing means real corruption demands human reconciliation instead of
  silent skipping — chosen deliberately after the earlier skip-and-continue
  behavior masked data loss.

## Amendment (2026-08-24, from external review)

The Decision text above overstated two properties, confirmed by an
independent review against the implementation:

- No stale-lock takeover exists. A lock file is authoritative until removed
  by hand, including locks left by SIGKILL or a dead PID
  (packages/core/src/session.ts never unlinks another owner's lock). The
  token-inspection language described intent, not code.
- The library boundary does not enforce single-writer. `Session.open()`
  returns a fully mutable session without requiring the lock; two openers
  of one journal can interleave conflicting lifecycle transitions and
  corrupt it. The CLI locks correctly; `@pi/core` consumers are not forced
  to.

Consequently a crash CAN hide the newest conversation: `pi -c` filters
locked sessions and silently selects an older one, or reports "no previous
session". Until the proposed remediation ADRs land (lock-capability
session API; explicit stale-lock recovery), treat single-writer as a CLI
convention, not a core-enforced invariant.


Retirement note (2026-09-02): the amendment above described two gaps. Both are closed: 0023 makes single-writer a lock capability enforced at the library boundary, and 0024 replaces silent stale-lock fallback with a loud failure and `pi doctor sessions`. Treat single-writer as core-enforced again.
