# piko: a lean, token-efficient agentic coding harness

> The CLI command is `pi`; the project is **piko** ("tiny pi").

A clean-room minimal coding agent in the spirit of [badlogic/pi-mono](https://github.com/badlogic/pi-mono).
The checked all-built-ins prefix stays **under 1,000 estimated tokens** (roughly 850 on this
revision, including the opt-in bash schema, enforced by `npm run check-budget`). Project
instructions and extension schemas are separately opt-in and bounded. No third-party runtime
packages.

## Why lean

Published and vendor-reported studies suggest that harness design can materially affect task
quality, latency, and token use. This repository does not reproduce those cross-harness studies,
so it treats that conclusion as a design hypothesis rather than a benchmark claim. The evidence
enforced here is narrower: a checked estimated-context budget, bounded tool and instruction
surfaces, deterministic fault tests, and per-run usage artifacts. Piko optimizes for low fixed
overhead, inspectability, and cost measurement; it does not claim capability parity with larger
industry harnesses.

## Design

- **Five built-ins**: workspace-confined `map`, `read`, `write`, and `edit`; host `bash` exists but
  is not exposed unless `--allow-host-bash` is explicit. Bash receives a sanitized environment.
- **Repo map**: `map` renders source files with line counts and top-level symbols (zero-dep,
  regex-based, vendor dirs skipped) to provide a compact starting point for exploration.
- **No sub-agent orchestration in core**: the headless CLI and JSONL stream are composable by an
  external controller. An opted-in host-bash run can invoke another process, but piko does not
  provide delegation, parent/child accounting, or isolation for that pattern.
- **No MCP in core**: integrations require an explicitly loaded extension or an external
  controller; trusted host-bash mode can invoke installed CLIs.
- **No planning mode / todo tool**: plans live in `PLAN.md` with markdown checkboxes.
- **Compaction that stays observable**: before each request, the harness projects the complete
  serialized request from real prior usage plus newly appended content. It summarizes only the
  dropped prefix before the recent tail (never splitting a tool call from its results) and
  continues in a **new** session file; the full
  pre-compaction transcript stays on disk untouched. `/compact` does the same on demand;
  `--no-auto-compact` turns the automatic path off. The window comes from a per-model-family
  table, overridable per profile (`contextWindow`) or with `PI_CONTEXT_WINDOW`.
- **Flail guard (doom-loop protection)**: the harness hashes every tool call (name plus
  canonical arguments) and counts what it sees, whether the call failed or succeeded. Repeated
  failures escalate on tight thresholds, identical *succeeding* calls on relaxed ones, and an
  A,B,A,B alternation of the same pair on a cycle count. At the nudge threshold it injects a
  short message asking for a change of approach; if the pattern continues it ends the turn with
  a demanded final report instead of burning the budget. `--no-flail-guard` to disable.
- **Microcompaction**: old bulky tool outputs are offloaded to disk and replaced with a path
  stub the model can re-read: nothing summarized away, no model call paid, batched to respect
  the prompt cache. Each run uses a random owner-only `.pi/artifacts/` subdirectory with a local
  git-ignore rule; the files can still contain sensitive source or command output. `--no-offload`
  to disable.
- **Mid-turn steering**: type while a turn is running and the note is injected before the next
  model call (`[↪ steering applied]`), not queued until the end.
- **Durable, inspectable local state**: owner-only, fsynced JSONL sessions under `~/.pi/sessions/`,
  per-turn token and USD ledgers with cache hit-rate (`/tokens`, `--usage`), and `pi --audit [session]`
  reconstructing linked-session economics. A versioned write-ahead lifecycle journal records
  model requests with exact pricing provenance, tool planned/started/completed/failed/unknown states,
  compaction lineage, and terminal run status. Unpriced or outcome-unknown requests make aggregate
  USD explicitly unavailable rather than looking free. Only a corrupt partial tail is ignored;
  invalid middle rows fail closed.
- **Approvals that survive process loss**: `--require-approval <names|*>` gates tools behind a
  recorded human decision. The batch runs in order until the first gated call, journals the rest,
  and the turn ends `suspended` (exit 4) without another model request. The decision is a journal
  row, not process state, so a suspended run can be approved, edited, or rejected minutes or days
  later — after a crash or a reboot — by resuming the session. Gating is per tool name; the policy
  comes only from CLI flags and `~/.config/pi/config.json`, never from project files or extensions.
  A resumed run continues the suspended run's token, tool-call, and model-request accounting under
  the ceilings recorded on its terminal row: raising one needs an explicit flag and is journaled.
  Only the wall-time deadline restarts, because waiting for a human is not the run's own compute.
- **Prompt-cache conscious**: stable prefix ordering with Anthropic cache breakpoints; normal
  turns append. Explicit microcompaction rewrites only eligible old tool-result blocks, while full
  compaction starts a lineage-linked session and preserves the prior transcript.
- **Fail-closed budgets**: model requests, tool calls, provider-reported tokens, USD spend, and every retained
  tool result are bounded. Wall deadlines bound harness waits and bundled provider/bash paths;
  arbitrary in-process extension code cannot be forcibly preempted or have its side effects rolled
  back. `max_tokens` and incomplete streams are non-success states.

## Packages

| Package | Purpose |
| ------- | ------- |
| `@pi/ai` | Streaming client for Anthropic Messages and OpenAI-compatible Chat Completions protocols, retries, usage accounting |
| `@pi/core` | Agent loop, five built-ins, policies/budgets, system prompt, durable JSONL sessions with resume/branch |
| `@pi/cli` | readline REPL + first-class headless `-p` mode, slash commands, prompt templates, extensions |

## Usage

Supported hosts are macOS and Linux with Node.js 20.11 or newer. Windows is not
currently supported because session durability and host-bash cancellation rely on
POSIX filesystem/process semantics.

```bash
npm install && npm run build

# interactive (uses ANTHROPIC_API_KEY, else OPENAI_API_KEY)
node packages/cli/dist/main.js

# trusted local development: opt into repository instructions and unsandboxed host bash
node packages/cli/dist/main.js --trust-project --allow-host-bash

# headless: final reply on stdout, progress on stderr
node packages/cli/dist/main.js -p "review these files" --max-turns 20

# hard dollar ceiling; exact model key required, with a durable pre-dispatch reservation
node packages/cli/dist/main.js -p --pricing ./model-prices.json --max-spend-usd 0.50 "review these files"
# Budget ceilings are enforced per user turn (in -p, the turn is the run); in the REPL they reset each turn. Session-scoped ceilings: ADR 0026, proposed.

# versioned JSONL automation stream; incomplete/capped runs exit nonzero
node packages/cli/dist/main.js --json "review these files"

# gate a tool behind a human decision: the run suspends at the first gated call and exits 4
node packages/cli/dist/main.js -p --require-approval write,bash "apply the migration"

# decide later — in this process, or days later after a crash — and the run continues
node packages/cli/dist/main.js -p -c --approve all
node packages/cli/dist/main.js -p -c --reject tool_8f31 --reason "not on a Friday"
node packages/cli/dist/main.js -p -c --edit tool_8f31 --args '{"path":"safe.txt","content":"…"}'

# extended thinking on Anthropic models
node packages/cli/dist/main.js --thinking 8192 "untangle this race condition"

# continue the last session in this directory
node packages/cli/dist/main.js -c

# other providers via profiles (~/.config/pi/config.json) or env
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
  node packages/cli/dist/main.js --profile openai --model qwen3-coder-plus
```

Config file (`~/.config/pi/config.json`, optional):

```json
{
  "defaultProfile": "kimi",
  "approval": ["bash", "write"],
  "profiles": {
    "kimi": { "provider": "openai", "baseUrl": "https://api.moonshot.ai/v1", "model": "kimi-k3", "apiKeyEnv": "MOONSHOT_API_KEY" }
  },
  "extensions": []
}
```

`approval` gates those tools behind a human decision for every profile; a profile may set its own
`approval` (a list of tool names or `"*"`) to override it. This file and the `--require-approval`
flag are its only sources.

Pricing accepts piko's `models.{name}.{inputUSDPerToken,outputUSDPerToken}` schema or exact
LiteLLM price-table rows. Resolution is explicit path → fresh 24-hour cache → public-table fetch →
stale cache → empty. `--pricing <path>` and `--offline-pricing` disable fetching; custom provider
base URLs are offline by default because public-model prices must not be guessed. Every priced
request records source class, table hash, USD currency, and effective time in the session journal.

Headless exit codes are semantic and fail closed — success must be proven by a terminal status:

| Code | Meaning |
| ---- | ------- |
| 0 | completed turn |
| 1 | error (bad flags, setup failure, provider error) |
| 2 | budget exceeded (`--max-turns`, tool calls, wall time, tokens, USD spend) |
| 3 | incomplete or unknown terminal state |
| 4 | suspended awaiting tool approval; resume with `--approve`/`--reject`/`--edit` |
| 5 | newest resumable session is locked by another process; see `pi doctor sessions` |
| 130 | canceled by the user |

A parent process spawning children must treat exit 4 as "forward the decision", not as failure.
A child started with `--parent-run <id>` echoes that id on every JSON row and in telemetry;
`--max-depth <n>` (default 2) with the exported `PI_DEPTH` variable refuses a piko started
past the cap with exit 1 before any model call.

## Sandboxing

By default, piko exposes only workspace-confined file tools. Parent traversal, absolute paths,
symlink escapes, and special files are rejected by path-based checks; writes are atomic. These
checks are not race-proof: a reproduced parent-symlink swap can defeat them (ADR 0022, accepted,
not yet implemented), so the boundary is best-effort against a hostile repository until 0022
lands. Repository `AGENTS.md` and skills are ignored until `--trust-project` is explicit. Host
bash is absent until `--allow-host-bash` is explicit, and then receives a sanitized environment
that omits provider credential environment variables. That sanitization is hygiene, not a
credential boundary: a host-bash command runs as your user and can inspect the parent piko
process (for example via `ps`), including its environment. The executor split in ADR 0018 is
the real boundary; until it ships, enable host bash only where you would run the model as
yourself.

Containment also covers paths inside the workspace. `write` and `edit` refuse anything that
resolves, after symlink resolution, into `.git/`, `.pi/`, `.agent/`, or `.claude/` at any depth,
or onto workspace-root `AGENTS.md`, `.mcp.json`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`,
or `.profile`. Those are the files a hostile repository would use to make an agent persist past the
run: a git hook, an agent instruction file, a shell rc file. Reads stay allowed, and git changes go
through bash, so refusing all of `.git/` costs no legitimate workflow. The refusal names the path
and the rule it broke. `--allow-protected-paths` turns the deny list off for a run and prints a
warning.

`--allow-host-bash` is still not an OS sandbox: commands can access host files and network using
the process user's authority. For untrusted autonomous work, run the built CLI inside a container
or microVM with a project-only mount and an egress policy. Keep the provider credential in a
separate control-plane proxy or use a short-lived scoped credential; merely injecting a permanent
key into the same container is not strong isolation.

Tool extensions are trusted controller code, not sandboxed model tools. Modules named in config or
passed with `--ext` execute in the CLI process and can use the process user's filesystem, network,
and environment authority. Schema validation limits what they advertise to the model; it does not
make their JavaScript safe. The sanitized bash environment only withholds credential environment
variables from the child process—it cannot stop a command or extension from reading credentials
that are otherwise accessible on disk.

Piko does not yet ship a turnkey container/microVM executor, so host bash remains an explicit
trusted-environment capability.

## Maturity

Piko is an experimental, pre-1.0 framework. Its current local evidence includes unit, integration,
fault-injection, packaging, and prompt-budget checks, plus an eval runner that writes versioned
per-trial artifacts. It has not had an independent security audit, does not yet provide an OS
sandbox, and has no published representative industry benchmark. Approval gating is per tool name
only: no argument-pattern matching, no session-scoped "always allow", and a rejected call is not a
sandbox — containment still does that work.
APIs are unstable until a compatibility policy is published. The journal now carries an explicit
schema generation: sessions written before the marker are read as generation 1, and a file
declaring a newer generation is refused rather than half-understood.
Workspace packages are intentionally marked private and must not be published until the owner
chooses a license and release policy.
See the [evaluation methodology](docs/evaluation.md) for pass criteria, artifact contents, and the
distinction between the legacy Terminal-Bench adapter and current Harbor-based benchmarks. See
[SECURITY.md](SECURITY.md) for the trust boundaries and responsible-disclosure guidance.

## Extending with bounded context

- **Prompt templates**: bounded `.agent/commands/<name>.md` files become `/<name>` slash commands;
  global templates are available normally, while project templates require `--trust-project`.
  `$ARGUMENTS` is interpolated.
- **Skills**: `.agent/skills/*.md`: with `--trust-project`, a bounded one-line index enters the
  prompt and uses workspace-relative paths.
- **Tool extensions**: `--ext path/to/module.js` (or config `extensions`); the compiled JavaScript
  module default-exports `Tool[]`. Exports, duplicate names, and aggregate schema size are validated;
  extension schemas still add to provider-visible context. `--ext path/to/module.js@sha256:<hex>`
  pins the module to a content hash verified before import, and every load is journaled as an
  `extension_loaded` row.
- **AGENTS.md**: loaded only with `--trust-project`, delimited as project-supplied instructions,
  and capped at 32 KiB.

## Development

```bash
npm test              # build + unit/fault tests (tools, journal, providers, budgets, telemetry)
npm run check-budget  # fails if fixed context exceeds 1000 tokens
npm run eval -- --model gpt-4.1-mini   # 10 headless smoke tasks with versioned result/usage artifacts
```
