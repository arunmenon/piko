# Review prompt: red-team tranches R1 and R2 (correctness and robustness)

Paste everything below this line into the reviewer. Review the tree at
commit 0e633e0 of github.com/arunmenon/piko (branch main). The diff under
review is `git diff 0b69794..0e633e0`, which is 22 commits: the eight
merged worktree branches for R1 and R2 of
docs/red-team-remediation-plan-2026-09.md plus the changelog, README, and
checklist commits. Do not review anything outside that diff except where a
change in the diff depends on it.

---

You are an adversarial reviewer of a TypeScript agent harness. Your job is
to find defects, not to summarize. Every finding must cite file and line,
state the input or sequence that triggers it, state the wrong outcome, and
say whether you executed it or reasoned it. Findings you could not confirm
are labelled "plausible" and ranked below confirmed ones. No finding is
complete without a concrete trigger.

Context. The repository is piko, a lean cost-first coding harness governed
by ADRs in docs/adr. A red-team review at
docs/reviews/2026-09-02-red-team-review.md produced a remediation plan at
docs/red-team-remediation-plan-2026-09.md. Tranches R1 (record) and R2
(runtime) of that plan are what you are reviewing. Read the plan's sections
5 and 6 first so you know what each change claims to do; then read the code
and decide whether it does that, and what else it does.

Setup. `npm ci && npm test && npm run check-budget`. The suite must report
305 passing, 0 failing, 8 todo, and the budget gate must report ~815 of
1000 tokens at baseline 815. If your numbers differ, report that first.

Priorities, in order: correctness, robustness under adversarial or
unlucky input, regressions in behaviour that existed before the diff,
test adequacy, record accuracy. Style is out of scope unless it hides a
defect.

## Part 1: correctness and robustness, item by item

For each item, the questions are the minimum. Add your own attacks.

### 1. Protected-path deny list (ADR 0006 addendum)
Files: packages/core/src/tools/filesystem.ts (PROTECTED_DIRECTORY_NAMES,
PROTECTED_WORKSPACE_ROOT_FILES, protectedPathRule, assertPathNotProtected,
the `forMutation` option on resolveWorkspacePath), tools/write.ts,
tools/edit.ts, tools/types.ts (allowProtectedPaths), packages/cli/src/args.ts
and main.ts (`--allow-protected-paths`).
- Is the check applied on the canonical path after symlink resolution in
  every mutation path, including the second resolve in write.ts after
  mkdirSync? Is there any mutation path (rename, temp file, atomic replace)
  that resolves once and mutates elsewhere?
- Case-insensitive segment comparison: does it cause false refusals on
  case-sensitive filesystems (a legitimate directory named `.Git`), and does
  the choice match the filesystem the workspace is on rather than the host
  default?
- Can a path reach `.git/hooks` via a symlink whose target is outside the
  workspace but inside a second workspace? Via `..` normalised by the
  resolver? Via a hard link (nlink is checked elsewhere in the codebase;
  is it checked here)?
- Are reads of protected paths still allowed as claimed, and does the map
  tool still list them? Does `--allow-protected-paths` reach every tool
  through ToolExecutionPolicy, or only write and edit?
- The write tool description was shortened to fit the budget. Does the
  model-facing behaviour still match the description (parent directories
  are still created)?

### 2. Write `expected_sha256` precondition (ADR 0007 addendum)
Files: packages/core/src/tools/write.ts.
- Is the hash computed on the same bytes the tool is about to overwrite,
  with no window between hash and write? Which encoding is hashed?
- What happens when `expected_sha256` is malformed (uppercase, wrong
  length, non-hex)? Refused or silently ignored?
- Does the precondition interact correctly with the deny list (order of
  checks) and with the atomic replace path (temp file then rename)?

### 3. Legible spend ceiling (ADR 0020 addendum)
Files: packages/core/src/agent.ts (SpendStop, effectiveSpendCeilingUSD,
spendStopFor, SpendBudgetExceededError, the four stop sites),
packages/cli/src/render.ts (formatSpendStop), packages/cli/src/main.ts
(headless, REPL, `--usage` spendCeiling).
- Do the four numbers satisfy actual + reserved + reservation > ceiling at
  every stop site, including the post-response overshoot and both
  compaction-summary throws? Construct a sequence where they do not.
