# Red-team remediation plan (September 2026)

Status: draft r1, 2026-09-02, awaiting owner approval. Companion to
docs/maturity-plan-2026-09.md, which remains the governing plan; nothing
here reopens the owner's conditional approval of T2 or its amendments.
Source: docs/reviews/2026-09-02-red-team-review.md (reviewed tree
cacdd8d, 27 records, ten cross-cutting attacks, one "Move" per ADR, and a
research lineage for every record).

## 1. What the review says, in plain terms

The reviewer's verdict is one sentence: the record is the best in the
field and the runtime is fourth or fifth, and every attack reduces to
"ship the boundary, then let the governance stand on it." Three things
follow from that for this plan.

- The score moved in T1 because documents moved, not because the harness
  got safer. The first runtime tranche a re-review can falsify by test is
  worth more than any further record work. This plan therefore pulls
  forward every runtime fix that does not depend on the owner's pending
  decisions (section 6), so that a re-review has something to test before
  T2 lands.
- Several attacks are cheaper to close than the big items they sit next
  to. A model inside the contained default can today write
  `.git/hooks/pre-commit` or `AGENTS.md` and have its code run on the
  user's next commit or next trusted run. That is a persistence vector
  no record mentions and it costs about a day to close. The loop guard
  misses the common coding loop (reading the same file eleven times
  successfully). The spend ceiling stops work without printing the three
  numbers that would explain the stop. These go first.
- Some Moves contradict the owner's amended T2 design (Docker first,
  file tools in-process, a piko-owned supervisor). Those are decisions,
  not tasks, and section 4 presents them as such. Nothing in T2 changes
  until the owner decides.

## 2. Verification of the review against the tree

Every factual claim the review makes about piko was checked against the
tree before this plan was written (two read-only verification passes over
packages/ and docs/adr). The reviewer is right almost everywhere. The
corrections and additions:

| Claim | Verdict | What the tree actually shows |
|---|---|---|
| No cache hit-rate number anywhere (0014) | Partly wrong | `pi --audit` prints a per-request `hit%` column and `/tokens` and `--usage` carry the hit rate (packages/cli/src/render.ts). What is missing: a cache-eligibility check, TTL selection, a model-switch cache-key warning, and a hit-rate column in bench/compare_runs.py |
| 0024 omits the PID-reuse reasoning | Partly wrong | The token re-read is documented in 0024, but justified by unlink not being an atomic compare-and-delete; PID reuse appears only as a code comment (session.ts) and NFS is absent |
| No compaction thrash guard (0003) | Partly right | No counter exists; repeated compaction is bounded by termination (a compaction that creates no headroom ends the turn) and by the request budget. The summarizer is a separate call with its own system prompt and no tools, so it cannot hit the main cached prefix |
| No `--parent-run`, no child bounds (0004) | Right, with a nuance | `parentRunId` exists as an embedder option and telemetry field but the CLI never sets it; process-group kill exists within a single bash tool call, so the residual gap is daemonized children and depth or concurrency |
| Loop guard watches errors only (0005) | Right | Both counters are gated on `result.isError`; any success clears them (agent.ts) |
| No protected-path deny list (0006) | Right | `resolveWorkspacePath` checks NUL, `..`, absolute paths, and containment only; write and edit accept `.git/hooks/*`, `.git/config`, `AGENTS.md`, `.agent/*` |
| Approvals are name-only, no session grants (0011) | Right | The whole gate is `approval.includes(toolName)` (tools/types.ts) |
| No extension hash or pin (0012) | Right | Bare dynamic import after shape and size checks (cli/src/extensions.ts) |
| No OTLP exporter (0013) | Right | Local append-only JSONL sink only |
| Tail repair is silent (0015) | Right | stderr warning plus deferred `ftruncateSync`; no journal row |
| Two adapters, no Responses API (0008) | Right | Anthropic Messages and OpenAI Chat Completions; the provider union is closed at two values |
| 0019 says schema v1, code writes generation 2 | Right | `JOURNAL_SCHEMA_VERSION = 2` (journal.ts) versus "the current shape is v1" (0019) |
| Only 0001 cites a paper | Right | One arXiv reference across all 27 records |
| Ceiling stop prints no figures (0020) | Right | `SpendBudgetExceededError` carries reservation and remaining dollars but is collapsed to the word `spend` before any output |
| 143 absent from 0010; SIGTERM exits 130 | Right, and worse | SIGTERM and SIGINT are indistinguishable in the exit code; the REPL registers no SIGTERM handler at all; the 0010 amendment restates the code set as 0/1/4/5 and silently drops 2, 3, and 130 |
| Hand table in tokens.ts; loader reads prices only (0025) | Right | Eight regex entries for context windows; the LiteLLM loader discards `max_input_tokens` and every `supports_*` flag |
| Sessions reachable by the model (0023) | Right | Journals live in `~/.pi/sessions/<slug>-<hash>/`, outside the workspace but readable and writable by host bash |

