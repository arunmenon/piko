# Maturity plan: 2.6 to 4.0 (September 2026)

Status: proposed plan, owner approval pending. Sequenced from the 2 Sep
standing assessment and the 25 Aug adversarial scorecard. Tracks against
docs/IMPLEMENTATION-PLAN.md (gap register) without replacing it.

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
  "outcome unknown" instead of "canceled cleanly". The spend ceiling
  stops work at roughly half its nominal value without telling the
  operator why.
- Financial correctness 3/5 (10%). No session, child-tree, or fleet
  aggregate; the reservation bound is byte-derived and conservative by
  about 4x; 18 of 89 official benchmark trials went unpriced.
- Test quality 3/5 (10%). 250 tests, almost all in-process. No property or
  corpus tests for the parsers and journal replay; no race tests; the
  2,800-line agent loop is exercised only indirectly.
- Docs and ADR integrity 2/5 (10%). The record contradicts itself: the
  plan references an ADR 0022 that is a different decision from the one
  that exists; amended ADRs carry no back-pointers; CI enforces a
  token-rent rule whose amendment is not ratified; the changelog is
  frozen at a version never tagged.
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
the report next to the 25 Aug one. If the number moves without that, it
moved on paper.

## 2. The scorecard and the arithmetic

Weights: correctness 20, security 20, failure honesty 15, financial 10,
tests 10, docs 10, ops 10, benchmarks 5. Current grades 3/2/3/3/3/2/2/2
give 2.55, reported as 2.6.

| Dimension (weight) | Now | After T1 | After T2 | After T3 | What moves it |
|---|---|---|---|---|---|
| Security & containment (20) | 2 | 2 | 4 | 4 | 0018 executor; 0022 routed through it; bash via executor closes the env leak |
| Correctness & concurrency (20) | 3 | 3 | 4 | 4 | session-scoped budgets; race and replay tests; concurrency campaign on lock paths |
| Failure honesty (15) | 3 | 3 | 4 | 4 | bounded SIGTERM drain with supervisor; reserved-vs-actual visible at every stop |
| Financial correctness (10) | 3 | 3 | 4 | 4 | aggregate budgets; tokenizer-tightened bound; price or explain the 18 unpriced trials |
| Test quality (10) | 3 | 3 | 3 | 4 | G11 property/corpus suites; container fault tests; split agent.ts |
| Docs & ADR integrity (10) | 2 | 3-4 | 4 | 4 | record fixes; evidence maps; changelog; ratify or withdraw |
| Operational maturity (10) | 2 | 3 | 3 | 4 | license; changelog; then published packages, doctor, install bar |
| Benchmark methodology (5) | 2 | 3 | 3 | 4 | regenerate manifest from results.json; frontier rerun n>=3; DeepSeek arm |
| Weighted score | 2.55 | ~2.8-2.9 | ~3.65 | ~4.0 | |

Saturation warning: 4 is reachable with one Docker provider and a closed
escape. 5 on security means a threat model, an external audit, and a
microVM path. That is a different project and is out of scope here.

## 3. Tranche 0: owner decisions (days, not engineering)

Everything downstream is gated on four decisions only the owner can make.

| Decision | Why it gates | Exit |
|---|---|---|
| License | Nothing public moves without it; ADR 0019 lists it first | LICENSE file committed, package.json license fields set |
| Ratify or withdraw the ADR 0017 token-rent amendment | CI already enforces it; the governance chain under the gate is broken until the status line says accepted | Status line updated by the owner; if withdrawn, the ratchet note stops citing it |
| Ratify ADR 0021 (artifact lifecycle) | Its rule has already been applied retroactively | Status line updated |
| Choose the 0022 path: through 0018, or native addon | Decides whether piko keeps its zero-native-deps property | One line added to 0022 recording the choice |

Recommended: license first (blocks the most), then route 0022 through
0018 (keeps zero native deps, and one seam closes isolation, the escape,
contained spawn, and the model-can-rewrite-its-journal problem).

## 4. Tranche 1: fix the record and the evidence (about 4 days)

Cheap, mostly non-engineering, and it is where the score is being lost
for reasons that have nothing to do with the runtime. Each item is
verified against the tree before it is fixed; the assessment's citations
are inputs, not conclusions.

1. Provider-capability ADR: the plan's G14 and Phase 3 cite "ADR 0022,
   the provider-capability contract". The 0022 that exists is containment.
   Draft the provider-capability decision as 0025 (proposed) and repoint
   the plan. Exit: no dangling ADR references (grep).
2. Amended-by pointers: 0006 gets "Amended-by: 0022"; 0015 gets
   "Amended-by: 0023, 0024" and a one-line note that its amendment's
   caveats are retired. Exit: README header rule satisfied for every
   amended record.
