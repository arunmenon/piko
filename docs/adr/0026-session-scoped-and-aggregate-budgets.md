# 0026 - Session-scoped and aggregate budget authority

Status: accepted (2026-09-02 by owner delegation, "take the recommendations"; proposed 2026-09-02 from maturity plan T2 5b under owner amendment 5)
Amends: 0009, 0020

## Context

Every `RunBudget` ceiling is enforced per user turn. In headless `-p` a
turn is the run, so the contract holds; in the REPL a `--max-spend-usd`
cap silently resets each turn, and a session can spend any multiple of
it. Contained delegation (0004 addendum, 0018) will add children that run
concurrently; reconstructing each child's journal after the fact cannot
bound concurrent spend. The competitive matrix and README both implied
"every mode" until the 2026-09-02 scope notes corrected them.

## Decision (proposed)

- One root-budget authority per session tree. Reserve and reconcile are
  atomic under a single root-budget lock; a child cannot dispatch until
  its reservation is admitted against the root's remaining budget.
- Branch semantics: a branch inherits the remaining root budget by
  reference, not by copy. Child-tree semantics: a child's exposure is
  charged to every ancestor up to the root.
- Unknown-request exposure: a dispatched request with no durable terminal
  acknowledgement keeps its full reservation on every ancestor until
  reconciled, exactly as the per-turn ledger does today (0007, 0020).
- Time ceilings are defined explicitly. `maxActiveTime` counts model plus
  tool wall time attributable to the tree, summed across parallel
  children. `maxElapsedTime` counts wall-clock from session start.
  Either, both, or neither may be set; "maxTime" alone is not a valid
  name in this record.
- Session-scoped `maxSpendUSD`, `maxTokens`, and the time ceilings are
  enforced alongside, not instead of, the per-turn ceilings of 0009/0020.
- Reservation bounds may use a tokenizer count only where a committed
  corpus proves it conservative against the provider's actual count;
  otherwise the byte-derived bound of 0020 stays.
- At every spend stop the harness prints reserved versus actual and the
  effective ceiling; `--usage` reports the effective ceiling.

## Acceptance regression

A REPL test that two turns cannot exceed the session cap; a concurrent-
children test that the sum of admitted reservations never exceeds the
root; an unknown-outcome child test that exposure persists until
reconciled; a test that the printed reserved/actual/effective numbers
explain a ceiling stop without reading the journal.

## Consequences

- Retires the largest semantic overclaim on the matrix; "every mode"
  becomes true.
- Adds a lock on the dispatch path of every child; acceptable because
  reservation is already a serialized step.
- Requires 0018's parent-controlled children to route admission through
  the parent, which is the intended design.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it. No paper
studies tree-scoped reservation; a DeepSeek community plugin is the only
implementation the review found.

- corroborates: "BAGEN: Are LLM Agents Budget-Aware?", Lin et al.,
  arXiv 2606.00198, 2026. Agents do not self-limit, so spend authority has to
  sit above them, which is what a root budget authority provides.
- corroborates: "Single-Agent LLMs Outperform Multi-Agent Systems", Tran &
  Kiela, arXiv 2604.02460, 2026. Multi-agent advantages vanish under matched
  token budgets, a comparison that is only checkable once the budget is enforced
  across the tree.
- corroborates: "Why Do Multi-Agent LLM Systems Fail?" (MAST), Cemri et al.,
  arXiv 2503.13657, 2025. Failure is attributed largely to system design rather
  than to individual agents, an argument for the parent owning admission.

## Addendum (2026-09-02, root-budget authority shipped)

The decision above is implemented in `packages/core/src/budget-authority.ts`
and wired into the loop at the existing reservation sites. This addendum
records what was built, what it guarantees, and what it does not.

### File layout

One ledger per session tree, `~/.pi/budgets/<rootRunId>.json`, written
`0600` in a `0700` directory. The root run id is the root's session id, so the
ledger name is already the identity every other surface uses. The document is a
single JSON object, schema version 1:

- `ceilings`: the tree's `maxSpendUSD`, `maxTokens`, `maxActiveTimeMs` and
  `maxElapsedTimeMs`; any subset may be set, and an unset ceiling is not
  enforced.
- `startedAtEpochMs`: the origin the elapsed ceiling is measured from.
- `runs`: every run that joined, with its `parentRunId` and its resolved
  ancestor chain, root first.
- `rows`: outstanding reservations only, each carrying `requestId`, `runId`,
  the ancestor chain, the reserved dollars and the reserved token bound.
- `history`: the most recent 256 terminal rows, for audit; no arithmetic reads
  them.
- `charges`: per run, the cumulative admitted, reconciled and outstanding
  dollars, tokens and request counts, plus active time. The root's entry is the
  tree total, because the root is in every row's charge set.

The ledger lives outside the workspace, so a model with write access to the
repository cannot rewrite its own budget.

### The lock

`<ledger>.lock`, created with `writeFileSync(..., { flag: 'wx' })`, the same
create-and-retry pattern the session lock uses (`acquireSessionLock`), holding
a `{v, pid, host, token, created}` record. Backoff doubles from 1ms to 16ms
against a 5 second deadline; the wait is a synchronous `Atomics.wait`, because
the whole ledger path is synchronous and a promise-based wait would reintroduce
the in-process interleaving the lock exists to prevent. Failing to acquire is
never tolerated: the caller fails closed, and in the agent an unusable ledger
ends the turn `incomplete: persistence` rather than dispatching an unadmitted
request.

