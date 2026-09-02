# ADR 0024 evidence map: explicit stale-lock recovery

| Clause | Test |
|---|---|
| Rank before filtering locks; locked newest head raises `LockedSessionHeadError` | packages/core/tests/session.test.ts "0024 acceptance: crash leaves a lock, selection fails loudly, doctor recovers, selection resumes"; "locked branch is reserved before copying and a locked newest head fails loudly (0024)" |
| `pi -c` exits 5 with owner detail and the doctor pointer; JSON row carries `code: locked_session_head` | packages/cli/tests/doctor.test.ts "0024 CLI acceptance: crash, exit 5 with typed JSON, doctor list, recovery, resume" |
| Doctor is read-only by default; JSON per 0010; argument errors typed | doctor.test.ts (listing, `doctor_error` rows) |
| Removal requires `--yes`; refuses targets outside the session inventory | doctor.test.ts (unconfirmed removal; `/tmp/not-a-session` escape refusal) |
| Recovery serialized via exclusive recovery lock with re-read before unlink | session.test.ts "0024: recovery refuses live, remote, malformed, and serialized-out owners" |
| Refuses live, remote, malformed, legacy owners | session.test.ts "0024: recovery refuses ..."; "latest-session discovery treats a dead-PID lock as contention" (legacy bare-pid record never auto-removable) |
| Target must be a real contained session (UUID name, single link, meta match) | session.test.ts "recovery refuses targets that are not real contained sessions (owner review)" |
| A crashed recovery does not disable recovery forever | session.test.ts "a crashed recovery does not disable recovery forever (owner review)" |
| Versioned v2 lock record with host and start time; public reports never carry the token | doctor.test.ts (asserts token absent from JSON) |