- Is `reservedUSD` at stop time the outstanding exposure (unsettled
  reservations) and not the reservation being attempted, double-counted?
- Does the `turn_done` event repeat the same object, or a later snapshot
  that may have changed after reconciliation?
- Is the six-decimal formatting stable for values above 1000 and below
  0.000001? Any float summation order that changes the printed effective
  ceiling by a cent?
- In `--json` mode the human line is suppressed; confirm the four numbers
  are on the `budget_exceeded` row and are not lost when the stop happens
  inside compaction.

### 4. Turn wording (ADR 0009 addendum)
Files: agent.ts messages, args.ts help, main.ts terminal line.
- Any external consumer (bench/, docs, tests, evidence maps) that matched
  the old `run budget` or `run <status>:` strings and now silently
  mismatches? Check bench/routing.py and bench/harbor_agent.py.

### 5. Capabilities row (ADR 0010 addendum)
Files: packages/cli/src/capabilities.ts, main.ts first-row emission.
- Is the row truly first in every path, including a run that resumes a
  suspended session, a run that fails before tools resolve, and a `-c`
  continuation? Which paths carry no capabilities row, and does the
  addendum say so?
- Does the exit-code set in the row match what main.ts can actually exit
  with after this diff (is 5 present; is 143 absent, correctly, since 0027
  is unimplemented)?

### 6. Flail guard classifier (ADR 0005 addendum)
Files: packages/core/src/agent.ts (canonicalJson, flailSignature,
countAlternatingCycles, successCounts, seenCallSignatures,
callSignatureHistory, failureNudged and repeatNudged, FlailKind), main.ts
rendering, packages/core/tests/guard.test.ts.
- canonicalJson: cycle and depth bounds, key sorting for nested arrays of
  objects, handling of undefined, NaN, bigint, and very large argument
  strings. Can two different argument sets collide to one signature
  (truncation to 32 hex chars is 128 bits; is anything truncated before
  hashing)?
- Alternating detector: define exactly what a "cycle" is in the code and
  check the off-by-one at the thresholds (6 nudge, 8 stop). Does an
  A,B,A,B,C,A,B sequence reset as the addendum claims? Does A,A,B,B count?
- Interaction between the three counters: can a call be counted as both an
  identical success and part of an alternating pair, and does that produce
  a nudge and a stop in the same turn or two nudges? Is the `nudged`
  split racy with batched tool calls in one response?
- Regression: a legitimate polling pattern (run tests, edit, run tests)
  where arguments are identical each time. Does the guard now stop useful
  work at 8 identical successful `bash npm test` calls? Is that acceptable
  and documented?
- History bounds: memory per turn is claimed constant per distinct call;
  verify callSignatureHistory is bounded and seenCallSignatures cannot grow
  without limit in a long turn.

### 7. Child bounds (ADR 0004 addendum)
Files: args.ts (`--parent-run`, `--max-depth`, DEFAULT_MAX_DEPTH), main.ts
(depthRefusal, parentRunId on rows), packages/core/src/tools/bash.ts
(PI_DEPTH in the allowlist, readProcessDepth, sanitizedBashEnvironment).
- `PI_DEPTH` is set explicitly for children and never inherited; confirm a
  model cannot lower it for a grandchild by exporting inside one bash call
  and whether that limitation is stated.
- Malformed PI_DEPTH (negative, float, huge, whitespace) at startup: refused
  or treated as root? The two behaviours (startup vs child env) must agree.
- depthRefusal ordering: does it run before session open and before pricing
  fetch, and after help and doctor? Does exit 1 collide with any documented
  meaning in the exit table?
- parentRunId validation: telemetry's rule versus the flag's rule; can an
  id containing newlines or control characters corrupt a JSONL row?

### 8. Extension pins and `extension_loaded` row (ADR 0012 addendum)
Files: packages/cli/src/extensions.ts (parseExtensionRequest,
LoadedExtension), journal.ts (`extension_loaded` validator), session.ts
(recordExtensionLoaded), main.ts.
- TOCTOU between hashing the file bytes and `import()`: is the import fed
  the hashed bytes, or the path? If the path, state the window and whether
  it matters given the threat model (extensions are trusted controller
  code).