## 3. How this reconciles with the maturity plan

The maturity plan's tranches and gates stand. The review's 27 Moves and
ten attacks are sorted by what gates them, not by where the reviewer put
them:

- R0 (section 4): Moves that would change the owner-approved T2 text, or
  that conflict with a stated non-goal. Decisions for the owner, with a
  recommendation each.
- R1 (section 5): record fixes and research addenda. No gate. Same shape
  as T1.
- R2 (section 6): runtime fixes that depend on no owner decision and do
  not touch the T2 design. Each is at most five files, ships with its test
  and a dated addendum to its ADR, and is the first tranche a re-review
  can falsify.
- T2 and T3 additions (sections 7 and 8): Moves folded into the existing
  gated tranches, worded so they extend rather than replace the approved
  text.

Attack 01 (the score moved because documents moved) is answered by
running R2 before T2 and re-issuing the review prompt against it.

## 4. R0: decisions added to Tranche 0 (owner)

| # | Decision | Review's position | Approved text today | Recommendation | Gates |
|---|---|---|---|---|---|
| R0-1 | First sandbox provider | bwrap plus seccomp on Linux and Seatbelt on macOS (or `@anthropic-ai/sandbox-runtime` as a dependency) first; Docker as the CI provider | Plan 5a and 0018: one Docker provider | Lightweight provider first on dev hosts, Docker second for CI; record as a dated amendment to 0018 before ratification. Note the cost: a native or third-party sandbox dependency ends the zero-dependency property for that provider | 5a |
| R0-2 | Where file tools run | Whole-process mode: read, write, edit execute inside the executor, otherwise 0022 needs a native helper regardless | 5a: only tool execution inside; control plane outside | Keep the control plane outside; run all five tools' effects inside, including the file tools; amend 0018 accordingly | 5a, 5a-ii |
| R0-3 | 0022 mechanism | Decide now; a ~200-line N-API addon exposing openat, renameat, mkdirat, unlinkat with O_NOFOLLOW costs zero-native-deps and nothing else | T0: dated addendum pending since 25 Aug | Write the eight acceptance tests first (R2-13) so they fail on the current tree, then decide between addon and executor-contained helper with the tests as the referee; target 9 Sep | 5a-ii |
| R0-4 | Shape of 0027 | Cooperative path in-process (stop admission, grace, journaled drain marker, exit 143) so any external supervisor works; ship piko's own supervisor only for the blocking-extension case | 0027 as drafted: one supervisor process per headless run owns the hard kill | Amend 0027 before ratification: in-process cooperative path is the primary contract; the supervisor is optional and named as the blocking-extension fallback | 5c |
| R0-5 | MCP bounded proxy as an extension (0002) | Build it; 0002 is honoured in its restrictive half only | Plan section 7: no MCP | Keep the non-goal through T3; revisit with evidence from a real user need. The consequences line in 0002 is rewritten either way (R1-7) | none |
| R0-6 | ACP adapter (0010, G12) | Ship one as an external process over the existing JSONL | Plan section 7: no editor integration | Defer to a post-T3 G12 spike; add the `capabilities` array now (R2-11) so an adapter has something to read | none |
| R0-7 | Research addenda format | A dated "Research" addendum on every record plus a bibliography in docs/adr/README.md | README allows dated addenda without editing the record | Approve the format; no status changes involved | R1-1 |
| R0-8 | Who may delete (0021) | Say who may delete | 0021 names the obligation but not the role | Name "the owner, or an operator the owner delegates, with the deletion journaled" and ratify 0021 with 30-day telemetry and indefinite journals | R2, T3 |
| R0-9 | Capability source (0025) | Source from the LiteLLM row already on disk, override per profile, keep the conformance suite, admit Responses first | 0025: adapter authoritative for windows | Amend 0025 before ratification: registry row is the default, profile overrides, adapter never trusts the model's self-report | T3 |
| R0-10 | 0017 sequencing | Variance study first; if the suite's noise exceeds 10 points, 0017 cannot promote anything and should say so | Plan: no 0017 work until T3 is done | Adopt the variance study as stage 0 of the T3 pre-registered rerun (section 8) | T3 |

