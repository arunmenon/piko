# ADR 0022 evidence map: descriptor-anchored containment

Status of the record: accepted, NOT implemented. The acceptance regression
now exists as executable tests in
`packages/core/tests/containment.test.ts`. Every parent-swap test performs
the real attack against the current tree and asserts the secure outcome,
so each one fails today and is marked `{ todo: <clause> }` with the clause
as its reason. The suite therefore reports them as todo, not as failures,
and `npm test` stays green while the mechanism is owed. When the
descriptor-anchored walk lands, the `todo` markers come off and the tests
must pass unchanged in substance.

The single non-todo test is a positive control: it proves the harness
detects a plain, non-race symlink escape today, so a green run is evidence
the file was exercised rather than silently skipped.

Race simulation. Two deterministic approaches are used; no timing loops.

- `split` (check-then-operation split): call the containment check the tool
  calls (`resolveWorkspacePath`), swap a validated parent directory for a
  symlink pointing outside the workspace, then run the operation stage
  against the checked result.
- `hook` (in-flight hook): drive the swap from inside a single tool call
  through a seam the tool already reads, so the whole tool runs end to end
  across the swap. The map walk polls `context.signal`, which is that seam.

| Clause | Test in packages/core/tests/containment.test.ts | Race simulation | State |
|---|---|---|---|
| Parent-swap during write fails closed; no out-of-workspace file created | `write: a parent swapped after the containment check must not create a file outside the workspace` | split | todo (fails on current tree by design) |
| Parent-swap during read fails closed; no host file disclosed | `read: a parent swapped after the containment check must not disclose an out-of-workspace file` | split | todo (fails on current tree by design) |
| Parent-swap during edit fails closed; temp files cleaned up | `edit: a parent swapped after the containment check must not replace an out-of-workspace file` | split | todo (fails on current tree by design) |
| Parent-swap during map traversal fails closed; a swapped queued directory cannot redirect the walk outside the workspace (map.ts walks path strings; O_NOFOLLOW guards only the final component) | `map: a queued directory swapped mid-walk must not redirect the traversal outside the workspace` | hook | todo (fails on current tree by design) |
| Parent-swap during intermediate directory creation (write to a new nested path) fails closed | `write: intermediate directory creation through a swapped parent must not build directories outside the workspace` | split | todo (fails on current tree by design) |
| Temporary-file placement for atomic writes stays inside the walked parent | `atomic write: the temporary file must stay inside the walked parent after a parent swap` | split | todo (fails on current tree by design) |
| Swap between temp create and rename fails closed | `atomic write: the rename window must not commit an out-of-workspace replacement` | split | todo (fails on current tree by design) |
| Cleanup after a failed swap leaves no temp file inside or outside the workspace | `atomic write: a failed swap must leave no temporary file inside or outside the workspace` | split | todo (fails on current tree by design) |
| Harness proof of life: a plain symlink escape out of the workspace is refused today | `positive control: a plain symlink escape out of the workspace is refused today` | n/a (not a race) | passing |
| Unsupported platform fails closed with a clear error, no path fallback | platform gate in containment.test.ts skips (does not todo) the swap tests on win32; the runtime clause still needs a mechanism-side test | n/a (gate only) | pending |
| Mechanism choice recorded as a dated addendum (executor-contained openat helper vs native addon) | n/a (record) | n/a | pending owner decision (maturity plan T0) |

What each attack does on the current tree, recorded so a re-review can
check the tests are not vacuous:

- read: the checked path is re-traversed through the swapped parent and the
  out-of-workspace file is disclosed.
- write / edit / rename window: `atomicWriteTextFile` creates its temporary
  file in the redirected parent and renames over an out-of-workspace file.
- mkdir: `mkdirSync(dirname(checkedPath), { recursive: true })` builds the
  intermediate directories outside the workspace.
- temp placement: with the outside directory made unwritable, the temp open
  fails with `EACCES` inside that directory, which is itself the proof the
  temporary was placed outside the workspace.
- cleanup: the write commits outside the workspace instead of failing
  closed at the swap barrier.
- map: a directory queued as a path string is opened after its parent
  became a symlink, and the walk reports files that exist only outside the
  workspace.

The maturity plan (T2 5a-ii) requires these tests to be written first,
fail on the current tree, and pass with the chosen mechanism before any
Security 4 claim. The first half of that requirement is now satisfied and
checkable by running `npm test` and reading the todo count.