- `@sha256:` parsing: a path that legitimately contains `@sha256:`; a scope
  path like `@scope/pkg`; a digest with uppercase hex; a 63-character
  digest. Which are pins, which are paths, and is any silently a path when
  the user meant a pin?
- Does the row get written for extensions loaded from the config file as
  well as the CLI, and before the first model call in every path? What
  happens on an unpinned extension whose file is unreadable after load?
- The reader validates row types strictly, so an older reader refuses a
  journal with this new row. The addendum records this as a 0019 gap.
  Confirm the claim, and whether `pi doctor sessions` on an older build
  would now fail on every new journal.

### 9. Journal repair row (ADR 0015 addendum)
Files: session.ts (TailRepair, appendMany prepending the row,
countJournalRepairs, SessionLockReport.repairs), journal.ts
(journal_repaired, journalRepairs), main.ts doctorSessions.
- The repair row is prepended to the first append: is it inside the same
  fsync as the rows that follow, and what does the file look like if the
  process dies between ftruncate and the append? Can that produce a second
  repair on the next open, and is the row's `discardedBytes` then wrong?
- The size-limit check moved before repairAppendBoundary. Is the size used
  the post-repair size, and can the reordering refuse an append that
  previously succeeded?
- validateLifecycle: can a `journal_repaired` row appear anywhere other
  than after a tolerated tail (for example forged mid-file), and is that
  rejected or accepted?
- countJournalRepairs is tolerant of corruption; can it undercount, and is
  its cost bounded on a large sessions directory?

### 10. Bash workspace digest (ADR 0007 addendum)
Files: bash.ts (workspaceDigestFor, WORKSPACE_DIGEST_TIMEOUT_MS), journal.ts
(WorkspaceDigest), session.ts planTool, agent.ts planningWorkspaceDigest.
- Three git invocations under one 2 second deadline: what is the actual
  worst-case added latency per bash call on a large repository, and is the
  deadline enforced on the sum or per call? Does a slow `git status` leak a
  child process past the deadline?
- The digest runs under the sanitized environment: does it inherit the
  model-visible PI_DEPTH or any credential-shaped variable? Does it run in
  the persisted cwd or the workspace root?
- A digest over `git status --porcelain -z` includes untracked file names;
  can a filename with a newline or NUL change the digest non-deterministically
  or break the hash input?
- Is the digest recorded when the tool call is later skipped or refused
  (deny list, approval), and does that leave an orphan field?

### 11. Replay conformance test (ADR 0007 addendum)
File: packages/core/tests/journal-replay.test.ts.
- Does "parse then re-append yields identical state" actually re-append
  through the public API, or through a helper that bypasses validation?
  Would the test catch a validator that accepts a duplicated executionId?
- Which lifecycle paths are not in the corpus (compaction cap stop, spend
  stop, extension row, repaired tail followed by another crash)?

### 12. Two-number budget gate (ADR 0001 addendum)
Files: scripts/check-budget.ts, packages/core/src/context-budget.ts,
package.json (`precheck-budget`).
- Are the caps read from the real constants (MAX_AGENTS_MD_BYTES,
  MAX_SKILL_INDEX_ENTRIES times MAX_SKILL_SUMMARY_BYTES,
  DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES) or copied? Would a change to those
  constants be reflected without editing the gate?
- The unbounded skill entry names and paths: is that a real unbounded
  prompt input on a trusted run, and what is the practical bound? Is a
  malicious repository able to blow the first request past the context
  window with long skill filenames?
- The gate now builds first. Does CI still fail on a regression before the
  build step masks it, and can `npm run check-budget` on a fresh clone with
  a stale dist produce a wrong number?

### 13. Cache measurement (ADR 0014 addendum)
Files: packages/ai/src/cache.ts, config.ts (cacheTtl), anthropic.ts
(cache_control ttl), main.ts startup line and `/model` warning,
bench/compare_runs.py hit-rate column.
- The provider minimums are constants (1024, 2048, 1024) while Anthropic's
  published table is per model and ranges 512 to 4096. Which models will
  the startup line get wrong, and is the line worded as an estimate?