## 5. R1: record fixes and research addenda (no gate; about 2 working days)

1. Research addenda. A dated "Research (2026-09-02)" addendum on each of
   the 27 records carrying the citations from the review's Research rows,
   each marked corroborating or challenging, with a bibliography section
   in docs/adr/README.md. Exit: every citation resolves to an arXiv id or
   a publisher record; challenging citations (leases versus withholding in
   0024, crash-only versus graceful in 0027, compaction erasing
   constraints in 0003, name-only gating in 0011) are stated as such.
2. 0010: 143 added as the exit code for termination by signal, forced or
   cooperative, delivered by T2 5c; the amendment's code list restored to
   0, 1, 2, 3, 4, 5, 130, 143; the `capabilities` array in the first JSON
   row documented (delivered by R2-11).
3. 0019: the journal schema marker corrected to generation 2 with the
   generation history (1: v0.2 lifecycle rows; 2: approvals, suspension,
   pricing fields). 0019 is proposed, so this is an edit, not an addendum.
4. 0024 dated addendum: locks are undefined on network filesystems and
   piko refuses nothing there yet, so document the caveat as OpenHands
   does; the PID-reuse reasoning (a dead PID plus a matching start time
   and token is the discriminator; liveness alone is racy); the
   supervisor-mode recovery contract is deferred to 0027.
5. 0023 dated addendum: the module-private token is an object capability
   in the strict sense; no-expiry is a deliberate Chubby-style choice over
   leases; the supervisor's journal write path is defined in 0027.
6. 0005 and 0006 dated addenda drafted for R2-1 and R2-3 (the text
   commits with the code).
7. 0002: the consequences line says what the contained default can reach
   through tools: files inside the workspace only, no network, no shell.
8. 0021: the deletion role named per R0-8.
9. Amendment drafts for the owner's R0 decisions: 0018 (provider order,
   whole-process file tools, fail-closed hard-coded, egress proxy as the
   credential injection point), 0027 (in-process cooperative path
   primary), 0025 (registry-sourced capabilities).
10. The review itself committed as provenance (this commit).

## 6. R2: runtime fixes not gated on Tranche 0 (about 8 working days)

Each item: at most five files, its own test, a dated addendum to its ADR
in the same commit, no change to the T2 design. Ordered by value per day.

1. 0006 protected-path deny list. Write, edit, and every path-producing
   tool refuse paths that resolve (after symlink resolution) into
   `.git/`, `.pi/`, `.agent/`, `.claude/`, `AGENTS.md`, `.mcp.json`, and
   shell rc files (`.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`,
   `.profile`). Git changes go through bash, never through the file tools,
   so refusing all of `.git/` costs nothing. Explicit opt-out flag only.
   Tests: each path refused directly and via a symlink alias; a nested
   workspace root. About one day.
2. 0020 legible ceiling. The spend-stop event carries reservation,
   remaining, and configured ceiling; headless and REPL print
   "reserved $x, spent $y, ceiling $z, effective $z minus reserved" at
   every spend stop; `--usage` reports the configured ceiling. This pulls
   5b's last bullet forward without touching 5b's design. Test: the
   printed numbers explain a TB 2.0 style ceiling stop without reading
   the journal. About half a day.
