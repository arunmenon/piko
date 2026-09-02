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

### Sessions
- Lock-capability session API: `Session.open()` returns a read-only view;
  every mutable path holds its lock; hard-linked journals rejected. BREAKING
  for `@pi/core` consumers that mutated through `open()`. (ADR 0023)
- Stale-lock recovery: `pi -c` fails loudly (exit 5) on a locked newest head;
  `pi doctor sessions` lists lock state and recovers verifiably dead local
  locks; v2 lock records carry host and start time. (ADR 0024, ADR 0010
  amendment for exit 5 and `code: locked_session_head`)

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

### Governance
- ADRs 0021 (proposed), 0022 (accepted, unimplemented), 0023, 0024
  (implemented); amendments to 0010 and 0015; token-rent rule re-homed as a
  proposed amendment to 0001.

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