- cacheTtl mapped onto every cache_control breakpoint: does an `1h` TTL on
  the system block plus a `5m`-eligible message block violate Anthropic's
  ordering rule (longer TTL breakpoints must precede shorter), and is the
  body byte-identical when the option is omitted?
- The hit-rate formula divides cache_read by input_uncached + cache_read +
  cache_write. Is that the same denominator render.ts uses, and is a run
  with cache_write only shown as 0% or blank?

### 14. Compaction changes (ADR 0003 addendum)
Files: agent.ts (summary request shape, buildRehydrationBlock,
touchedFilePaths, compactionsThisTurn, compaction.maxPerTurn,
compaction.rehydrateFileCount), packages/ai/src/types.ts (toolChoice),
anthropic.ts and openai.ts mapping.
- The summary request now carries the full tool list with
  `toolChoice: 'none'`. Confirm both providers honour it (Anthropic
  `tool_choice: {type: 'none'}` requires a recent API version; OpenAI
  `'none'`). What happens if a provider ignores it and returns a tool call
  in the summary: is the summary rejected, partially applied, or journaled
  as a tool call?
- Does the cached-prefix claim hold: is the summary request's system and
  tools byte-identical to the live request including any thinking or
  cache_control blocks, and is the dropped-prefix message list an exact
  prefix of the live messages (no re-ordering, no offload stubs that differ)?
- Rehydration block: AGENTS.md is extracted from `<project-instructions>`
  markers. Can a repository author inject a fake closing marker inside
  AGENTS.md to add text that survives compaction outside the delimiters?
  Are the touched paths untrusted text that a hostile filename could turn
  into an instruction?
- The compactions-per-turn cap ends the turn `incomplete`; does the
  preflight event carry enough to distinguish a capped stop from a
  no-headroom stop, and is the cap checked before any summary is billed as
  claimed?
- Regression risk: with tools present, does the summary token estimate
  used by the truncation envelope now include the tool schemas, and can the
  envelope binary search loop forever when the tools alone exceed the
  window?

### 15. Containment acceptance tests (R2-13)
File: packages/core/tests/containment.test.ts, docs/adr/evidence/
0022-containment-test-map.md.
- Are the eight todo tests attacking the real tool code paths, or
  re-implementing the primitives so that a future mechanism could pass the
  test while the tool still escapes? For each, say which.
- The map test hooks `context.signal.aborted` with a swap on the twelfth
  access. Is that deterministic across Node versions, and does the test
  assert the hook fired?
- Confirm on Node 20.11 and 22 that a failing todo does not fail the run,
  and that the positive control cannot be satisfied by an unrelated error.

## Part 2: cross-cutting

- Concurrency and ordering: the diff was merged from eight branches
  touching agent.ts, main.ts, journal.ts, and session.ts. Look for merge
  seams: duplicated declarations, a variable declared in one branch and
  used in another under a different name, event fields added in one place
  and not the other, or a check that one branch moved and another still
  assumes the old position (the systemPrompt construction in main.ts and
  the journal union in journal.ts are the two places to start).
- Journal compatibility: two additive row types and two optional fields
  were added without a generation bump. Is "ignorable by older readers"
  true anywhere in the reader, or is it a promise 0019 makes that the code
  contradicts?
- Fixed prefix: it stayed at 815 by shortening the write tool description.
  Verify the gate measures the schemas the provider actually receives after
  this diff (including `expected_sha256`), not a stale build.
- Fail-closed audit: list every new code path that catches an error and
  continues (workspace digest, countJournalRepairs, canonicalJson bounds,
  the depth parser). For each, is continuing the safe direction?
- Windows and macOS: which of the new tests skip on Windows, and does any
  new production code assume a POSIX path separator or case sensitivity?

## Part 3: record accuracy