3. 0005 loop classifier. Hash tool plus arguments for every outcome, not
   only errors; identical successful calls counted with relaxed
   thresholds; an alternating-pair detector (A, B, A, B over six cycles);
   error thresholds unchanged. Tests in guard.test.ts. Thresholds are
   tuned on the dev set only and checked on the held-out draw before
   merge, per the dev-set firewall. About one day.
4. 0004 child bounds. A `--parent-run <id>` flag that sets the existing
   `parentRunId` and is echoed in every JSONL row; `PI_DEPTH` propagated
   to bash children with a `--max-depth` cap (default 2) refused with
   exit 1; documentation that concurrency and tree spend caps arrive with
   0026. About half a day.
5. 0012 extension pins. `--ext <path>@sha256:<hex>` verified before
   import; an `extension_loaded` journal row (path, digest, tool names)
   written whether or not a pin was given; a pin mismatch refuses to
   start. Additive row type, no generation bump. About half a day.
6. 0015 repair row. A `journal_repaired` row (bytes discarded, offset)
   written on the first append after a tolerated partial tail;
   `pi doctor sessions` lists repaired sessions. About half a day.
7. 0009 wording. User-visible "run budget" becomes "turn budget" in flag
   help and error messages; `--max-*` help says "per turn (one turn per
   input in -p)". Identifiers unchanged. About a quarter day.
8. 0001 two-number gate. check-budget prints the ratcheted default prefix
   and a bounded worst-case first request (prefix plus the AGENTS.md cap,
   the skill index cap, and the extension schema ceiling), with a
   per-provider minimum-cacheable-size line; the ratchet stays on the
   first number. About half a day.
9. 0014 measurement. A startup cache-eligibility line (prefix size versus
   the provider's minimum cacheable size); a warning on model switch that
   the cache key changes; a hit-rate column in bench/compare_runs.py; TTL
   selection as a profile option where the provider exposes it. About one
   day.
10. 0003 compaction. The summarizer request reuses the main system prompt
    and tool set with the instruction as the final user message so it can
    hit the cached prefix (measure cache-read tokens before and after on
    the dev set); a rehydration list after compaction (AGENTS.md when
    trusted, the last N touched file paths as stubs); an explicit
    compactions-per-turn counter with a stated cap. About one and a half
    days.
11. 0010 capabilities array in the first JSON row: schema generation, tool
    names, exit codes, budget scope. About a quarter day.
12. 0007 idempotency. An optional expected-content-hash precondition on
    write (edit already has one); bash records a planning-time workspace
    tree hash so a resumer can tell whether the workspace moved under an
    unknown outcome; an example-based replay conformance test now,
    property-based in T3 G11. About one day.
13. 0022 acceptance tests written first, failing on the current tree
    (read, write, edit at the swap barrier; map traversal; mkdir; temp
    placement; rename; cleanup), so R0-3 is decided against evidence.
    About one day.

Then re-issue docs/reviews/codex-review-prompt.md against the R2 tree and
commit the report. Forecast only: R2 touches security (a persistence
vector closed), failure honesty (the ceiling explained), correctness (the
loop guard sees successes), and docs (research addenda); a move from 2.7
toward 2.9 is plausible, and the re-review decides.

## 7. Moves folded into Tranche 2 (gated as before)

- 0018: provider order and file-tool placement per R0-1 and R0-2;
  fail-closed hard-coded rather than a flag; the egress proxy designed as
  the credential injection point from the start even though v1 networking
  is none (0016 Move); a fresh PID namespace for host bash on Linux where
  bwrap is present, as part of the lightweight provider (0016 Move).
- 0022: mechanism per R0-3 with the R2-13 tests as the referee. The
  sessions directory is already outside the workspace but reachable with
  host bash; the executor's mount rule is what makes 0023's lock honest
  against the model (0023 Move).
- 0026: as drafted, plus: measure root-lock throughput at twenty
  concurrent children before contained spawn depends on it; budget
  reminders to the model as harness messages at a configurable interval,
  never in the fixed prefix; the tokenizer-corpus work scheduled as a T3
  item so the "only where proven conservative" rule has a path to being
  exercised.
- 0027: per R0-4; the supervisor's journal write path for host events
  defined so 0023's single-writer rule is not violated (0023 and 0024
  Moves).
