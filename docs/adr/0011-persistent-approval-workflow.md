# 0011 — Persistent approve/edit/reject workflow

Status: accepted (2026-08-19; revised after external ADR review, accepted same day)
Depends on: 0006, 0007, 0009, 0010, 0015

## Context

piko has containment and budgets but no approval layer: a gated action either
runs or the whole run is configured not to allow it. Industry per-call prompts
fail in practice (users alias them away), and no major harness offers approvals
that survive process loss. The v0.2 lifecycle journal (0007) already models
tool executions as planned -> started -> completed/failed/skipped/outcome_unknown,
which is precisely the substrate a durable approval needs: an approval is a
planned execution whose start is deferred pending a recorded human decision.
The praxis gate principle applies directly: machine-verifiable steps advance
unattended; judgment calls stop the line and wait.

## Decision

1. Policy: `ToolExecutionPolicy.approval` names gated tools (list of tool names
   or `"*"`, extension tools included by name; default none, preserving current
   behavior). Deliberately a data shape, not a callback, so it survives
   serialization into configs and child runs. Provenance is restricted:
   approval policy comes only from user config and CLI flags — `--trust-project`
   content and extensions can never set, relax, or narrow it (0006's rule that
   project instructions cannot touch tool policy extends to this field).
2. Suspension: a model batch executes in order until the first gated call.
   Every not-yet-executed call in the batch (gated or not) is journaled
   `planned`; gated ones additionally get `tool_approval_requested` (derived
   status: `awaiting_approval`). The agent emits an `approval_required` event
   and ends the turn with the new `TurnStatus` `suspended`. No model request is
   made past that point, so the dangling assistant tool_use never leaves the
   process, and side-effect order is preserved exactly.
3. Decisions are journal rows: `tool_approval_decided` with
   `approved | edited | rejected`, the edited arguments when applicable
   (validated by the existing tool-argument validator), and a reason. Original
   arguments remain in the journal; an edit is visible provenance, and the tool
   result message notes it so the model is not gaslit.
4. Crash windows are closed by stated rules, not new states: a
   `decided(approved)` row with no `started` row means nothing began — resume
   dispatches it; a `started` row with no terminal row follows 0007 and becomes
   `outcome_unknown`. Concurrent deciders are settled by the single-writer
   session lock (0015) plus the journal's throw-on-invalid-transition.
5. Resume continues the suspended run's `RunBudget` accounting — 0009's
   bounded-per-input property survives suspension. Raising a budget at resume
   is allowed only via explicit flags and is itself journaled.
6. Automation contract (0010): exit code 4 = suspended awaiting approval; the
   `--json` stream gains `approval_required` and decision rows under 0010's
   backward-compatibility rules. Parents spawning children (0004) must treat
   child exit 4 as "forward the decision," not failure.
7. Surfaces: the REPL prompts inline (approve/edit/reject) without suspending
   the process; headless/JSON runs exit 4, and decisions are applied by a
   resume invocation with per-execution flags.

## Consequences

- Approvals survive crashes, reboots, and days of latency by construction —
  the journal is the state, no new persistence layer.
- Zero cost when unconfigured; no fixed-context change (loop-side, per 0005).
- Costs: a fifth TurnStatus and exit code for every consumer to handle; resume
  logic gains a branch that must be fault-tested against the crash-repair path;
  the journal schema grows two row types, forcing the journal-versioning
  decision the maturity notes already flag.
