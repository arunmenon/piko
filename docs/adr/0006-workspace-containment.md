# 0006 — Workspace containment and deny-by-default host bash

Status: accepted (2026-08-19)
Amended-by: 0022

## Context

The August 2026 maturity audit found the original trust model unsafe for untrusted
repositories: file tools accepted absolute paths and traversal, bash inherited the
full environment including provider credentials, and repo-supplied AGENTS.md was
elevated into the system prompt. "Run it in Docker yourself" is documentation, not
a mechanism. Meanwhile per-call permission prompts are known to fail in practice
(users alias them away industry-wide).

## Decision

Containment is enforced in the harness, not requested of the model or the user:

- File tools resolve paths against a stable workspace root; parent traversal,
  absolute paths (unless opted in), symlink escapes, and special files are rejected
  by path-based checks (qualification 2026-09-02: not race-proof; a parent-symlink
  swap escape was reproduced and is addressed by 0022, which amends this record)
  at the tool boundary.
- Bash runs with a sanitized allowlist environment (credentials never inherited)
  and is deny-by-default on the host, behind an explicit opt-in; its persisted cwd
  is validated against the workspace on every call.
- Project instructions are opt-in (--trust-project), byte-bounded, and framed as
  task guidance that cannot relax tool policy or budgets.
- Hard budgets (model requests, tool calls, wall time, tokens) bound total blast
  radius per input.

## Consequences

- A hostile repository can no longer trivially read credentials or write outside
  the workspace through the built-in tools; OS-level isolation (container/microVM
  executor) remains the next layer, not replaced by this.
- Costs: friction for legitimate absolute-path and host-tool workflows (explicit
  opt-ins), and a larger tool-boundary test matrix.
- Supersedes the launch-era "full YOLO by default" stance in ADR-adjacent docs;
  approval workflows (persistent approve/edit/reject) remain future v0.3 work.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Your AI, My Shell", Liu et al., arXiv 2509.22040, 2025. 314
  payloads planted in rule files achieve up to 84% malicious command execution
  in Cursor and Copilot, including system-file modification and key
  exfiltration; the threat model this record's untrusted-project default
  answers.
- corroborates: "SoK: Prompt Injection Attacks on Agentic Coding Assistants",
  Maloyan & Namiot, arXiv 2601.17548, 2026. Adaptive attacks exceed 85% success
  against filter defenses, which argues for architectural containment over
  filtering.
- challenges: "One Goal, Many Commands", Chen & Lin, arXiv 2606.15549, 2026.
  Between 69% and 99% of 1,709 real agent command denylists fail to block their
  intended operation. Deny-by-default survives the finding; what it shows is
  that on the day host bash is enabled, a name-level policy is not a boundary.