- 0011: argument-prefix rules evaluated at dispatch on the shell-split
  command, with inline match and not-match tests in the rule file, plus a
  session-scoped "allow this prefix" grant that is itself a journal row.
  Placed in T2 rather than R2 because it changes the approval contract
  that T3's chaos campaign tests and touches the bash execution path 0018
  moves; a dated addendum to 0011 precedes the code. About three days
  inside T2.

## 8. Moves folded into Tranche 3 and after

- 0017 variance study as stage 0 of the pre-registered frontier rerun:
  the nine held-out tasks at n=5 (45 trials; roughly $25 at the recorded
  mean of about $0.56 per trial, capped per trial by the configured
  ceiling). Publish the smallest detectable effect; if it exceeds 10
  points, 0017 records that it cannot promote anything on this suite.
  (r1 said seven tasks and 35 trials; the held-out draw has nine tasks.)
- 0020: the manifest generator gains an unpriced-reason column so every
  trial is priced or explained.
- 0021 (gated on ratification): `pi doctor sessions --prune`, a telemetry
  TTL sweep, and a trajectory sanitizer that emits ATIF, which is now a
  Terminal-Bench leaderboard prerequisite.
- 0025 (gated on ratification per R0-9) and 0008: registry-sourced
  capabilities with the conformance suite, and a Responses API adapter
  under the same terminal contract.
- 0013: an OTLP exporter behind the existing sink contract (OTLP over
  HTTP JSON via fetch, no dependency), with the approval-resume span link.
- 0019: license, `npm publish --provenance` from the existing CI, and the
  five-minute install job (already T3 item 6).
- 0010 and G12: ACP adapter spike as an external process, only if R0-6 is
  accepted. 0002: MCP proxy extension, only if R0-5 is accepted.

## 9. Cross-cutting attacks: where each is answered

| Attack | Answered by |
|---|---|
| 01 Score moved because documents moved | R2 ships runtime changes before T2 and is re-reviewed on its own |
| 02 Control plane without an execution plane | T2 5a with R0-1 and R0-2; R2-13 tests first |
| 03 The default nobody runs | T2 5a: a contained default that can run `npm test`; until then the host-bash warning stands |
| 04 Reservation trade-off unlabelled | R2-2 prints reserved, spent, ceiling, effective at every stop; README states the byte-bound conservatism factor |
| 05 Per-turn scope | 0026 in T2 5b; R2-7 wording until then |
| 06 Containment protects the wrong boundary | R2-1 protected-path deny list; 0022 after |
| 07 Approvals durable but mute | 0011 argument rules and session grants in T2 |
| 08 Loop guard watches the wrong signal | R2-3 classifier |
| 09 Stdout is not an integration surface | R2-11 capabilities array now; ACP spike per R0-6 |
| 10 Lean thesis validated by the incumbent | Positioning: "small prefix a stranger can install and a fleet can bound" depends on 0019 (T3) and 0026 (T2); the CTO overview is updated after T2, not before |

## 10. What this plan does not do

- It does not change T2's owner-amended design. Every conflicting Move is
  an R0 decision with a recommendation, and no T2 code starts under
  different wording.
- It does not adopt the reviewer's "this week" phrasing as commitments.
  Estimates are working days for one engineer and exclude review turns.
- It does not build 0017, MCP, or ACP.
- It does not chase 5 on any dimension.

## 11. Tracking

R1 and R2 open as checklists in .claude/tasks/ on owner approval,
mirrored to the task list, with the re-review report as R2's final item.
R0 decisions are recorded in the ADRs they amend, dated, by the owner.

## 12. Revision record

- r1 (2026-09-02): initial plan from the red-team review, every factual
  claim verified against tree cacdd8d before sorting.
