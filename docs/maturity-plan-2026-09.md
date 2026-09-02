# Maturity plan: 2.6 to 4.0 (September 2026)

Status: revision 2, 2026-09-02. Direction approved by the owner; T1
approved to start; T2 and T3 conditionally approved subject to the
amendments recorded in section 9, all of which are folded into the text
below. No runtime work begins under any wording other than this one.
Tracks against docs/IMPLEMENTATION-PLAN.md (gap register) without
replacing it.

## 1. Why move the score at all, in plain terms

The maturity score is not a vanity number. It is eight questions a
stranger would ask before trusting piko with their code and their money,
weighted by how much damage a wrong answer does. Piko's whole pitch is
"governed, bounded, auditable". A governance harness scored 2.6 out of 5
by its own commissioned review is a contradiction that a buyer, a
contributor, or a CTO will notice before anything else. Each dimension
is a specific way piko can currently let someone down:

- Security 2/5 (weight 20%). The configuration people actually use
  (host bash enabled, because a coding agent without a shell cannot run
  tests or git) runs the model with the full authority of the host user.
  There is a reproduced filesystem escape (ADR 0022) still open, and the
  session journal that is honest against crashes is not honest against
  the model, which can rewrite its own history files. Every durability
  claim in the competitive matrix depends on fixing this.
- Correctness 3/5 (20%). "Run budget" means "one turn". In the REPL a
  $0.50 cap silently resets every turn, so a session can spend any
  multiple of it. Nobody can bound what child processes spend. The
  reservation math is right; its scope is smaller than the docs say.
- Failure honesty 3/5 (15%). SIGTERM aborts instead of draining, so every
  deploy restart in an unattended fleet turns in-flight work into
  "outcome unknown" instead of a clean cooperative cancel. The spend
  ceiling stops work at roughly half its nominal value without telling
  the operator why.
- Financial correctness 3/5 (10%). No session, child-tree, or fleet
  aggregate; the reservation bound is byte-derived and conservative by
  about 4x; 18 of 89 official benchmark trials went unpriced.
- Test quality 3/5 (10%). 250 tests, almost all in-process. Concurrent
  lock and approval tests exist, but there is no systematic
  cross-process race or chaos campaign, and no property or corpus tests
  for the parsers and journal replay; the 2,800-line agent loop is
  exercised only indirectly.
- Docs and ADR integrity 2/5 (10%). The record contradicts itself: the
  plan references an ADR 0022 that is a different decision from the one
  that exists; amended ADRs carry no back-pointers; CI enforces a
  token-rent rule whose amendment sits inside a still-proposed record;
  the changelog is frozen at a version never tagged.
- Operational maturity 2/5 (10%). No license, private packages, no
  install path that does not begin with a build. Nobody outside can use
  it, and that is a choice, not a limitation.
- Benchmark methodology 2/5 (5%). One cost-bounded n=1 run whose manifest
  disagrees with itself on its own counts.

Why these weights: the reviewer put 40% of the score on security and
correctness because those are the failures that cost real money or leak
real data; 15% on failure honesty because unattended operation is the
use case piko is built for; the rest on whether anyone can verify,
install, and trust it. Attacking by weight times headroom, security (2,
weight 20) and correctness (3, weight 20) are worth more than every other
dimension combined.

Why the number itself is a side effect: the score only means something if
it is re-measured by the same method against the same rubric. The real
deliverable of each tranche below is re-issuing
docs/reviews/codex-review-prompt.md against the new tree and committing
the report next to the 25 Aug one. Grades in the table are forecasts;
the tranche re-review assigns the actual grade.

## 2. The scorecard and the arithmetic

Weights: correctness 20, security 20, failure honesty 15, financial 10,
tests 10, docs 10, ops 10, benchmarks 5. Current grades 3/2/3/3/3/2/2/2
give 2.55, reported as 2.6. Forecast columns are targets the re-review
must confirm, not claims.