- Explicitly not solved here (named non-goals, revisit on demand):
  argument-pattern gating (approve `git push` but not `ls`) — gating is per
  tool name only; session-scoped "always allow" grants — their absence recreates
  prompt fatigue for chatty tools and is accepted v1 friction; workspace drift
  between planning and a late approval (TOCTOU) — `edit` fails safe by
  construction via its old-text match, `bash` does not, and planning-time
  content hashes are noted as the future mitigation; approval UI beyond the
  terminal; multi-approver policy; OS-level enforcement (a rejected call is not
  a sandbox — 0006's boundaries still apply).

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "CaMeL: Defeating Prompt Injections by Design", Debenedetti
  et al., arXiv 2503.18813, 2025. Separating trusted control flow from untrusted
  data gives provable security on 77% of AgentDojo; this record's rule that
  policy comes only from user config, never project content, stated as a
  theorem.
- corroborates: "Progent", Shi et al., arXiv 2504.11703, 2025. Symbolic policies
  over tool names and arguments, where the action space can only shrink without
  an explicit approval.
- corroborates: "AgentSpec", Wang, Poskitt & Sun, ICSE 2026, arXiv 2503.18666.
  User-authored rules block more than 90% of unsafe code-agent actions at
  millisecond overhead.
- challenges: "Measuring the Permission Gate", Ji et al., arXiv 2604.04978,
  2026. About 37% of state-changing actions bypass a shell-oriented classifier
  through file edits the gate never sees; equivalent-effect paths escape a
  tool-name policy, which is exactly this record's shape.
- challenges: "Reframing LLM Agent Security as an Agent-Human Interaction
  Problem", Wang, Li & Tian, arXiv 2605.24309, 2026. Approval appears in 15 of
  21 production systems and repeated dialogs drive always-allow fatigue, the
  failure this record's context names and its per-call design invites.
- challenges: "Mind the Gap" (TOCTOU-Bench), Lilienthal & Hong,
  arXiv 2508.17155, 2025. State changes between approval and execution;
  mitigations cut the window by about 95% but vulnerability only from 12% to 8%,
  which measures the bash race this record acknowledges as unsolved.

## Addendum (2026-08-24) — compaction boundary

Approval v1 does not migrate a suspended tool-use batch into a new lineage
head. While a session has an undecided approval, or an approved/edited call that
has not yet started, both manual and automatic compaction refuse before writing
a `compaction_started` row or making a summary request. The error lists the
blocking execution IDs and directs the operator to decide and resume them.

This preserves the original tool-call IDs, ordering, budget segment, and
single-writer decision point in one journal. Carrying suspended executions
through compaction remains deferred until it has an explicit lifecycle design
and the same crash-window evidence as this ADR. The Phase 1 evidence map is
maintained in `docs/adr/evidence/0011-approval-test-map.md`.

## Addendum (2026-09-02, argument-prefix rules and session grants)

Two of this record's named non-goals are retired here: argument-pattern gating
and session-scoped "always allow" grants. The Research addendum above is why.
Ji et al. measured that a name-only gate misses the equivalent-effect paths, and
Wang, Li & Tian measured that a per-call dialog for a chatty tool produces the
always-allow fatigue this record's context names. A rule that can say
`git status` is not `git push`, and a grant that can say "stop asking me about
this prefix", answer the two findings in the same mechanism. Progent and
AgentSpec are the corroborating shape: symbolic, user-authored policy over tool
names and arguments, evaluated in milliseconds, where the action space only
shrinks. Everything else in this record is unchanged: policy provenance is still
user config and CLI flags only, decisions are still journal rows, and the
suspension, resume, and crash-window rules are untouched.

### Rules

A config section `approvals.rules` is an ordered list of
`{ tool, prefix, decision, tests }`. `decision` is `allow | prompt | deny`.
`prefix` is a word prefix (for bash, the words of a command segment) or a map of
parameter name to argument-value prefix for a tool whose arguments are not a
command line; an absent prefix matches every call of the tool. `--approval-rule
'<tool>:<decision>:<word> <word>...'` is the headless form, evaluated before the
config file's rules. `tests` is a list of `{ command, expect }` inline examples,
evaluated against the whole rule set at load: a failing example refuses to start
with exit 1 naming the rule and the example, so a rule can never quietly stop
meaning what its author wrote. An example no rule matches is reported as
`prompt`, which is what the tool-name gate yields for any gated tool.

### Evaluation order

Evaluation happens at dispatch, on the exact arguments the tool will receive, an
approved edit included, and after argument validation: a call that will never
run is never matched. A bash command is split into segments on `&&`, `||`, `|`,
`;`, `&`, and newlines, respected outside quotes; every other tool is one
implicit segment matched by its arguments. Within a segment the first matching
rule wins. Across segments deny beats prompt beats an unmatched segment beats
allow, and an unmatched segment falls back to this record's tool-name policy:
`git status && curl ...` prompts because `curl` matched nothing and bash is
gated. A deny refuses the call outright and journals a `tool_skipped` row with
the rule that refused it; there is nothing for a human to decide, so a deny never
suspends. The rule that decided a gate rides the `tool_approval_requested` row as
an optional `rule` field, additive under 0019, so the schema generation does not
move.

### The tokenizer's refusal set

The tokenizer honors single quotes, double quotes, and backslash escapes, and
refuses anything whose effective words it cannot know statically: command
substitution (`` ` `` and `$(`), any expansion (`$`), subshells and process
substitution (`(`, `<(`, `>(`), an unterminated quote, a trailing backslash,
`eval`, `source`, `.`, `exec`, `bash -c` and its `sh`/`zsh`/`dash`/`ksh`
siblings, and an environment assignment before the command. A refused segment is
never allowed by any rule or grant: it falls to `prompt`, and to `deny` when a
deny rule's word appears anywhere in a best-effort split of it. Timidity is the
whole design: the failure mode of a wrong refusal is one extra prompt, and the
failure mode of a wrong allow is an unreviewed side effect.

### Session-scoped grants

The REPL prompt offers "grant this prefix for the session" alongside approve,
edit, and reject. The grant is an additive `tool_approval_grant` journal row
`{ tool, prefix, grantedAt }`. The journal is the grant, so it is honoured for
the rest of the session and replayed on resume exactly like every other decision
in this record. `--grant '<tool>:<word> <word>...'` writes the same row at
startup for headless use, and `/approvals revoke <n>` writes a revoking row of
the same type, which is why no second row type and no schema bump are needed. A
grant can only narrow prompting: it turns a prompting or unmatched segment into
an allow and can never reach a deny rule or a segment the tokenizer refused.

### What a rule cannot see

A rule reads a tool call's own arguments and nothing else. It cannot see what a
command will do, only what it says; it cannot see the workspace the command will
land in; and above all it cannot see a command's effect on a file another tool
edited, or the reverse. That cross-tool equivalence, the 37% of state-changing
actions Ji et al. found bypassing a shell-oriented classifier through file edits,
is the containment boundary's problem, not the approval gate's: it belongs to
0006's tool policy and 0022's executor, and this addendum does not narrow it.
The TOCTOU window this record already acknowledges is likewise untouched: a rule
matches at dispatch, and what the workspace holds a moment later is still 0007's
workspace digest and 0022's mount rule to answer.
