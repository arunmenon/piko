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

## Addendum (2026-09-02, protected paths inside the workspace)

The original decision drew the boundary at the workspace edge, so anything inside
the workspace was writable. The red-team review (R2-1) pointed out that the paths
worth attacking are all inside it: `.git/hooks/pre-commit` and `.git/config` run
code on the next commit, `AGENTS.md` and `.agent/` feed the next run's prompt,
`.claude/` and `.mcp.json` configure other agents on the same checkout, and a
shell rc file in a workspace that happens to be a home directory runs on the next
login. Containment that stops at the workspace edge protects the host and leaves
the persistence vector open.

The file tools now refuse to modify a deny list of paths inside the workspace:

- the directories `.git/`, `.pi/`, `.agent/`, and `.claude/`, at any depth below
  the workspace root, and everything under them;
- the workspace-root files `AGENTS.md`, `.mcp.json`, `.bashrc`, `.bash_profile`,
  `.zshrc`, `.zprofile`, and `.profile`.

Resolution rule: the deny list is evaluated on the canonical path, after symlink
resolution and after the existing containment checks, expressed relative to the
workspace root. A symlink alias inside the workspace therefore cannot launder a
protected target, and a path is judged by where it lands rather than by how it
was spelled. Segment comparison is case-insensitive so a case-insensitive
filesystem cannot turn `.GIT/hooks/pre-commit` into a bypass. Directory names
match at any depth because a nested checkout's `.git/` is exactly as executable
as the root one; the file entries match at the root only, because only the root
`AGENTS.md` is loaded into the prompt and a document named `AGENTS.md` deeper in
a tree is ordinary content.

`.git/` is refused wholesale rather than hook by hook. The tools it would take to
enumerate the dangerous parts of a git directory (hooks, config, the
`core.fsmonitor` and `core.pager` style config keys, alternates, filters) are the
same tools an attacker would use to find the one that was missed, and no
legitimate file-tool workflow needs to write into `.git/` at all: git changes go
through bash, which is a separate, explicitly enabled capability with its own
approval and audit story. A deny list that is complete at the directory level is
worth more than one that is precise at the file level.

Reads are deliberately unaffected. The model still needs to read `.git/config`,
`AGENTS.md`, or a skill file to reason about the project, and reading them does
not create persistence. The refusal message names the offending path, the path it
resolved to, and the rule it broke, so a model that hits it can route the change
to bash rather than retrying variants of the same write.

Opt-out: `ToolExecutionPolicy.allowProtectedPaths`, set only by the CLI flag
`--allow-protected-paths`, which warns on stderr like `--allow-host-bash` does.
Provenance is restricted the same way the approval field is: project content
loaded by `--trust-project` and tool extensions must never reach it, since a
repository that could set it would be relaxing the rule that exists to contain
that repository.

Costs: an agent that genuinely needs to install a git hook or edit `AGENTS.md`
must be started with the flag or must go through bash, and the deny list is a
fixed list rather than a policy language, so it will need amending as new agent
configuration formats appear. It is also not a substitute for the OS-level
executor: it closes a specific persistence vector in the path-based layer that
0022 will re-found on descriptors.
