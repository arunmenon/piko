# Changelog

All notable changes to piko. Versions are repo-wide (all @pi/* packages move
together). Packages are not yet published; versions mark tagged states of this
repository. Breaking changes are called out explicitly.

## 0.2.0 — 2026-08-19

The hardening and trust release: from late prototype to early alpha.

### Security and containment (BREAKING defaults)
- Workspace-confined file tools: parent traversal, absolute paths (without
  opt-in), symlink escapes, and special files rejected; TOCTOU re-resolution;
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
