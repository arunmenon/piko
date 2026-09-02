# ADR 0022 evidence map: descriptor-anchored containment

Status of the record: accepted, and closed through the executor. There are
two paths and this map covers both, because they have different answers.

- The executor path is the mechanism, per ADR 0022's 2026-09-02 mechanism
  addendum. `packages/core/tests/containment-executor.test.ts` runs all
  eight attacks through a real acquired sandbox executor and they pass:
  the swapped parent points at a directory the worker's filesystem view
  does not contain, so the operation fails at the operating-system
  boundary. These tests are not todo.
- The in-process path is not race-proof, and this is not a hedge. With no
  sandbox provider, or under `--sandbox off`, the file tools re-traverse a
  checked path string and a parent-symlink swap defeats them. The eight
  attacks in `packages/core/tests/containment.test.ts` demonstrate exactly
  that: each one performs the real attack, asserts the secure outcome,
  fails on the current tree, and is marked `{ todo: <clause> }` with the
  clause as its reason. They stay todo. They are the honest statement
  about the in-process path and they must not be quietly flipped by
  anything short of a descriptor-anchored walk in process.

`npm test` therefore reports the executor tests as passing and the
in-process ones as todo, and stays green.

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
- `bridge` (the executor acceptance evidence): the same barrier points,
  reached inside the sandboxed tool worker. The tool runs in another
  process there, so the acquire spec asks for the barrier bridge
  (`SandboxSpec.containmentBarrierChannel`, in
  packages/core/src/executor/containment-barrier.ts): the worker then
  announces each barrier it reaches on a dedicated descriptor and blocks
  until the test writes one line back, and the test performs the swap in
  between, on the same filesystem the worker is looking at. The switch is
  reachable only from the spec and never from the environment, the shipped
  CLI path never sets it, and its whole production cost is one boolean
  check at worker startup.

## The executor path: the acceptance evidence

All tests in this table are in packages/core/tests/containment-executor.test.ts.
Each one acquires a real self-tested sandbox (Seatbelt on macOS, bubblewrap on
Linux), drives `read`, `write`, `edit`, or `map` through it, and performs the
swap from the test at the named barrier while the worker is paused. Where no
provider passes its acquire-time self-test the test skips with the refusal as
its stated reason; nothing is simulated. Each one asserts the security
property: nothing outside the workspace is disclosed, nothing outside the
workspace is created, replaced, or removed, and the operation reports a
failure rather than a success.

| Clause | Executor test (`bridge`) | Barrier | State |
|---|---|---|---|
| Parent-swap during write fails closed; no out-of-workspace file created | `write.execute through the executor: a parent swapped mid-call creates no file outside the workspace` | `before-temp-create` | passing |
| Parent-swap during read fails closed; no host file disclosed | `read.execute through the executor: a parent swapped mid-call discloses nothing outside the workspace` | `before-open` | passing |
| Parent-swap during edit fails closed; temp files cleaned up | `edit.execute through the executor: a parent swapped mid-call replaces no file outside the workspace` | `before-temp-create` | passing |
| Parent-swap during map traversal fails closed; a swapped queued directory cannot redirect the walk outside the workspace | `map.execute through the executor: a queued directory swapped mid-walk discloses nothing outside the workspace` | `before-map-directory-open` | passing, asserted as non-disclosure (see the deviation below) |
| Parent-swap during intermediate directory creation (write to a new nested path) fails closed | `write.execute through the executor: intermediate directory creation through a swapped parent builds nothing outside the workspace` | `before-mkdir` | passing |
| Temporary-file placement for atomic writes stays inside the walked parent | `write.execute through the executor: the temporary file never appears outside the workspace after a parent swap` | `before-temp-create` swaps, `before-rename` observes | passing (the temporary is never staged at all: the create is refused) |
| Swap between temp create and rename fails closed | `write.execute through the executor: the rename window commits no out-of-workspace replacement` | `before-rename` | passing |
| Cleanup after a failed swap leaves no temp file inside or outside the workspace | `write.execute through the executor: a failed swap leaves no temporary file outside the workspace` | `before-rename` swaps, `before-cleanup` reports the temp path | passing for the out-of-workspace half, which is the containment half |
| The same clause, in-workspace half | `write.execute through the executor: a failed swap leaves no temporary file inside the workspace either` | same | **todo**, with the reason in the marker: the cleanup unlink re-traverses the same swapped parent the rename did, so it fails too and the temporary staged inside the workspace before the swap is stranded in the real directory. The sandbox cannot help, because both the staging and the stranding happen inside the workspace, the one tree the worker may write. Closing it needs a descriptor-relative unlink, or a cleanup that unlinks through the descriptor the temporary was created with |
| Harness proof of life for the executor file | `negative control: the same swap does disclose the file when the sandbox filesystem view is widened` | `before-open` | passing (see below) |

