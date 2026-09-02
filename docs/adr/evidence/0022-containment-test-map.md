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

All eight attacks now run through `Tool.execute()` (R2 finding 6: seven of
the eight previously drove the resolver or the atomic-write helper instead
of a tool). The tests assert the security property rather than one specific
error, because a descriptor-anchored implementation may legitimately either
refuse the swapped path or complete the operation against the descriptor it
already holds; what it may never do is read, create, replace, or strand a
file outside the workspace.

The single non-todo test is a positive control: it proves the harness
detects a plain, non-race symlink escape today, so a green run is evidence
the file was exercised rather than silently skipped.

Race simulation. Every clause below is claimed by an end-to-end test, and
each end-to-end test keeps a lower-level supplement beside it. No timing
loops are used anywhere.

- `barrier` (end-to-end, the acceptance evidence): call the real
  `readTool.execute` / `writeTool.execute` / `editTool.execute` /
  `mapTool.execute` and perform the swap from inside that call, through a
  containment barrier registered at a named point of the shipped
  implementation (`containmentBarriers` in
  packages/core/src/tools/filesystem.ts: `after-resolve`, `before-open`,
  `before-mkdir`, `before-temp-create`, `before-rename`, `before-cleanup`,
  and `before-map-directory-open` inside the map walk). The barrier is a
  test-only seam that performs the swap and changes nothing else; the
  registry is empty in production, where the cost is one Map lookup per
  point. The whole tool path therefore runs across the swap.
- `split` (supplement): call the containment check the tool calls
  (`resolveWorkspacePath`), swap a validated parent directory for a symlink
  pointing outside the workspace, then run the operation stage against the
  checked result. It localizes a failure to one stage; it is not the
  acceptance evidence.
- `hook` (supplement): drive the swap from inside a single tool call through
  a seam the tool already reads. The map walk polls `context.signal`, which
  is that seam.

All tests below are in packages/core/tests/containment.test.ts. The
end-to-end tests are in the describe block "ADR 0022 acceptance regression:
complete tool paths across a parent swap"; the supplements are in "lower-level
supplements: single-stage checks behind the end-to-end attacks above".

| Clause | End-to-end test (`barrier`) | Supplement | State |
|---|---|---|---|
| Parent-swap during write fails closed; no out-of-workspace file created | `write.execute: a parent swapped mid-call must not create a file outside the workspace` (`before-temp-create`) | `write: a parent swapped after the containment check must not create a file outside the workspace` (split) | todo (both fail on current tree by design) |
| Parent-swap during read fails closed; no host file disclosed | `read.execute: a parent swapped mid-call must not disclose an out-of-workspace file` (`before-open`) | `read: a parent swapped after the containment check must not disclose an out-of-workspace file` (split) | todo (both fail on current tree by design) |
| Parent-swap during edit fails closed; temp files cleaned up | `edit.execute: a parent swapped mid-call must not replace an out-of-workspace file` (`before-temp-create`) | `edit: a parent swapped after the containment check must not replace an out-of-workspace file` (split) | todo (both fail on current tree by design) |
| Parent-swap during map traversal fails closed; a swapped queued directory cannot redirect the walk outside the workspace (map.ts walks path strings; O_NOFOLLOW guards only the final component) | `map.execute: a queued directory swapped mid-walk must not redirect the traversal outside the workspace` (`before-map-directory-open`) | `map: a queued directory swapped mid-walk must not redirect the traversal outside the workspace` (hook, via `context.signal`) | todo (both fail on current tree by design) |
| Parent-swap during intermediate directory creation (write to a new nested path) fails closed | `write.execute: intermediate directory creation through a swapped parent must not build directories outside the workspace` (`before-mkdir`) | `write: intermediate directory creation through a swapped parent must not build directories outside the workspace` (split) | todo (both fail on current tree by design) |
| Temporary-file placement for atomic writes stays inside the walked parent | `write.execute: the temporary file must stay inside the walked parent after a parent swap` (`before-temp-create` swaps, `before-rename` observes) | `atomic write: the temporary file must stay inside the walked parent after a parent swap` (split) | todo (both fail on current tree by design) |
| Swap between temp create and rename fails closed | `write.execute: the rename window must not commit an out-of-workspace replacement` (`before-rename`) | `atomic write: the rename window must not commit an out-of-workspace replacement` (split) | todo (both fail on current tree by design) |
| Cleanup after a failed swap leaves no temp file inside or outside the workspace | `write.execute: a failed swap must leave no temporary file inside or outside the workspace` (`before-rename` swaps, `before-cleanup` reports the temp path) | `atomic write: a failed swap must leave no temporary file inside or outside the workspace` (split) | todo (both fail on current tree by design) |
| Harness proof of life: a plain symlink escape out of the workspace is refused today | `positive control: a plain symlink escape out of the workspace is refused today` | n/a (not a race) | passing |
| Unsupported platform fails closed with a clear error, no path fallback | platform gate in containment.test.ts skips (does not todo) the swap tests on win32; the runtime clause still needs a mechanism-side test | n/a (gate only) | pending |
| Mechanism choice recorded as a dated addendum (executor-contained openat helper vs native addon) | n/a (record) | n/a | pending owner decision (maturity plan T0) |

What each end-to-end attack does on the current tree, recorded so a
re-review can check the tests are not vacuous. Each line is the assertion
message the todo test prints today.

- read: `readTool.execute` re-traverses the checked path through the swapped
  parent and returns the out-of-workspace file's bytes to the model.
- write: `writeTool.execute` completes with no error and creates the file in
  the redirected parent.
- edit: `editTool.execute` reads the in-workspace file, then commits the
  replacement over an out-of-workspace file, again with no error.
- mkdir: `mkdirSync(dirname(path), { recursive: true })` builds the
  intermediate directories outside the workspace. The re-resolve after mkdir
  then refuses the write, so the escape here is the directory tree, not the
  file.
- temp placement: the `before-rename` observation lists the outside
  directory while the temporary exists and finds the `.pi-tmp-` file there,
  which is direct proof the temporary was staged outside the workspace.
- rename window: the rename resolves through the swapped parent, fails
  `ENOENT`, and the temporary is stranded in the real workspace directory
  instead of the write failing closed and cleaning up.
- cleanup: the same stranded temporary. `before-cleanup` reports the path
  the implementation tried to unlink; that unlink also resolves through the
  symlink, so the file it names is still in the workspace afterwards.
- map: a directory queued as a path string is opened after its parent
  became a symlink, and the walk reports files that exist only outside the
  workspace.

The maturity plan (T2 5a-ii) requires these tests to be written first,
fail on the current tree, and pass with the chosen mechanism before any
Security 4 claim. The first half of that requirement is now satisfied and
checkable by running `npm test` and reading the todo count.
