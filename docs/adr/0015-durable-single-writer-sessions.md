# 0015 — Durable single-writer session store

Status: accepted (2026-08-19, backfilled same day; implemented in the v0.2 tranche)

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