- Do the dated addenda on 0001, 0003, 0004, 0005, 0006, 0007, 0009, 0010,
  0012, 0014, 0015, 0020 describe what the code does, including the
  limitations the implementers reported (depth cap bypassable by a model
  with host bash; thresholds unverified on the held-out draw; provider
  minimums approximate; the 0019 reader gap)? Quote any sentence that
  overclaims.
- Research addenda: sample ten citations across ADRs and confirm each
  resolves and says what the addendum says it says. Report any that do not.
- CHANGELOG Unreleased and README: any claim without code behind it?

## Output

1. Findings, most severe first, each with: severity (blocker, major,
   minor), file:line, trigger, wrong outcome, confirmed or plausible, and
   the smallest fix.
2. A table of the fifteen items with a one-word verdict each: sound,
   defective, or untested.
3. Regressions: behaviour that worked before 0b69794 and does not now.
4. Rescore the maturity dimensions using the same rubric and weights as
   docs/reviews/2026-09-02-t1-review.md (correctness 20, security 20,
   failure honesty 15, financial 10, tests 10, docs 10, ops 10, benchmarks
   5), with one sentence per dimension saying what in this diff moved it or
   did not. The score is secondary to the findings.
5. The minimum patch set that would make you call R2 closed.

---

## R2.1 re-review (2026-09-02, after the review above was addressed)

Paste the block below together with everything above it.

The R2 review at docs/reviews/2026-09-02-r2-review.md was addressed by the
R2.1 patch set (`git diff 0e633e0..main`, the merges after commit b297955).
Review the head of main. Expected baseline: `npm test` reports 334 passing,
0 failing, 16 todo (the eight end-to-end ADR 0022 attacks plus the eight
lower-level supplements), 1 skipped (the case-sensitivity complement that
does not apply to the running filesystem); the budget gate reports ~815 of
1000 at baseline 815.

For each of the twelve R2 findings, state whether the fix closes it, closes
it with a stated limitation, or leaves it open, citing the code and the
test that proves it. Re-run every executed reproduction from the R2 review
against the new tree and report its outcome. In particular:

1. Finding 1: confirm the git probe cannot run for a `bash` call that is
   absent, disabled, rejected by validation, unapproved, past the tool
   budget, or after abort, and that an approved dispatch with an executable
   `core.fsmonitor` in the repository config does not execute it (see
   packages/core/tests/workspace-digest.test.ts). Attack the hardening
   list: is there any remaining git configuration key, environment
   variable, or alias path that can execute a program under
   `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and the `-c`
   overrides? Confirm the shared deadline and process-group kill.
2. Finding 2: the pin now re-reads and re-hashes after import and the
   contract is narrowed to the entry module. Say whether the narrowed
   contract is stated honestly everywhere (row field, ADR 0012, CHANGELOG).
3. Finding 3: `expected_sha256` is now described as a stale-at-check
   precondition with bounded hashing. Confirm the wording nowhere claims
   compare-and-swap.
4. Finding 4: the repair protocol (positional write on a non-O_APPEND
   descriptor, fsync, conditional truncate, fsync). Reason through both
   crash windows and the parseFile tolerance for an undelimited final line
   that parses as JSON but is not a row; try to construct a fragment that
   is a valid row and would be silently accepted.
5. Finding 5: the dedicated capabilities row and the partial form on every
   run_error path, including depth refusal in `--json`. List any remaining
   path with neither.
6. Finding 6: the barrier registry in filesystem.ts. Confirm it costs one
   Map lookup per point in production and cannot be reached by the model;
   confirm each end-to-end todo test fails at its intended assertion.
7. Finding 7: `compaction.matchLiveCacheKey` and the recorded mode. Confirm
   the summary request equals the live request on every provider cache-key
   field when thinking is on; state what remains unmeasured.
8. Finding 8: the JSON-fenced rehydration block. Try to break the framing.
9. Finding 9: the dated per-model minimum table and the "unknown" wording.
10. Findings 10 to 12: eval marker, spend precision, filesystem-aware case
    folding. Confirm each regression test uses the producer's own string or
    the real filesystem probe.

Then rescore on the same rubric and say what the minimum remaining patch
set is, if any.

---

## T2 review (2026-09-03): the boundary

Paste this block together with the header and Part 1 rules above. Review the
head of main. The diff under review is everything after commit 47d73bb (the
T2 merges: 5c cooperative shutdown, 5d argument-aware approvals, 5b
session-tree budget authority, 5a sandbox executor with the bubblewrap and
Seatbelt providers, 5a-ii the ADR 0022 attacks through the executor, 5e the
threat model). Expected baseline on macOS: `npm test` reports about 399
passing, 0 failing, 17 todo (16 in-process ADR 0022 entries plus the
in-workspace cleanup residue through the executor), 1 skipped; the budget
gate reports ~815 of 1000 at baseline 815. On Linux CI the bubblewrap
provider runs; on a host without bwrap those tests skip with a reason.

Setup note: the Seatbelt provider needs `sandbox-exec`; the bubblewrap
provider needs `bwrap` and unrestricted user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=0` on Ubuntu 24.04).