Two deviations, recorded rather than smoothed over.

- map is asserted as non-disclosure, not as a reported failure. The walk skips
  a directory it cannot open and reports the rest of the workspace, which is
  the fail-closed behaviour for a survey; demanding an error would demand a
  different tool. The test additionally asserts that the walk did report the
  in-workspace files it had already reached, so an empty result cannot pass as
  a non-disclosure.
- The cleanup clause closes only in the direction ADR 0022 is about. The row
  above says which half is owed and why, and the todo test keeps it visible.

What the operating system actually did, per attack, on macOS 26.3 with the
Seatbelt provider. These are the observed failures, not predictions.

- read: `EPERM` on `stat` of `<workspace>/sub/notes.txt` through the swapped
  parent, thrown out of the worker; nothing disclosed.
- write: `EPERM` on `open` of the temporary in the redirected parent.
- edit: `EPERM` on the same open; the out-of-workspace file is byte-identical
  afterwards.
- map: the queued directory could not be opened, the walk skipped it, and no
  out-of-workspace file appears in the output.
- mkdir: `EPERM` on `mkdir` of the intermediate directory; no directory tree
  outside the workspace.
- temp placement: the create is refused, so no temporary is staged anywhere and
  `before-rename` is never reached.
- rename: `ENOENT` on the rename, because the source path now resolves through
  the symlink into a directory the sandbox has no view of.
- cleanup: the same, plus the stranded in-workspace temporary described above.

The negative control is what makes the eight non-vacuous. It runs the same
worker, the same bridge, and the same swap at the same barrier, with one thing
changed: the sandbox's filesystem view is widened to include the outside
directory (an extra `file-read*` subpath on macOS, an extra `--ro-bind` on
Linux). The read then discloses the out-of-workspace file, exactly as it does
in process. Such a provider cannot pass the acquire-time self-test, so the
control acquires it directly and never through `acquireVerifiedExecutor`.

## The in-process path: still red, still todo

All tests below are in packages/core/tests/containment.test.ts, which this
change leaves untouched. The end-to-end tests are in the describe block "ADR
0022 acceptance regression: complete tool paths across a parent swap"; the
supplements are in "lower-level supplements: single-stage checks behind the
end-to-end attacks above".

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
| Mechanism choice recorded as a dated addendum (executor-contained openat helper vs native addon) | ADR 0022 addendum of 2026-09-02 (mechanism) and of 2026-09-02 (acceptance through the executor) | n/a | recorded |

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
Security 4 claim. Both halves are now satisfied and both are checkable by
running `npm test`: the in-process attacks are still red and reported as
todo, and the same eight attacks pass through the executor. Any Security 4
claim has to carry the qualifier with it. The race is closed when a
sandbox provider is active and open in process, so the claim is about a
configuration, not about the harness in general.

Not verified on this host. The Linux side of the executor tests has not
been run here: this host is macOS, so the bubblewrap rows are what CI must
confirm, exactly as ADR 0018's own addendum says of its Linux provider. One
specific thing for CI to watch: the barrier bridge hands the worker a
fourth descriptor, and a launcher that did not pass it through would make
the worker refuse to start with a named error rather than pass quietly.
