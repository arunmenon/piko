# 0012 — Tool extensions are trusted controller code

Status: accepted (2026-08-19, backfilled same day)
Amends: 0002

## Context

`--ext` / config-listed extension modules add tools beyond the built-in five.
A sandboxed plugin host was considered and rejected: it would add a process
boundary, an IPC contract, and a false sense of safety (a tool that can touch
the workspace is powerful regardless of where it runs). The honest alternative
is to name the trust level.

## Decision

Extensions run in-process, unsandboxed, with the process user's authority.
They are trusted controller code: loaded only when explicitly listed by the
user (never auto-discovered, never from project content), validated at load
time (shape, duplicate names rejected, aggregate schema byte ceilings,
TypeScript sources rejected — compiled JS only), and their schemas join the
provider-visible tool list within 0001's accounting.

This amends 0002: "never resident schemas" now reads "no MCP catalogs; bounded
resident schemas via explicitly listed extensions are the sanctioned
exception." Validation bounds what an extension advertises, not what it does.

## Consequences

- Extension authorship stays trivial (export Tool[]), and the trust model is
  stated instead of implied.
- A malicious extension is game over by definition — equivalent to running any
  other program. Users must treat extension installation like installing
  software, and docs say so.
- Approval policy (0011) can gate extension tools by name, but extensions can
  never modify policy.