For each of the five items, correctness and robustness first, then whether
the ADR addendum states what the code does and its limits:

1. Sandbox executor (ADR 0018 and its three 2026-09-02 addenda;
   packages/core/src/executor/*). Attack the boundary: from inside a
   sandboxed bash, try to read the session store, the config, the parent's
   environment, the network, and any path outside the workspace; try to
   escape through `/tmp`, through the private temp directory, through
   `/proc` on Linux, through the node binary's own directory, and through
   the worker protocol itself (a crafted response, an oversized line, a
   second `ready`). Check the acquire-time self-test cannot be satisfied
   by a broken provider. Check the control plane never enters the worker:
   grep for credentials, session paths, and budget ledger paths reaching
   the spec. On macOS, assess what the profile still permits (`/usr`,
   `/System`, `/Library`, `/private/etc`, `/dev` readable) and whether any
   of it matters. Assess `--sandbox auto` versus the ADR's "fail closed,
   not a flag" wording and say whether the addendum's justification holds.
2. ADR 0022 through the executor (packages/core/tests/
   containment-executor.test.ts, the barrier bridge in
   executor/containment-barrier.ts). Confirm the eight attacks exercise the
   shipped code path and that the negative control proves the pass is
   real. Confirm the barrier bridge cannot be enabled from the model's
   environment or from project content. Assess the stated residue (the
   stranded in-workspace temporary) and whether it is a containment
   failure or a hygiene failure.
3. Session-tree budget authority (ADR 0026 addendum;
   packages/core/src/budget-authority.ts). Attack the lock: two roots on
   one ledger, a child forging `PI_BUDGET_AUTHORITY` to a foreign ledger, a
   stale lock reclaimed while its owner is alive on another host, a
   ledger edited by the model (it lives outside the workspace; confirm), a
   crash between reserve and dispatch, and reconcile of a request id that
   never reserved. Check the ancestor chain cannot double-charge or
   under-charge. Check the reminders never enter the fixed prefix. Confirm
   the measured throughput claim and whether the `Atomics.wait` blocking
   can stall the event loop in the REPL.
4. Cooperative shutdown (ADR 0027 addendum; packages/cli/src/main.ts,
   shutdown tests). Confirm exit 143 semantics on both paths and the
   refinement that a completed turn keeps its own code. Attack the
   supervisor: signal races between forward and kill, a child that
   re-parents, a grace of zero, SIGTERM during compaction, SIGTERM while
   suspended awaiting approval. Confirm the supervisor never writes the
   journal and that the drain row cannot be forged mid-file.
5. Argument-aware approvals (ADR 0011 addendum;
   packages/core/src/tools/approval-rules.ts). Attack the tokenizer with
   quoting, escapes, unicode, here-docs, `$IFS`, brace expansion,
   `command`, `exec`, `xargs`, `env`, `nohup`, `time`, aliases, functions,
   relative binaries, and a denied word split across segments. Check the
   inline-test runner cannot be bypassed by an empty test list. Check a
   grant row replayed from a journal edited by the model (the journal is
   outside the workspace; confirm the model cannot reach it without host
   bash).

Then: regressions since 47d73bb; whether the threat model at
docs/threat-model.md names a control the code does not have; the rescore on
the same rubric with one sentence per dimension; and the minimum patch set
to call T2 closed.
