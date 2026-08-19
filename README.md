# piko: a lean, token-efficient agentic coding harness

> The CLI command is `pi`; the project is **piko** ("tiny pi").

A clean-room minimal coding agent in the spirit of [badlogic/pi-mono](https://github.com/badlogic/pi-mono).
The checked all-built-ins prefix stays **under 1,000 estimated tokens** (roughly 750 on this
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
- **Flail guard (doom-loop protection)**: after repeated tool failures the
  harness nudges the model to change approach with a short message, and if failures continue
  it ends the turn with a demanded final report instead of burning the budget. `--no-flail-guard`
  to disable.
- **Microcompaction**: old bulky tool outputs are offloaded to disk and replaced with a path
  stub the model can re-read: nothing summarized away, no model call paid, batched to respect
  the prompt cache. Each run uses a random owner-only `.pi/artifacts/` subdirectory with a local
  git-ignore rule; the files can still contain sensitive source or command output. `--no-offload`
  to disable.
- **Mid-turn steering**: type while a turn is running and the note is injected before the next
  model call (`[↪ steering applied]`), not queued until the end.
- **Durable, inspectable local state**: owner-only, fsynced JSONL sessions under `~/.pi/sessions/`,
  per-turn token ledger with cache hit-rate (`/tokens`, `--usage`), and `pi --audit [session]`
  reconstructing linked-session economics. A versioned write-ahead lifecycle journal records
  model requests, tool planned/started/completed/failed/unknown states, compaction lineage, and
  terminal run status. Only a corrupt partial tail is ignored; invalid middle rows fail closed.
- **Prompt-cache conscious**: stable prefix ordering with Anthropic cache breakpoints; normal
  turns append. Explicit microcompaction rewrites only eligible old tool-result blocks, while full
  compaction starts a lineage-linked session and preserves the prior transcript.
- **Fail-closed budgets**: model requests, tool calls, provider-reported tokens, and every retained
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

# versioned JSONL automation stream; incomplete/capped runs exit nonzero
node packages/cli/dist/main.js --json "review these files"

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
  "profiles": {
    "kimi": { "provider": "openai", "baseUrl": "https://api.moonshot.ai/v1", "model": "kimi-k3", "apiKeyEnv": "MOONSHOT_API_KEY" }
  },
  "extensions": []
}
```

## Sandboxing

By default, piko exposes only workspace-confined file tools. Parent traversal, absolute paths,
symlink escapes, and special files are rejected; writes are atomic. Repository `AGENTS.md` and
skills are ignored until `--trust-project` is explicit. Host bash is absent until
`--allow-host-bash` is explicit, and then receives a sanitized environment that omits provider
credential environment variables.

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
sandbox or persistent approval policy, and has no published representative industry benchmark.
APIs and journal schemas should be treated as unstable until a compatibility policy is published.
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
  extension schemas still add to provider-visible context.
- **AGENTS.md**: loaded only with `--trust-project`, delimited as project-supplied instructions,
  and capped at 32 KiB.

## Development

```bash
npm test              # build + unit/fault tests (tools, journal, providers, budgets, telemetry)
npm run check-budget  # fails if fixed context exceeds 1000 tokens
npm run eval -- --model gpt-4.1-mini   # 10 headless smoke tasks with versioned result/usage artifacts
```
