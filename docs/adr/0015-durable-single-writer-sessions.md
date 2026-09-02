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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "All File Systems Are Not Created Equal", Pillai et al., OSDI
  2014. 60 crash vulnerabilities in 11 applications from unwarranted atomicity
  and ordering assumptions, including a missing directory fsync, which is why
  this record fsyncs the directory as well as the file.
- corroborates: "Crash Consistency", Pillai, Chidambaram & Arpaci-Dusseau, ACM
  Queue 2015, doi 10.1145/2800695.2801719. Torn and reordered writes are the
  norm, so tolerating a torn tail is the correct posture.
- corroborates: "Can Applications Recover from fsync Failures?", Rebello et al.,
  ATC 2020. PostgreSQL and Redis silently lose data on fsync failure; the case
  for poisoning the session on an uncertain write rather than continuing.
- corroborates: "Model-Based Failure Analysis of Journaling File Systems",
  Prabhakaran et al., DSN 2005. Partial-write mishandling motivates
  application-level validation of middle rows.

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

## Addendum (2026-09-02, repair recorded as a row)

The corruption policy above tolerates a partial JSON tail and truncates it. It
did not say where that fact is written down. In practice it was written nowhere
durable: the reopen printed `warning: ignored a corrupt trailing line` to
stderr, then the next append quietly truncated the file. Stderr is gone the
moment the terminal scrolls, and the truncation left no trace, so an operator
reconciling a crashed run afterwards could not tell that any bytes had been
discarded, how many, or where. A journal that fails closed on corruption
elsewhere should not be silent about the one corruption it tolerates.

The repair is now recorded in the journal it repaired:

- A `journal_repaired` lifecycle row carries the repair kind
  (`truncated_partial_line` or `appended_missing_newline`), the byte `offset`
  the repair was applied at, and the `discardedBytes` it removed. The newline
  kind always discards zero bytes, which the validator enforces.
- The row is written as the first row of the first append after a tolerated
  partial tail, by the same write that applies the repair (see the correction
  below for the protocol). Nothing is claimed before the bytes that back the
  claim land, and a journal that is reopened but never written to is left
  byte-identical.
- `pi doctor sessions` reports the count per session, in the text listing and
  in the `--json` rows (`repairs`, omitted when zero). The count is read with a
  tolerant line scan, so one unreadable journal cannot break the inventory that
  is meant to diagnose it.
- The row is additive. `JOURNAL_SCHEMA_VERSION` stays at 2: an older reader
  refuses only rows it cannot validate, and this row type is new rather than a
  change to any existing row.

Consequence: the tolerated crash artifact stops being an unrecorded edit to the
user's own history. The cost is one extra row per repaired session, and the
knowledge that a repair happened is now discoverable long after the stderr that
first announced it is gone.

## Correction (2026-09-02, the repair protocol, replacing "same batch and same fsync")

The wording above, "in the same batch and the same fsync as the rows that append
motivated", was wrong about the code it described. The first implementation did
two separate durability operations: `repairAppendBoundary()` truncated the
journal and fsynced it, and only then did `durableAppend()` write the batch that
began with the `journal_repaired` row. A crash between the two left a valid
journal, ending on a row boundary, with no repair row anywhere in it. The
discarded bytes then became permanently invisible: exactly the silence the
addendum claimed to have removed. An external review reasoned this out
(docs/reviews/2026-09-02-r2-review.md, finding 4) and it was correct.

Repair and evidence are now one operation (`durableRepairAndAppend` in
packages/core/src/session.ts):

1. Serialize the `journal_repaired` row followed by the rows this append was
   asked to write. The size limit is still checked before any of this, against
   the size the file will have after the repair, so a refused append never
   leaves a repaired boundary behind (the R2 ordering fix stands).
2. Open a second descriptor on the same journal WITHOUT `O_APPEND`. Linux
   ignores the offset of a positional write on an `O_APPEND` descriptor and
   appends instead, which would leave the fragment in front of the new rows.
   Re-check on that descriptor that the file is regular, has exactly one link,
   and still has the size the parse measured.
3. Write the rows positionally at the repair offset: over the fragment for a
   truncated partial line, at end-of-file behind an added delimiter for the
   missing-newline kind. `fsync`.
4. Truncate to the new end, and only if the old file was longer than it.
   `fsync` again.

The journal keeps its inode throughout. There is no temp file and no rename, so
the single-link check and the pathname-keyed lock stay meaningful.

Two crash windows exist, and both are safe:

- Between step 3's write and its fsync: every byte written lies at or after the
  repair offset, inside the region the reader already refuses to trust. The file
  still ends without a trailing newline, so the next open tolerates the same
  tail and repairs from the same offset. A repair row cannot survive a crash
  that lost the repair, because the row is inside the same unfinished write.
- Between step 3 and step 4, the window that replaces the fatal one: the rows
  are durable and the tail of the old fragment survives after them. The original
  fragment contained no newline, because it is by definition everything after
  the last delimiter in the file, so the leftover contains none either and the
  file again ends without a trailing newline. The next open tolerates that
  leftover exactly like the first partial tail and records a SECOND
  `journal_repaired` row whose `discardedBytes` is the leftover length. Bytes are
  never discarded without a row that says so, and the first repair row, already
  durable, is still there to be read.

One reader change follows from the second window: the leftover is a suffix of a
torn row, and a suffix can be well-formed JSON while being no session row at all
(a bare number, a bare string). `parseFile` now tolerates an undelimited final
line that parses as JSON but fails row validation, the same way it already
tolerated one that fails to parse. Delimited rows anywhere in the file still
fail closed. Both windows are covered by tests in
packages/core/tests/session.test.ts: one drives the completed protocol over a
fragment longer than the rows written across it and asserts exactly one repair
row, and one performs the step-3 write, skips step 4, reopens, and asserts two
repair rows whose byte counts add up.