| Dimension (weight) | Now | T1 target | T2 target | T3 target | What moves it |
|---|---|---|---|---|---|
| Security & containment (20) | 2 | 2 | 4 | 4 | 0018 executor with control plane outside it; 0022 closed by a proven swap-barrier test; scoped threat model |
| Correctness & concurrency (20) | 3 | 3 | 4 | 4 | atomic aggregate budget authority; replay tests; cross-process race campaign |
| Failure honesty (15) | 3 | 3 | 4 | 4 | cooperative SIGTERM drain per ADR 0007; reserved-vs-actual visible at every stop |
| Financial correctness (10) | 3 | 3 | 4 | 4 | root-budget lock; unknown-request exposure; price or explain the 18 unpriced trials |
| Test quality (10) | 3 | 3 | 3 | 4 | G11 property/corpus suites; container fault tests; extracted invariants tested directly |
| Docs & ADR integrity (10) | 2 | 3 | 4 | 4 | record fixes; evidence maps; changelog; governance gates repaired |
| Operational maturity (10) | 2 | 2-3 | 3 | 4 | license and changelog are necessary, not sufficient; the re-review decides |
| Benchmark methodology (5) | 2 | 3 | 3 | 4 | generated manifest; pre-registered frontier rerun; DeepSeek arm |
| Weighted forecast | 2.55 | ~2.7-2.9 | ~3.75 | ~4.0 | |

Saturation warning: 4 on security requires a scoped threat model in
addition to the executor and the closed escape. 5 means an external audit
and a microVM path, which is a different project and out of scope here.

## 3. Tranche 0: owner decisions

Everything downstream is gated on decisions only the owner can make.

| Decision | Why it gates | Exit |
|---|---|---|
| License | Nothing public moves without it; ADR 0019 lists it first | LICENSE committed, package.json license fields set |
| Token-rent rule home | CI already enforces it; an amendment inside still-proposed 0017 is structurally ambiguous | Either a dated amendment to accepted ADR 0001, or its own accepted record; the ratchet note cites whichever wins |
| ADR 0021 | Its rule has already been applied retroactively | Either concrete retention classes and defaults added, then accepted; or explicitly accepted as principles only |
| ADR 0018 ratification | Gates all of T2 | Status flipped to accepted by the owner, with the acquire/exec/release seam as written |
| ADR 0019 ratification | Gates publication in T3 | Status flipped before any package is published |
| 0022 implementation path | Docker alone does not implement 0022 (see 5a) | Recorded as a dated addendum to 0022, not an informal line |
| npm scope | @pi/core is unpublished; scope ownership unconfirmed | Ownership or availability of the @pi scope confirmed, or a different scope chosen, before T3 |

Recorded 2026-09-02 by owner delegation ("take the recommendations"):
token-rent amendment to 0001 accepted; 0021 accepted with 30-day telemetry,
indefinite journals, and the deletion role named; 0018 accepted with the
lightweight provider first and the file tools inside the executor; 0022
mechanism recorded as the executor path with the native addon as fallback;
0025, 0026, and 0027 accepted with their amendments; 0017 sequenced after
the variance study; MCP and ACP stay non-goals through T3. Not taken: the
license and the npm scope, because no recommendation existed; Apache-2.0
is proposed for the owner and both gate T3 publication only. T1 closes at
2.7 under the same delegation.

## 4. Tranche 1: fix the record and the evidence (approved; about 4 days)

Cheap, mostly non-engineering, and it is where the score is being lost
for reasons that have nothing to do with the runtime. Each item is
verified against the tree before it is fixed.

1. Provider-capability ADR: G14 and Phase 3 of the plan cite "ADR 0022,
   the provider-capability contract"; the 0022 that exists is
   containment. Draft the provider-capability decision as 0025
   (proposed) and repoint the plan. Exit: no dangling ADR references.
2. Amended-by pointers: 0006 gets "Amended-by: 0022"; 0015 gets
   "Amended-by: 0023, 0024" and a one-line note that its amendment's
   caveats are retired. Exit: the README header rule holds for every
   amended record.