3. Evidence maps for 0022, 0023, 0024 under docs/adr/evidence/, mapping
   each acceptance clause to a named test (0023 and 0024 tests exist;
   0022's map lists the tests that must exist and marks them pending).
   Exit: "reproductions are permanent tests" is checkable in five minutes.
4. CHANGELOG brought to the tree: 0020 through 0024, exit code 5, pi
   doctor, spend ceilings, the token-rent revert, the two retractions.
   Exit: changelog head matches git log head.
5. Budget semantics documented as per-turn wherever ADRs and README say
   "run", until T2 changes the runtime. Exit: no doc claims a session-wide
   cap that the code does not enforce.
6. TB 2.0 manifest regenerated from results.json by a script (bench/), so
   infra failures, ceiling stops, and unpriced trials have one source and
   one count. Exit: every number in the manifest is produced by the
   script; the drift (13 vs 14, 24 vs 25 vs 28) is gone.
7. Matrix record cleanup: the study record's opening no longer grades
   DeepSeek "C, unverified" above the sections that upgrade it. ROADMAP
   gains the 0018/0022 line.

Expected: docs 2 to 3-4, ops 2 to 3 (license plus changelog), benchmarks
2 to 3. Score about 2.8-2.9. Then re-issue the review prompt and commit
the report.

## 5. Tranche 2: the engineering that changes the grade (2-3 weeks)

Three items that together touch 65% of the weighting, and are the same
three the standing assessment put at the top.

### 5a. ADR 0018: Docker sandbox executor, with 0022 routed through it

- SandboxProvider seam (acquire, exec, snapshot verbs) with one Docker
  provider. Workspace mounted read-write at a fixed path; nothing else
  from the host; egress default-deny with an allowlist for the model
  provider only.
- All five tools run inside the executor. Bash therefore runs in the
  container, not on the host: this closes review finding 4 (parent
  environment readable via ps) without a separate fix.
- 0022 closes through the executor: mutations happen against the
  container's mounted view, so the host-side parent-symlink race has no
  host target. The parent-swap regression tests (read, write, edit,
  macOS and Linux) are written first and must fail before and pass after.
- Contained spawn (0004 addendum): a child piko runs in a sibling
  container with its own budget row, closing G8.
- The session store lives outside the mount: the model can no longer
  rewrite ~/.pi/sessions. This is the precondition for every durability
  claim on the matrix.
- Fail closed: if Docker is unavailable, --allow-host-bash remains the
  explicit, documented, warned opt-in it is today; no silent fallback.

Exit criteria: parent-swap tests green on both OSes in CI; a test proves
the child cannot read a canary file outside the workspace or reach a
denied host; a test proves bash inside the executor cannot see the
parent's environment; the README stops saying "does not yet provide an
OS sandbox". Security 2 to 4.

### 5b. Session-scoped budgets and a legible ceiling

- A session ledger ceiling (maxSpendUSD, maxTokens, maxTime at session
  scope) enforced alongside the per-turn one, using the actual+reserved
  summary the journal already reconstructs. A child-tree aggregate for
  contained spawn.
- At every spend stop, print reserved versus actual and the effective
  ceiling; report the effective ceiling in --usage.
- Tighten the reservation bound where a tokenizer count is available;
  keep the byte bound as the fallback.
- ADRs and README updated from "run" to the two scopes.

Exit criteria: a REPL test that two turns cannot exceed the session cap;
a child-tree test; the TB 2.0 cap behavior explainable from the printed
numbers alone. Correctness 3 to 4 (with 5c), financial 3 to 4.

### 5c. Bounded SIGTERM drain (plan G4)

- SIGTERM stops admission of new turns, journals a drain marker, grants a
  configured grace period, then aborts; a supervisor process owns the
  hard-kill deadline so a synchronously blocking extension cannot defeat
  it. Outcome is journaled as canceled, never guessed.

Exit criteria: a test with a blocking extension fixture proves the
deadline holds and the journal says canceled; a fleet-style restart of a
headless run leaves no outcome_unknown rows. Failure honesty 3 to 4.

Expected after T2: about 3.65. Re-issue the review prompt; commit.

## 6. Tranche 3: evidence and tests (1-2 weeks, plus $20-35 of credit)

This is what turns "we fixed it" into "the reviewer can confirm it".

1. G11 property and corpus tests: SSE parsing, journal tail recovery,
   journal replay, with saved corpora under tests/corpus/. Exit: suites
   present and green; the pre-publication gate in the plan is met.
2. Container-level fault tests against the real executor: mount escape,
   egress, kill mid-write, resume after kill.
3. Split agent.ts so the loop's guarantees have direct tests: budget
   enforcement, reservation, flail guard, and compaction as separable
   units. Exit: agent.ts under about 1,200 lines with no behavior change
   (existing 250 tests green throughout).
4. Frontier rerun: the cap-stopped TB 2.0 tasks at $3 and $5 with n>=3;
   a clean-infrastructure retry of the 13 infra failures; the ~$2 DeepSeek
   arm on the dev set. Publish raw trajectories with the ledgers.
   Exit: a capability curve with confidence intervals replaces the single
   floor; 0017's variance rule can be met for at least one claim.
5. Operational maturity: publish packages with provenance; pi doctor
   covering runtime, credentials, and provider reachability; the
   five-minute clean-machine install bar as a CI job (0019).

Expected after T3: about 4.0. Re-issue the review prompt; commit.

## 7. What this plan deliberately does not do

- No MCP, no TUI, no LSP, no editor integration. The wedge piko serves is
  unattended, budgeted, auditable runs; those columns do not serve it.
- No new ADRs during T2 except the two record fixes in T1 and the choice
  line in 0022. The standing assessment's reading is accepted: docs
  velocity is outrunning code velocity, and the findings are known.
- No 0017 (self-improvement) work until T3 is done. It needs the sandbox
  as its soak chamber, the session ledger as its budget, the bigger eval
  suite as its referee, and a loop small enough to canary.
- No chase for 5 on any dimension.

## 8. Tracking

Each tranche is a checklist in .claude/tasks/ when it opens, mirrored to
the task list, with the re-review report as its final item. Score
estimates are recomputed from the actual re-review, not from this table.
