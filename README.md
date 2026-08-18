# pi — a lean, token-efficient agentic coding harness

A clean-room minimal coding agent in the spirit of [badlogic/pi-mono](https://github.com/badlogic/pi-mono):
the entire fixed per-turn context (system prompt + tool schemas) stays **under 1,000 tokens**
(currently ~537, enforced by `npm run check-budget`). Zero runtime dependencies.

## Why lean

Harness design swings the same model's benchmark score by 16-36 points. The 2026 evidence:
scoped tool surfaces beat kitchen-sink MCP; sub-agents help only as context firewalls (which
headless self-spawn provides); small hand-written guide files help (+4%) while bloated ones
hurt (-20%). This harness keeps every one of those levers deliberately small.

## Design

- **Four tools**: `read`, `write`, `edit`, `bash`. Everything else is a CLI the model runs via bash.
- **No sub-agents in core**: spawn `pi -p "task"` via bash — progress goes to stderr, only the
  final reply to stdout, so it composes as a context firewall.
- **No MCP**: integrations are CLI tools with READMEs the model reads on demand.
- **No planning mode / todo tool**: plans live in `PLAN.md` with markdown checkboxes.
- **Compaction that stays observable**: when the last request's real token usage crosses
  `contextWindow - reserve`, the harness summarizes everything before the recent tail (never
  splitting a tool call from its results) and continues in a **new** session file — the full
  pre-compaction transcript stays on disk untouched. `/compact` does the same on demand;
  `--no-auto-compact` turns the automatic path off. The window comes from a per-model-family
  table, overridable per profile (`contextWindow`) or with `PI_CONTEXT_WINDOW`.
- **Everything inspectable**: append-only JSONL sessions under `~/.pi/sessions/`, per-turn token
  ledger (`/tokens`, `--usage`). Crash-resilient: corrupt session lines are skipped, and a
  transcript that died mid-tool-call is repaired on resume.
- **Prompt-cache friendly**: stable prefix ordering with Anthropic cache breakpoints; earlier
  messages are never mutated.
- **Output caps**: bash output truncated head+tail (30k chars) with an explicit marker; `read`
  supports offset/limit paging.

## Packages

| Package | Purpose |
| ------- | ------- |
| `@pi/ai` | Streaming multi-provider client (Anthropic Messages + any OpenAI-compatible endpoint: OpenAI, Qwen, Kimi/Moonshot, DeepSeek, OpenRouter, vLLM, llama.cpp), retries, usage accounting |
| `@pi/core` | Agent loop, the four tools, system prompt, JSONL sessions with resume/branch |
| `@pi/cli` | readline REPL + first-class headless `-p` mode, slash commands, prompt templates, extensions |

## Usage

```bash
npm install && npm run build

# interactive (uses ANTHROPIC_API_KEY, else OPENAI_API_KEY)
node packages/cli/dist/main.js

# headless: final reply on stdout, progress on stderr — the sub-agent building block
node packages/cli/dist/main.js -p "fix the failing test" --max-turns 20

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

pi runs with your user's permissions and no approval prompts (per-call permission theater does
not stop exfiltration once a process can read files and reach the network). The 2026 consensus
is OS-level isolation instead — run pi inside one of:

```bash
# Docker: mount only the project, no credentials
docker run --rm -it -v "$PWD":/work -w /work -e OPENAI_API_KEY node:22 npx pi -p "..."

# macOS: Seatbelt via sandbox-exec, or use a throwaway git worktree + diff review
git worktree add ../scratch && (cd ../scratch && pi) && git -C ../scratch diff
```

For untrusted or long-running autonomous work, the container path is the supported answer.

## Extending without spending tokens

- **Prompt templates**: `.agent/commands/<name>.md` (project) or `~/.agent/commands/<name>.md`
  (global) become `/<name>` slash commands; `$ARGUMENTS` is interpolated.
- **Skills**: `.agent/skills/*.md` — only a one-line index enters fixed context; the model reads
  the full file with `read` when relevant.
- **Tool extensions**: `--ext path/to/module.ts` (or config `extensions`); the module
  default-exports `Tool[]`. Never auto-discovered.
- **AGENTS.md**: appended to the system prompt if present; a warning fires above 60 lines.

## Development

```bash
npm test              # build + 16 unit tests (tools, sessions, SSE, provider mapping)
npm run check-budget  # fails if fixed context exceeds 1000 tokens
npm run eval -- --model gpt-4.1-mini   # 10 headless smoke tasks with pass/fail + token cost
```