3. Evidence maps for 0022, 0023, 0024 under docs/adr/evidence/, mapping
   each acceptance clause to a named test (0023 and 0024 tests exist;
   0022's map lists the tests that must exist and marks them pending).
4. CHANGELOG: an Unreleased section that covers every user-visible change
   since 0.2.0 (0020 through 0024, exit code 5, pi doctor, spend
   ceilings, the token-rent revert, the two retractions). No tag exists,
   so "Unreleased" is the correct heading.
5. Budget semantics documented as per-turn wherever ADRs and README say
   "run", until T2 changes the runtime. Exit: no doc claims a session-wide
   cap that the code does not enforce.
6. TB 2.0 manifest regenerated from results.json by a bench/ script, so
   infra failures, ceiling stops, and unpriced trials have one source and
   one count. Exit: every number in the manifest is script-produced.
7. Matrix record and ROADMAP cleanup: the study record's opening stops
   grading DeepSeek "C, unverified" above the sections that upgrade it;
   ROADMAP gains the 0018/0022 line.
8. Governance drafts for the owner (T0 inputs): the token-rent rule
   re-homed as a proposed amendment to 0001; 0021 retention classes and
   defaults drafted; proposed ADRs (or dated amendments) for
   session-scoped budgets and for graceful shutdown, so that T2 is built
   under ratified text rather than plan prose.

Then re-issue the review prompt and commit the report.

## 5. Tranche 2: the engineering that changes the grade (conditionally approved; 2-3 weeks)

Gated on T0: 0018 accepted, the 0022 path recorded, and the session-budget
and shutdown ADRs at least proposed. Three items that together touch 65%
of the weighting.

### 5a. ADR 0018: sandbox executor, with the control plane outside it

- SandboxProvider seam exactly as 0018 defines it: acquire(image),
  exec(id, cmd, limits), release(id). Snapshot stays deferred.
- One Docker provider. Workspace mounted read-write at a fixed path;
  nothing else from the host. Sandbox networking is none: the sandbox
  never talks to a model provider, so there is no domain allowlist to
  get wrong.
- Control plane stays outside the sandbox: model calls, credentials, the
  journal, budgets, and the agent loop all run in the parent piko
  process. Only tool execution (the five tools' filesystem and shell
  effects) happens inside. Bash therefore runs in the container, which
  closes review finding 4 (parent environment readable via ps).
- Contained delegation (0004 addendum, G8): parent-controlled child
  agents, each with its own executor, budgeted by the parent under 5b.
  A complete piko process inside a sibling container is explicitly NOT
  the design; it would need a credentialless model-call broker and an
  external journal/budget service that nothing here specifies.
- The session store lives outside the mount: the model cannot rewrite
  ~/.pi/sessions. This is the precondition for every durability claim
  on the matrix.
- Fail closed: if Docker is unavailable, --allow-host-bash remains the
  explicit, warned opt-in it is today; no silent fallback.

### 5a-ii. ADR 0022 is not closed by the mount

A bind mount prevents a host escape; it does not make a swapped symlink
fail, and a race can still expose the container filesystem. 0022 requires
a spike, before any Security 4 claim, proving that read, write, and edit
fail closed at the swap barrier: most likely an executor-contained
openat2/openat helper operating inside the sandbox, or else the native
addon path. The parent-swap regression tests (read, write, edit; macOS
and Linux) are written first, must fail on the current tree, and must
pass with the chosen mechanism. The chosen mechanism is recorded as a
dated addendum to 0022.

Exit criteria for 5a: parent-swap tests green on both OSes in CI; a test
proves the sandbox cannot read a canary outside the workspace or reach
any network host; a test proves bash inside the executor cannot see the
parent's environment; a scoped threat model (assets, trust boundaries,
attacker capabilities inside and outside the sandbox) committed under
docs/; README stops saying "does not yet provide an OS sandbox".

### 5b. Atomic aggregate budget authority and a legible ceiling

Reconstructing each child's journal after the fact is insufficient when
children run concurrently. The design, recorded in its ADR before code:

- One root-budget authority per session tree, with atomic reserve and
  reconcile under a single root-budget lock; a child cannot dispatch
  until its reservation is admitted against the root.
- Branch and child-tree semantics: a branch inherits the remaining root
  budget by reference, not by copy; a child's exposure is charged to
  every ancestor up to the root.
- Unknown-request exposure: a dispatched request with no terminal
  acknowledgement keeps its full reservation on every ancestor until
  reconciled, exactly as the per-turn ledger does today.
- maxTime is defined explicitly: active time (model plus tool wall time
  attributable to this tree) versus elapsed session time are separate
  ceilings if both are wanted; parallel child time is summed for the
  active ceiling and wall-clock for the elapsed ceiling.
- Session-scoped maxSpendUSD, maxTokens, and the time ceilings enforced
  alongside the per-turn ones.
- Tokenizer-based reservation bounds are used only where proven
  conservative against the provider's actual count on a corpus;
  otherwise the byte bound stays.
- At every spend stop, print reserved versus actual and the effective
  ceiling; report the effective ceiling in --usage.

Exit criteria: a REPL test that two turns cannot exceed the session cap;
a concurrent-children test that the sum of admitted reservations never
exceeds the root; an unknown-outcome child test that exposure persists
until reconciled; the TB 2.0 cap behavior explainable from the printed
numbers alone.

### 5c. Cooperative SIGTERM drain, honest under ADR 0007

