# 0022 - Descriptor-anchored workspace containment

Status: proposed (2026-08-24; drafted from external review finding 1, owner ratification pending)
Amends: 0007

## Context

An independent review demonstrated a working parent-symlink TOCTOU escape:
`resolveWorkspacePath()` validates the canonical path and returns a string,
and the mutation later re-traverses that string. Concurrently swapping a
validated parent directory for a symlink between the check and the
rename/write lands the mutation outside the workspace. The reviewer's
reproduction reported `{"escaped": true}` under a concurrent swap loop.
Additional `realpath()` checks cannot close this: any check that returns a
string re-traverses the tree at use time.

## Decision

Bind filesystem mutations to descriptors, not paths:

- Pin the workspace root once at startup: open it as a directory descriptor
  and keep it for the process lifetime; all containment decisions derive
  from this descriptor, never from re-resolving a root path string.
- Perform mutating operations descriptor-relative: walk from the pinned
  root with `O_NOFOLLOW` per component (openat semantics), so a swapped
  parent produces `ELOOP`/`ENOTDIR` failure instead of silent traversal.
  Node exposes enough via `openSync` flags plus `*at`-style walks; where a
  primitive is missing (rename), open the parent directory descriptor by
  walking components and operate on the leaf name only.
- Atomic writes stay: temp file plus rename, but both created via the
  walked parent descriptor.
- Read paths keep the current validation (reads that lose the race read a
  file outside the workspace only if an attacker controls the workspace,
  which is already the trust boundary for reads; writes are the integrity
  boundary this ADR closes).

## Acceptance regression

A deterministic parent-swap test: create `workspace/dir/file`, start a
writer loop, swap `dir` for an out-of-workspace symlink at a barrier the
test controls, and assert the write fails closed and no out-of-workspace
file ever appears. This test is the review reproduction, made deterministic.

## Consequences

- Closes the only demonstrated containment escape; workspace writes become
  immune to path-substitution races rather than resistant to them.
- Component-wise walking costs syscalls per path depth on the write path;
  writes are rare relative to reads and the cost is acceptable.
- The implementation must degrade explicitly (fail closed with a clear
  error) on platforms where `O_NOFOLLOW` semantics differ; benchmark
  containers and macOS/Linux dev hosts are the supported matrix.
