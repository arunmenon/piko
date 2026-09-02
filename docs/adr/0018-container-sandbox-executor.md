# 0018 — Container sandbox executor behind a provider seam

Status: accepted (2026-09-02 by owner delegation, "take the recommendations"; proposed 2026-08-24; amended below)
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

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Sandlock", Wang & Zheng, arXiv 2605.26298, 2026. Unprivileged
  Landlock and seccomp confinement for agent code, with static filesystem and
  port policy, supervisor-mediated egress with resolved-endpoint allowlists and
  DNS pinning, at about 5 ms startup against Docker; a research precedent for a
  lightweight first provider.
- corroborates: "Firecracker", Agache et al., NSDI 2020. The microVM reference
  for the additive provider this seam anticipates.
- corroborates: "The True Cost of Containing", Young et al., HotCloud 2019.
  gVisor costs more than 2 times in syscall overhead, which prices the heavier
  isolation options against the lighter ones.
- challenges: "Quantifying Frontier LLM Capabilities for Container Sandbox
  Escape", Marchand et al., UK AISI, arXiv 2603.02277, 2026. Frontier models
  comfortably escape misconfigured containers across 18 scenarios, about 40% at
  medium difficulty and 0% at the hardest, with success scaling log-linearly in
  compute. A plain container is not a security boundary unless hardened, so this
  record's non-negotiables need tests rather than prose.

## Amendment (2026-09-02, R0-1 provider order; accepted 2026-09-02 by owner delegation)

Drafted from the 2026-09-02 red-team review and section 4 of
docs/red-team-remediation-plan-2026-09.md. This is a draft for the owner to
accept or reject. It changes nothing until the owner records the decision; the
Decision text above stands exactly as proposed until then.

- Provider order. The first provider is the lightweight one: bwrap plus seccomp
  on Linux and Seatbelt on macOS, or `@anthropic-ai/sandbox-runtime` taken as a
  dependency. Docker becomes the second provider, for CI. Per-exec Docker
  latency on a macOS development host is a virtual-machine round trip for every
  `ls`, which is the wrong default for interactive work and the reason a
  Docker-first seam has not shipped.
- The cost is stated plainly: a native or third-party sandbox dependency ends
  the zero-dependency property for that provider. The owner is choosing between
  that and a default nobody runs.

## Amendment (2026-09-02, R0-2 file tools inside the executor; accepted 2026-09-02 by owner delegation)

Drafted from the same review and plan section. It changes nothing until the
owner records the decision.

- Where the tools run. All five tools' effects execute inside the executor, the
  file tools included, while the control plane (session store, journal,
  approvals, budgets) stays outside it. An executor that only runs commands
  leaves 0022 needing a native helper regardless, so the whole-process shape is
  what makes the seam worth its cost.
- Fail-closed is hard-coded, not a flag. When no usable provider is found the
  run refuses to start rather than falling back to host execution.
- The egress proxy is designed as the credential injection point from the
  start, even though v1 networking is none, so credentials are injected at the
  boundary rather than merely absent from the sandbox environment (0016).
- Host bash gets a fresh PID namespace on Linux wherever bwrap is present, which
  closes the read of the parent process environment that 0016 records as
  residual risk.