One deviation from 0024's session-lock policy: this lock is broken
automatically when its owner is verifiably dead. The check runs at most twice
per acquisition (halfway through the wait and at the deadline) and requires all
of: same host, `process.kill(pid, 0)` reporting the pid gone, a lock file older
than 2 seconds, and the same token still present on a re-read immediately
before the unlink. A stranded session lock only blocks its own resume, which is
why 0024 leaves it alone; a stranded budget lock wedges every process in the
tree, which is why this one is reclaimed. Pid reuse remains the theoretical
hazard it is in `recoverStaleLock`.

### Ancestor charging

A run joins by writing its `parentRunId` into the ledger; the chain is resolved
once at join time from the parent's own chain, so a row records the full chain
root-first. Every reservation is charged to the reserving run, to each ancestor
in that chain, and to the root, through a set so a self-referential chain cannot
double count. `chargeFor(runId)` therefore answers "what has this subtree cost
the tree" for any run, and `snapshot()` is `chargeFor(root)` plus the elapsed
clock. A child that does not pass `--parent-run` is charged directly to the
root, which is conservative for the ceiling and merely less precise for
attribution.

The ledger path reaches children through `PI_BUDGET_AUTHORITY`, added to the
bash environment allowlist and set explicitly on every call exactly as
`PI_DEPTH` is, so a child can never inherit a stale path to a foreign tree. A
`pi -p` launched from a bash tool call joins the tree automatically; no flag is
needed on the child.

### What is atomic and what is not

Atomic: one `reserve`, `reconcile`, `releaseUnknown`, `recordActiveTime` or
join. Each takes the lock, re-reads the ledger from disk, mutates it, writes a
temporary file and renames it over the ledger, then unlocks. `snapshot()` reads
without the lock, which is safe because publication is by rename. No instance
caches ledger state, so two handles in one process cannot disagree with the
file. The concurrency test asserts the consequence directly: twenty child
processes racing on one ceiling admit a set whose sum never exceeds it, whose
size matches the ledger's admitted count exactly, and in which no request id
appears twice.

Not atomic: the pair (reserve, dispatch), and the pair (response, reconcile). A
process killed between them leaves a reservation with no request behind it, and
that is the deliberate 0007/0020 rule rather than a gap: the reservation stays
as exposure on every ancestor until an explicit `reconcile` or
`releaseUnknown`. `releaseUnknown` is never called automatically anywhere in
the harness. The unknown-outcome test kills a child after it reserves and
asserts the parent's snapshot still holds the exposure, and that a later
reservation is refused because of it.

Also not atomic, deliberately: nothing bounds how many children may run at
once. Concurrency remains out of scope, as 0004's addendum said.

### Measured throughput

Twenty concurrent child processes, ten reservations each (200 reservations, of
which the ceiling admits half), macOS on APFS: the contention window from the
first child entering its loop to the last leaving it is 220 to 830ms, that is
roughly 240 to 900 reservations per second, or 1.1 to 4.1ms per reservation
under the lock. The fast end is the file run on its own; the slow end is the
same file with the rest of the test suite running in parallel on the same
machine. End to end, including twenty Node process startups, the same run takes
270ms to 1.5s. The test prints both figures on every run. This is the number
the plan asked for before contained spawn is allowed to depend on the lock: at
20 children the lock is not the bottleneck, process startup is.

### Limitations

- An orphaned ledger. The root removes its ledger on a clean exit through a
  `process.once('exit')` hook, and deliberately keeps it when outstanding
  reservations remain, printing the path: that exposure is the record and
  deleting it would erase the only place a human can see it. A root killed with
  SIGKILL skips the hook and leaves the file behind. Such a file is inert:
  nothing joins a tree except through `PI_BUDGET_AUTHORITY`, which dies with
  the process that exported it. Cleanup is `rm ~/.pi/budgets/<id>.json` (and
  its `.lock`, if the crash also stranded one); there is no `doctor budgets`
  command yet, and adding one is the obvious follow-on.
- Reservation conservatism is unchanged. The tree reserves the same
  byte-derived input bound plus the enforced output cap that 0020 reserves per
  turn, so a tree ceiling also stops work at roughly half its nominal value on
  long contexts. The tokenizer-based bound this record allows is still not
  taken, because no committed corpus proves one conservative.
- Ledger growth is bounded by outstanding reservations plus 256 history rows
  plus one entry per run that ever joined (capped at 10,000 runs, after which
  joining is refused). A very long-lived tree with many children grows the
  `runs` map, not the row list.
- The reminder is advice, not enforcement. It is a `[harness]` turn message,
  never part of the fixed prefix, so it costs nothing until it fires; the model
  is still stopped by the ceiling rather than asked to respect it (0009).
- Time ceilings are checked at admission, not on a timer. A tree that exceeds
  `maxActiveTimeMs` in the middle of a long tool call is stopped at the next
  provider request, not mid-call; the per-turn `maxWallTimeMs` deadline of 0009
  is still the only thing that aborts work in flight.
