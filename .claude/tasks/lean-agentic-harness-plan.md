# Lean Agentic Harness — Build Plan

Goal: a terminal coding agent harness in the spirit of pi (badlogic/pi-mono): total
fixed context (system prompt + tool schemas) under 1,000 tokens, four core tools,
observable sessions, multi-provider. TypeScript on Node/Bun. Clean-room build (no
pi package dependencies).

Benchmark validation (Aug 2026): scoped tool surfaces beat kitchen-sink MCP (tool
overprovision creates a "dumb zone"); sub-agents help only as context firewalls, which
headless self-spawn via bash provides; no evidence planning modes/todo tools help;
small hand-written guide files (+4%) beat bloated generated ones (-20%). Same model
swings 16-36 points across harnesses, so fixed-context discipline is the product.

## Design principles (from pi, keep these as acceptance criteria)

1. Fixed per-turn overhead <= 1,000 tokens (system prompt ~250 words + 4 tool schemas).
2. Tools: read, write, edit, bash only. Everything else is a CLI the model calls via bash.
3. No sub-agents, no MCP, no planning mode, no todo tool in core. Plans live in PLAN.md;
   parallelism = spawn the harness itself under tmux; integrations = CLI tools with READMEs
   (progressive disclosure).
4. Every byte sent to the model must be inspectable (session JSONL + a token ledger).
5. Extensibility via markdown prompt templates and TS extensions, never via core bloat.

## Token-efficiency mechanics (the actual "lean" work)

- Prompt caching: stable prefix ordering (system prompt, tools, then messages) so
  Anthropic/OpenAI cache hits are maximized; never mutate earlier messages.
- Tool output caps: bash output truncated head+tail with byte budget (e.g. 30KB) and a
  note telling the model how to page; read supports offset/limit for large files.
- Terse tool schemas: one-line descriptions, no examples in schemas.
- Token ledger per turn: input/output/cache-read/cache-write, printed on demand and
  saved with the session. This is how you prove the 3x-less-context claim for yourself.
- No compaction initially (pi ships without it); add optional manual /compact later.

## Phase 1 — Provider layer (`packages/ai`)

Unified streaming LLM client. Either:
  a) depend on `@earendil-works/pi-ai` (shortcut, multi-provider out of the box), or
  b) implement: Anthropic Messages API + OpenAI-compatible chat completions (covers
     Qwen, Kimi/Moonshot, DeepSeek, OpenRouter, local vLLM/llama.cpp endpoints).
Deliverables: streaming events (text, tool_call, usage), tool-call normalization across
providers, prompt-cache control, retries/backoff, usage accounting. Config via env vars
and a small ~/.config file (model, base URL, API key per profile).

## Phase 2 — Agent loop (`packages/core`)

- Message state, the loop: send -> stream -> if tool calls, execute all, append results,
  repeat until plain-text stop. ~200-300 LOC.
- Tool dispatcher with JSON-schema validation; tool errors returned to the model as
  results, never crash the loop.
- Abort/interrupt (Ctrl+C returns control to user with partial state intact).
- Session persistence: append-only JSONL per session; resume (`-c`), named sessions,
  branching (fork from message N).

## Phase 3 — Tools (`packages/core/tools`)

- read: text + images, offset/limit, line numbers.
- write: create/overwrite, mkdir -p behavior.
- edit: exact-match string replacement (unique-match required), replace_all flag.
- bash: sync exec with timeout, cwd persistence, output truncation.
- System prompt: ~250 words — role, tool guidance, style (terse), cwd/OS/date injected.
  Budget check in CI: fail if prompt+schemas exceed 1,000 tokens (measure with a
  tokenizer at build time).

## Phase 4 — CLI (`packages/cli`)

- v1: plain readline REPL with streaming markdown-ish rendering; flags: -p (one-shot
  print mode), -c (continue), --model, --session.
- -p mode is first-class, not an afterthought: it is the sub-agent story. Benchmarks
  (Harness Effect, 2026) show sub-agents help as context firewalls; spawning the harness
  itself headlessly via bash gives that firewall with zero core complexity. -p must
  support: reading prompt from argv/stdin, clean exit code, final answer on stdout,
  --max-turns guard.
- AGENTS.md support: if ./AGENTS.md exists, append to system prompt; warn if it exceeds
  ~60 lines (hand-written small guides measured +4%; bloated generated ones -20%).
- Slash commands: /model, /session, /tokens (ledger), /branch.
- v2 (optional): differential-render TUI a la pi-tui.

## Phase 5 — Extensibility

- Prompt templates: markdown files in ./.agent/commands/ and ~/.agent/commands/ with
  $ARGUMENTS interpolation -> slash commands.
- Skills: markdown docs the model reads on demand via read (listed one-line-each in a
  cheap index only when present).
- TS extensions: register extra tools / event hooks; loaded explicitly per project,
  never by default.

## Phase 6 — Evaluation

- Smoke suite: 10-15 scripted coding tasks (fix bug, add feature, refactor) run headless
  (-p mode) against a scratch repo; assert on resulting files/tests.
- Track tokens/task and turns/task per model; compare against Claude Code / Qwen Code on
  the same tasks to verify the efficiency claim.
- Optional: run Terminal-Bench 2.0 subset.

## Milestones

- M1 (Phases 1-3): working headless agent, one provider, 4 tools. Usable day 1-3.
- M2 (Phase 4): interactive REPL + sessions.
- M3 (Phases 5-6): templates/extensions + eval numbers.

## Non-goals (explicitly out)

Sub-agent orchestration in core, MCP client, permission-prompt system, IDE integration,
compaction (until proven needed).
