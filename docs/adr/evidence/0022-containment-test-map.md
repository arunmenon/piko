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
| Unsupported platform fails closed with a clear error, no path fallback | platform-gate test | pending |
| Mechanism choice recorded as a dated addendum (executor-contained openat helper vs native addon) | n/a (record) | pending owner decision (maturity plan T0) |

The maturity plan (T2 5a-ii) requires these tests to be written first,
fail on the current tree, and pass with the chosen mechanism before any
Security 4 claim.
