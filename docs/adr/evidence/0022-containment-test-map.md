# ADR 0022 evidence map: descriptor-anchored containment

Status of the record: accepted, NOT implemented. This map lists the tests
the acceptance regression requires; none exist yet. It is committed so
the claim "reproductions are permanent tests" is checkable and currently
FALSE for this record.

| Clause | Required test | Status |
|---|---|---|
| Parent-swap during write fails closed; no out-of-workspace file created | deterministic parent-swap test, write path, macOS and Linux | pending |
| Parent-swap during read fails closed; no host file disclosed | parent-swap test, read path | pending |
| Parent-swap during edit fails closed; temp files cleaned up | parent-swap test, edit path, temp-file assertion | pending |
| Parent-swap during map traversal fails closed; a swapped queued directory cannot redirect the walk outside the workspace (map.ts walks path strings; O_NOFOLLOW guards only the final component) | parent-swap test, map walk | pending |
| Parent-swap during intermediate directory creation (write to a new nested path) fails closed | parent-swap test, mkdir path | pending |
| Temporary-file placement for atomic writes stays inside the walked parent; swap between temp create and rename fails closed | parent-swap test, temp placement and rename window | pending |
| Cleanup after a failed swap leaves no temp file inside or outside the workspace | cleanup assertion in every swap test | pending |
| Unsupported platform fails closed with a clear error, no path fallback | platform-gate test | pending |
| Mechanism choice recorded as a dated addendum (executor-contained openat helper vs native addon) | n/a (record) | pending owner decision (maturity plan T0) |

The maturity plan (T2 5a-ii) requires these tests to be written first,
fail on the current tree, and pass with the chosen mechanism before any
Security 4 claim.
