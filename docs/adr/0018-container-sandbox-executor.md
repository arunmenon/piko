# 0018 — Container sandbox executor behind a provider seam

Status: proposed (2026-08-24)
Depends on: 0004, 0006, 0009, 0016

## Context

0006 named OS-level isolation as the next layer and was honest that in-harness
checks are not a sandbox. The exoharness/exo study sharpened both the target
and the anti-pattern: their narrow verb seam over many sandbox providers is
the right shape, but their canonical local setup bind-mounts the repository
root — including the event log's storage directory — read-write into the
agent's own sandbox, leaving the system's one claimed invariant protected by
convention. Separately, 0006 left the contained default with no delegation
path: sub-agents (0004) require `--allow-host-bash`.

## Decision

A `SandboxExecutor` implementing the existing tool-execution boundary, with a
deliberately narrow provider seam: `acquire(image) → id`,
`exec(id, cmd, limits) → output`, `release(id)`. Snapshot/rewind is deferred
to a follow-on decision (it is the soak chamber for 0017 v2, not needed for
v1). Docker is the only shipped provider; the seam is designed so Firecracker
or remote providers are additive, never assumed.

Non-negotiables, enforced by construction:

- Only the workspace is mounted into the sandbox. The session store, journal,
  configuration, and credentials are never inside any sandbox mount — the
  invariant layer stays physically below the layer the model can write.
- Egress is default-deny with an explicit allowlist; provider credentials
  follow 0016 (attached at the call boundary by the harness, never present in
  the sandbox environment).
- Sandbox and egress policy follow 0011's provenance rule: set only from user
  config and CLI flags — never by project content under `--trust-project`, by
  extensions, or by an improve run (0017). A repository must not be able to
  widen its own allowlist.
- 0009 budgets are enforced loop-side regardless of executor; a sandbox is
  containment, not a budget.
- Contained spawn: headless children (0004) execute inside sandboxes, so the
  contained default regains a delegation path without granting host bash —
  closing the gap recorded in 0004's addendum.

## Consequences

- "Safe on untrusted repositories" graduates from documentation to mechanism,
  and sub-agents work with host bash disabled.
- Costs: a Docker dependency and its platform matrix; per-exec latency; the
  seam is a new API surface to version; snapshot capability — and therefore
  0017's stronger canary — waits for the follow-on decision.
- The workspace-only mount rule constrains future features: anything that
  wants the model to read harness state must export it into the workspace
  explicitly, never widen the mount.
