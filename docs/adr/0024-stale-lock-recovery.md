# 0024 - Explicit stale-lock recovery

Status: accepted (2026-08-25; ratified with owner amendments, recorded below)
Amends: 0015

## Context

Locks are permanently authoritative until removed by hand, including locks
left by SIGKILL or a dead PID. That prevents split-brain, but the review
showed the operator-facing cost: `pi -c` filters locked sessions before
ranking, so after a crash it silently resumes an older conversation, or
reports "no previous session" and creates a blank one. The newest
conversation still exists on disk; the operator just cannot see why it is
being skipped. Silent fallback converts a safety mechanism into a
data-loss illusion.

## Decision

Never silently skip the newest candidate:

- Session selection ranks candidates BEFORE filtering locks (owner
  amendment): when the newest head is locked, `pi -c` fails non-zero,
  naming the locked session file, lock age, and recorded owner (pid,
  host, started-at) and pointing at the recovery command. It never
  silently resumes an older session or creates a blank one. No automatic
  takeover, ever; 0015's no-takeover stance stands.
- Add `pi doctor sessions`: read-only by default, listing sessions with
  lock state; JSON output follows ADR 0010. Removal requires an explicit
  confirmation flag.
- Recovery is serialized through a separate exclusive recovery lock
  (owner amendment): acquire it, then re-read the target lock's token and
  owner record immediately before deletion. POSIX path-based unlink is
  not an atomic compare-and-delete, so safety comes from serialization,
  not from any claimed inode binding. Cleanup is refused for owners that
  are live, on a remote host, malformed, or otherwise unverifiable.
- The lock record is versioned and expanded to carry host and start time.
  Legacy (unversioned) records remain diagnosable in doctor output but
  are never automatically removable.
- `--continue` gains no force flag; recovery is a deliberate separate act.

## Acceptance regression

Crash a session holding the lock (SIGKILL), run `pi -c`: exit is non-zero
and the message names the locked file and the doctor command; nothing was
silently created or resumed. Doctor removes the dead lock; `pi -c` then
resumes the newest session.

## Consequences

- The failure mode changes from silent wrong-session resumption to a loud,
  recoverable stop; operators keep the anti-split-brain guarantee without
  the illusion of lost data.
- One more command surface (doctor) to maintain; it becomes the natural
  home for future journal reconciliation tooling 0015 already anticipates.