- SIGTERM stops admission of new turns, journals a drain marker, and
  grants a configured grace period for in-flight operations to reach a
  durable terminal state; a supervisor process owns the hard-kill
  deadline so a synchronously blocking extension cannot defeat it.
- Semantics are 0007's, not the earlier plan wording: after a fully
  cooperative drain, the run is journaled canceled. If the deadline
  forces termination, the run may be marked canceled, but any dispatched
  provider or tool operation without a durable terminal acknowledgement
  remains outcome_unknown. "No outcome_unknown rows" is a valid
  expectation only for the cooperative path.

Exit criteria: a test with a blocking extension fixture proves the
deadline holds and the forced path leaves the in-flight operation
outcome_unknown and the run canceled; a test of the cooperative path
proves a clean canceled run with no unknown rows; a fleet-style restart
of an idle headless run leaves no unknown rows.

Then re-issue the review prompt; commit the report.

## 6. Tranche 3: evidence and tests (conditionally approved; 1-2 weeks plus a pre-registered budget)

1. G11 property and corpus tests: SSE parsing, journal tail recovery,
   journal replay, with saved corpora under tests/corpus/.
2. A cross-process race and chaos campaign against the lock, recovery,
   and approval paths (the existing concurrent tests are the seed, not
   the campaign).
3. Container-level fault tests against the real executor: mount escape,
   network isolation, kill mid-write, resume after kill.
4. Extract the loop's invariants (budget admission, reservation, flail
   guard, compaction) into directly testable units. A smaller agent.ts is
   a likely by-product and a useful heuristic, not an exit criterion.
5. Frontier rerun, pre-registered before any trial runs, in a committed
   protocol that states: the exact task list and trial counts; the cap
   settings; the statistical unit (task-level pass rate over repetitions,
   with the repetition count that 0017's variance rule requires for any
   claim the result will be used for); staged stopping rules (stop a
   stage early if the pooled result cannot change the conclusion); an
   aggregate spend ceiling enforced by the harness's own --max-spend-usd
   per trial plus a stage-level total the runner refuses to exceed; and
   the clean-infrastructure retry of the 13 infra failures as a separate
   stage. For scale: 25 tasks x 2 caps x 3 repetitions is already 150
   trials, $75-225 at plausible per-trial cost, before retries or the
   ~$2 DeepSeek dev-set arm. The budget is whatever the protocol derives,
   approved by the owner; the earlier $20-35 figure is withdrawn.
6. Operational maturity: confirm @pi scope ownership (or choose another);
   publish packages with provenance under ratified 0019; pi doctor
   covering runtime, credentials, and provider reachability; the
   five-minute clean-machine install bar as a CI job.

Then re-issue the review prompt; commit the report.

## 7. What this plan deliberately does not do

- No MCP, no TUI, no LSP, no editor integration. The wedge piko serves is
  unattended, budgeted, auditable runs; those columns do not serve it.
- No decorative ADRs. Records ARE required for session budgets, graceful
  shutdown, the 0022 mechanism, the token-rent home, and 0021's
  retention classes; the earlier blanket "no ADRs during T2" is
  withdrawn because it would have built T2 under plan prose.
- No 0017 (self-improvement) work until T3 is done. It needs the sandbox
  as its soak chamber, the aggregate budget as its governor, the bigger
  eval suite as its referee, and directly testable invariants to canary.
- No chase for 5 on any dimension.

## 8. Tracking

Each tranche is a checklist in .claude/tasks/ when it opens, mirrored to
the task list, with the re-review report as its final item. Grades are
taken from the re-review, never from the forecast table.

## 9. Revision record

- r1 (2026-09-02): initial plan.
- r3 (2026-09-02): T0 decisions recorded by owner delegation; T2 opened.
- r2 (2026-09-02): owner's conditional approval folded in. Mandatory:
  SIGTERM semantics per 0007; 0022 not closed by a bind mount, spike
  required; 0018 verbs corrected to acquire/exec/release; control plane
  separated from the sandbox, networking none, parent-controlled
  children; atomic aggregate budget authority specified; governance
  gates repaired (0018 before T2, 0019 before publication, token-rent
  re-homed, 0021 concrete or principles-only, budget and shutdown ADRs,
  0022 addendum); T2 arithmetic corrected to 3.75 and T1 ops marked as
  forecast; T3 rebudgeted with pre-registration. Smaller: race-test
  wording; changelog exit wording; scoped threat model mandatory for
  Security 4; npm scope check; agent.ts size demoted to heuristic.
