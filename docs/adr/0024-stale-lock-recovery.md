# 0024 - Explicit stale-lock recovery

Status: proposed (2026-08-24; drafted from external review finding 3, owner ratification pending)
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

- When session selection would skip a locked newer session, fail with a
  non-zero exit that names the locked session file, its lock age, and the
  recorded owner (pid, host, started-at), and points at the recovery
  command. No automatic takeover, ever; 0015's no-takeover stance stands.
- Add `pi doctor sessions`: lists sessions with lock state; for a lock
  whose recorded owner is verifiably dead (pid absent AND lock inode
  matches the record, checked immediately before unlink), offers removal
  with an explicit confirmation. The check-and-unlink is documented as
  best-effort protection against races with a reviving owner: the unlink
  binds to the inspected inode, not the path.
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
