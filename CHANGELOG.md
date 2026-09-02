# Changelog

All notable changes to piko. Versions are repo-wide (all @pi/* packages move
together). Packages are not yet published and no git tag exists yet: the
version headings below are development snapshots of this repository, not
releases. ADR 0019 (release contract) gates the first real tag. Breaking
changes are called out explicitly.

## Unreleased

Every user-visible change since the 0.2.0 tree. No tag exists yet; ADR 0019
(release contract) gates the first tag.

### Cost and budgets
- Dollar-denominated cost accounting with pre-dispatch spend reservation and
  `--max-spend-usd` per-turn ceilings; pricing loader with long-context tier
  support; tiered rows no longer rejected. (ADR 0020)
- Fixed-context budget gate ratcheted against a committed baseline (815
  tokens); the tool-batching prompt line reverted under the token-rent rule.
- Spend ceilings are legible: every dollar stop reports the attempted
  reservation, spend so far, outstanding reserved exposure, and the configured
  ceiling on the `budget_exceeded` and `turn_done` events, on one printed line
  in headless and the REPL, and as `spendCeiling` in `--usage`. Output only;
  reservation math and scope unchanged. (ADR 0020 addendum)
- User-visible budget text says "turn budget", not "run budget": validation
  errors, the headless terminal line, and `--max-*` flag help. Identifiers
  unchanged. (ADR 0009 addendum)
- `check-budget` reports two numbers: the ratcheted default prefix and a
  bounded worst-case first request (prefix plus the AGENTS.md, skill index,
  and tool schema caps), plus a per-provider cache-eligibility line; skill
  entry names and paths are reported as unbounded. The ratchet and the
  1000-token ceiling still apply to the default prefix only, and the gate now
  builds first. (ADR 0001 addendum)

### Sessions
- Lock-capability session API: `Session.open()` returns a read-only view;
  every mutable path holds its lock; hard-linked journals rejected. BREAKING
  for `@pi/core` consumers that mutated through `open()`. (ADR 0023)
- Stale-lock recovery: `pi -c` fails loudly (exit 5) on a locked newest head;
  `pi doctor sessions` lists lock state and recovers verifiably dead local
  locks; v2 lock records carry host and start time. (ADR 0024, ADR 0010
  amendment for exit 5 and `code: locked_session_head`)
- Journals record a `journal_repaired` row on the first append after a
  tolerated partial tail (repair kind, byte offset, bytes discarded);
  `pi doctor sessions` reports the count per session in text and `--json`.
  An append refused for exceeding the size limit no longer repairs the
  boundary first. The repair and its row are one durable operation: the row
  and the pending rows are written positionally at the repair offset on a
  descriptor without O_APPEND and fsynced before the journal is truncated to
  the new end and fsynced again; a crash between the two fsyncs leaves the
  rest of the old fragment as another undelimited tail, which the next open
  tolerates and records as a second row, so no discarded byte goes
  unrecorded. (ADR 0015 addendum and correction; R2 finding 4)
- Bash calls record an optional dispatch-time `workspaceDigest` on their
  `tool_started` row (SHA-256 over the raw bytes of `git rev-parse HEAD` and
  `git status --porcelain=v1 -z --ignore-submodules=all`, best effort under a
  single 2 second budget for all invocations, further capped by the turn's
  remaining wall time, omitted outside a git checkout) so a resumer can tell
  whether the workspace moved under an unknown outcome; write takes an
  optional `expected_sha256` precondition, a stale-at-check-time check hashed
  through a bounded descriptor (files over the 10 MB ceiling are refused
  before reading), not a compare-and-swap: a writer landing between the check
  and the rename is still overwritten; an example-based replay conformance
  test covers the journal. Additive fields, no schema generation bump.
  (ADR 0007 addendum; R2 findings 1 and 3)
- An additive `extension_loaded` journal row (path, sha256, tool names,
  pinned, entryOnly) is written for every loaded extension. The digest covers
  the entry module's bytes as read around the import, not transitive imports;
  the loader re-reads and re-hashes after the import and refuses to start
  (exit 1) if the bytes changed, which detects a swap in that window but
  cannot prevent one. No schema generation bump. (ADR 0012 addendum; R2
  finding 2)

### Telemetry and privacy
- `policy.env_sanitized` carries a count instead of the allowlist;
  `apiKeyEnv` validated as an environment-variable name; keyless endpoints
  emit no `credential.attach`; credential-shaped matching requires delimited
  components.

### Benchmarks and evidence
- Harbor (Terminal-Bench 2.x) adapter; pricing table baked into bench
  containers; manifest-driven trial accounting; generated TB 2.0 manifest
  block; dev-set governance, seeded held-out draw, and committed review and
  replication reports.
- Retractions recorded: the flail-threshold claim; the 25/30 rerun demoted
  to narrative after its artifacts were lost.

### Containment
- The bash workspace digest no longer runs git before policy. It is taken
  only after the call clears validation, the tool-call budget, approval, and
  cancellation, and it runs with `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `core.fsmonitor`, `core.hooksPath`,
  `core.untrackedCache`, and the pager disabled, `--no-optional-locks`, and
  submodules ignored, so reading a workspace cannot execute a program the
  workspace named. Each probe is spawned detached, its whole process group is
  killed on deadline or abort, and the turn's AbortSignal ends it. BREAKING
  for readers that expected `workspaceDigest` on `tool_planned`. (R2 finding
  1; ADR 0007 addendum and correction)
- Protected-path deny list inside the workspace: write and edit refuse
  `.git/`, `.pi/`, `.agent/`, `.claude/`, `AGENTS.md`, `.mcp.json`, and the
  workspace-root shell rc files, evaluated on the resolved path after symlink
  resolution; path case is folded only where a per-workspace probe shows the
  filesystem folds it, so `.Git/notes.txt` is not refused on a case-sensitive
  volume; reads unaffected; explicit opt-out `--allow-protected-paths`,
  warned like `--allow-host-bash`. (ADR 0006 addendum; R2 finding 12)
- ADR 0022's eight containment attacks run through `read`, `write`, `edit`,
  and `map` `Tool.execute()` via a test-only barrier registry in
  `packages/core/src/tools/filesystem.ts` (empty in production, one Map
  lookup per named point) and exist as `todo` in
  `packages/core/tests/containment.test.ts`, failing on the current tree by
  design; the resolver-level tests are kept as lower-level supplements and
  the evidence map points at both. (R2 finding 6)

### Bounded execution
- Flail guard classifies every tool outcome, not only failures: calls are
  hashed as tool name plus canonical arguments; identical succeeding calls
  escalate on relaxed thresholds (nudge 4, stop 8) and an A,B,A,B alternation
  of identical pairs on cycles (6, 8); error thresholds unchanged; a success
  no longer clears the repeat counters, only a genuinely new call does.
  Thresholds are dev-set tuned and not yet checked on the held-out draw.
  (ADR 0005 addendum)
- `--parent-run <id>` sets `parentRunId`, reaching telemetry and every
  headless `--json` row; `--max-depth <n>` (default 2) with `PI_DEPTH`
  exported to bash children refuses a piko started past the cap with exit 1
  before any model call. Concurrency and tree-wide spend caps arrive with
  ADR 0026. (ADR 0004 addendum)
- `--ext <path>@sha256:<hex>` pins an extension to a content hash verified
  before import; a mismatch refuses to start with exit 1 naming both digests.
  (ADR 0012 addendum)

### Context economics
- The compaction summarizer reuses the live system prompt and tool list with
  the instruction as the final user message, and by default matches the live
  request's thinking budget (`compaction.matchLiveCacheKey`, recorded as
  `summaryCacheKeyMode` on the compaction spans), so every provider cache-key
  field matches and the summary can share the cached prefix; with the option
  off the summary is small and re-pays the prefix. An actual cache-read
  measurement on the dev set is still outstanding. Tool use is disabled
  through a new `toolChoice: 'none'` request field mapped for both providers.
  Compaction appends a rehydration block (AGENTS.md on a trusted run, the
  last 5 written or edited paths as JSON strings inside a fenced block
  labelled as untrusted data). Explicit compactions-per-turn cap (default 3)
  ends the turn `incomplete` before another summary is billed. (ADR 0003
  addendum; R2 findings 7 and 8)
- Startup prints one stderr line stating the fixed prefix size against the
  provider's published minimum cacheable size, from a dated per-model table
  with its source URL; a model with no published row reports the minimum as
  unknown and draws no conclusion. `/model` warns that a mid-session switch
  changes the cache key; `profiles.<name>.cacheTtl` selects the Anthropic
  cache lifetime (5m or 1h); bench/compare_runs.py gains a cache hit-rate
  column. (ADR 0014 addendum; R2 finding 9)

### Headless and JSON
- Headless `--json` emits a dedicated first row carrying a `capabilities`
  object (journal schema generation, tool names, the exit-code set, the
  budget scope `turn`) after setup and before the first agent event; every
  `run_error` row, including provider failure before the first event, an
  undecided suspended session, a locked head, and a `--max-depth` refusal,
  carries a static partial form (`partial: true`, tool names omitted).
  `doctor sessions --json` carries none. (ADR 0010 addendum and correction;
  R2 finding 5)
- The eval fallback detector accepts both `turn <status>:` and
  `run <status>:` and is tested against the CLI's own producer string;
  truncated runs were briefly scored as passes after the wording change.
  (R2 finding 10)
- Spend-stop lines use adaptive precision: at least six decimals, more when a
  nonzero amount would otherwise show fewer than two significant digits, and
  never scientific notation. (R2 finding 11)

### Governance
- ADRs 0021 (proposed), 0022 (accepted, unimplemented), 0023, 0024
  (implemented); amendments to 0010 and 0015; token-rent rule re-homed as a
  proposed amendment to 0001.
- Red-team review (2026-09-02) committed with a remediation plan; dated
  Research addenda on all 27 ADRs with a bibliography in docs/adr/README.md;
  exit code 143 reserved in 0010; 0019 corrected to journal generation 2;
  0023 and 0024 addenda on capability framing, expiry, network filesystems,
  and PID reuse; proposed amendment drafts on 0018, 0025, and 0027 awaiting
  owner decisions.

## 0.2.0 — 2026-08-19

The hardening and trust release: from late prototype to early alpha.

### Security and containment (BREAKING defaults)
- Workspace-confined file tools: parent traversal, absolute paths (without
  opt-in), symlink escapes, and special files rejected; TOCTOU re-resolution
  (historical correction 2026-09-02: the re-resolution is path-based and a
  parent-symlink swap race was later reproduced; see ADR 0022, unimplemented);
  atomic writes. (ADR 0006)
- Host bash is deny-by-default behind `--allow-host-bash`, with a sanitized
  allowlist environment; credentials are never inherited by tools. (ADR 0016)
- Project content is untrusted by default: AGENTS.md, skill index, and prompt
  templates load only with `--trust-project`, byte-bounded.
- Tool extensions are validated at load (shape, duplicate names, byte
  ceilings; compiled JS only) and documented as trusted controller code.
  (ADR 0012)

### Durability
- Write-ahead lifecycle journal: tool/model/compaction lifecycle rows with
  `outcome_unknown` crash semantics — a crash mid-side-effect is reported as
  unknown, never as "didn't run." (ADR 0007)
- Durable single-writer sessions: UUID ids, exclusive 0600 creation, file and
  directory fsync, owner-token locks, fail-closed corruption handling with
  partial-tail tolerance, lineage across branches/compactions. (ADR 0015)
- Journal schema marker introduced; 0.1-era session files still parse.

### Persistent approvals (new)
- `--require-approval <tools|*>` gates tools behind human sign-off; gated
  calls suspend the turn durably (exit code 4) and survive crashes, reboots,
  and days of latency. Decisions via inline REPL prompt or resume flags:
  `--approve <id|all>`, `--reject <id> --reason`, `--edit <id> --args`.
  Edited arguments are validated and provenance-marked. Policy is settable
  only from user config/CLI — never by project content or extensions.
  (ADR 0011)

### Bounded execution
- Hard budgets: model requests, tool calls (`--max-tool-calls`), wall time
  (`--max-time`), input/output/total tokens, per-tool output bytes, stdin
  size. Typed stop reasons; `budget_exceeded` maps to exit code 2. (ADR 0009)
- Flail guard: doom-loop detection nudges then ends failing turns (measured:
  equal accuracy at 59% less spend). (ADR 0005)

### Providers
- Strict stream termination: success requires the provider's terminal signal;
  typed `ProviderProtocolError` (never retried) vs `ProviderTransportError`
  (retried); request deadlines wrap all retries; response size caps;
  duplicate-call rejection; `max_tokens` truncation is not success. (ADR 0008)
- gpt-5/o-series parameter handling, extended-thinking signature replay,
  Retry-After honored, DeepSeek cache fields normalized.

### Context economics
- Auto-compaction with next-request preflight estimation into new
  lineage-linked session files; microcompaction offloads bulky old tool
  results to disk stubs; repo `map` tool for orientation. (ADRs 0003, 0014)
- Fixed context ~747/1000 estimated tokens, CI-gated. (ADR 0001)

### Interfaces and evidence
- Fail-closed CLI: semantic exit codes (0/2/3/4/130; failure is the default),
  versioned `--json` JSONL event stream, `--audit` per-request economics with
  cache hit rates, linked-session audit. (ADR 0010)
- Redacted structured telemetry (`TELEMETRY_SCHEMA_VERSION = 1`). (ADR 0013)
- Reproducible evaluation: fail-closed pass criteria, run manifests,
  benchmark trial aggregation and provider-routing fixes; Linux/macOS CI.
- Sixteen architecture decision records under docs/adr/; praxis-derived
  review/release skills under .agent/.

## 0.1.0 — 2026-08-12 (baseline, never tagged)

Initial clean-room build: five tools (map/read/write/edit/bash), streaming
Anthropic + OpenAI-compatible providers with prompt caching, JSONL sessions
with resume/branch, headless `-p` mode, REPL, prompt templates, skills,
extensions, 10-task eval suite, Terminal-Bench adapter, sub-1000-token fixed
context with CI budget gate.
