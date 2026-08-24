# piko roadmap

Updated after the August 2026 reliability and industry-maturity audit. The project is an
early-alpha harness; completion here means implemented and locally tested, not production proof.

## v0.2 safety and correctness — implemented in this working tree, unreleased

Package manifests are versioned `0.2.0`; the tag and publish decision remains a pending human gate, so nothing is released.

- Workspace-relative, symlink-aware file containment and atomic writes.
- Deny-by-default host bash with a sanitized environment and explicit `--allow-host-bash` opt-in.
- Opt-in, byte-bounded project instructions (`--trust-project`).
- Strict provider stream completion, request deadlines, and non-success `max_tokens` handling.
- Hard model-request, tool-call, wall-time, token, and tool-output budgets.
- UUID/`0600`/exclusive/fsynced sessions with runtime schema validation.
- Write-ahead model/tool/compaction/run lifecycle journal and `outcome_unknown` crash semantics.
- Next-request context preflight, prefix-only bounded summaries, billed compaction usage, and lineage.
- Fault tests for truncation, path/symlink escape, special files, crash resume, limits, and timeouts.

## v0.3 framework beta — in progress

- [x] Versioned `--json` automation event stream and typed terminal states.
- [x] Versioned redacted telemetry contract, durable JSONL sink, and model/tool/run spans.
- [x] Runtime validation and byte ceilings for tool extensions; duplicate names rejected.
- [x] Atomic CLI model/profile switch that rebuilds provider and context-window state.
- [x] Linked-session audit and per-request model attribution.
- [x] Persistent approve/edit/reject workflow that can suspend and survive process loss.
- [x] Compaction while approvals are pending: blocked at both session and agent layers with execution IDs in the error (0011 addendum, 2026-08-24); carrying suspended batches through compaction stays deferred until it has its own lifecycle design and crash-window evidence.
- [ ] Container or microVM `ToolExecutor` adapter with filesystem and egress policy.
- [ ] Stable bidirectional RPC/SDK surface beyond one-shot JSONL output.
- [ ] Provider capability registry and native OpenAI Responses adapter.
- [ ] Structured child-run identities, cancellation propagation, aggregate budgets, and handoffs.
- [ ] OpenTelemetry exporter adapter (the core sink contract is implemented).

## v1.0 evidence and release candidate

- [ ] Repeated external benchmark runs with raw trajectories, manifests, model snapshots, and
      confidence intervals; report cost per completed task.
- [ ] Adversarial prompt-injection, long-context, crash/chaos, concurrency, and provider-conformance suites.
- [ ] Official supported-provider and supported-platform compatibility matrix.
- [ ] Containerized reference deployment and threat model validation.
- [ ] Public package names, semver/migration policy, provenance, changelog, and release automation.
- [ ] Choose and add an OSI license. This is an owner/legal decision, not an automated code change.

## Non-goals for the lean core

- Building a proprietary distributed workflow engine; integrate with established durable runtimes.
- Loading a large MCP catalog into every prompt. If MCP is added, use bounded discovery/proxy tools.
- Treating permission prompts as a sandbox. Approval and OS isolation solve different problems.
- Claiming exactly-once side effects without tool-specific idempotency or transactional integration.
