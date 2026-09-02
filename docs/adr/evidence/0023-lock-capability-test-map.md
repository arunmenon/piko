# ADR 0023 evidence map: lock-capability session API

Clause-to-test map. All tests live in packages/core/tests/session.test.ts
unless noted; run with `npm test`.

| Clause | Test |
|---|---|
| `Session.open()` returns a read-only view with no mutators | "0023 acceptance: no public API yields an unlocked mutable session" (compile-time via `SessionView`; runtime `SessionLockError` on a cast) |
| `openLocked()` acquires the wx lock before parsing; second opener fails | "0023 acceptance: no public API yields an unlocked mutable session" |
| `Session.create()` returns a session already holding its lock (no escape hatch) | "0023 acceptance: no public API yields an unlocked mutable session"; "UUID creation is exclusive and session files are owner-only" |
| Every mutable path (create, branch, compaction, continuation) holds the lock | "locked branch is reserved before copying and a locked newest head fails loudly (0024)"; "branch copies messages up to the given index into a sibling file" |
| Module-private token verified on every append; forged token rejected | "0023 acceptance: no public API yields an unlocked mutable session" |
| `close()` idempotent; capability dies with it | "0023 acceptance: no public API yields an unlocked mutable session" |
| Hard-linked journal cannot mint two writers (owner re-review) | "hard-linked journal cannot bypass single-writer (owner review repro)" |
| Lock primitive: exclusive, owner-token protected, owner-only | "session locks are exclusive, owner-token protected, and owner-only" |
| CLI resumes only through `openLocked` | packages/cli/tests/approvals.test.ts (all resume flows); packages/cli/tests/cli.test.ts "an explicitly requested locked session fails instead of silently starting fresh" |
