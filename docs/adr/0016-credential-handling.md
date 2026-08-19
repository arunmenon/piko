# 0016 — Credential handling

Status: accepted (2026-08-19, backfilled same day; policy spans the initial build and v0.2)

## Context

The harness holds the user's most abusable secrets (provider API keys) in the
same process that executes model-chosen commands against attacker-influencable
input. Three earlier ADRs (0006, 0013, and 0001's config surface) each touch
one edge of the policy; a security reviewer should be able to cite it in one
place.

## Decision

One policy, four enforcement points:

1. At rest: config files store the environment variable NAME (`apiKeyEnv`),
   never the key. Keys exist only in the process environment.
2. In flight: keys leave the process solely as the intended auth header to the
   profile's configured endpoint; request bodies never carry them.
3. Downward: bash children receive a sanitized allowlist environment —
   credentials are never inherited by tool subprocesses (0006), and additional
   variables require explicit per-policy opt-in.
4. Sideways: telemetry and logs pass credential-shape redaction by default
   (0013); session transcripts are `0600` (0015) because tool output can still
   legitimately contain secrets the user chose to expose.

## Consequences

- The common exfiltration paths (hostile repo content asking bash to echo the
  environment; telemetry shipping a key; config files leaking into commits)
  are each closed by construction rather than by care.
- Costs: local tools that legitimately need a credential must be granted it
  explicitly per run; keyless local endpoints are the supported alternative.
  Residual risk is honest: a user-approved (0011) or opted-in command can
  still read anything the user can — OS-level isolation (0006's next layer)
  is the answer there, not this policy.
