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

- **Five built-ins**: workspace-confined `map`, `read`, `write`, and `edit`; `bash` is exposed only
  inside the sandbox executor or behind an explicit `--allow-host-bash`. Bash receives a sanitized
  environment.
- **Sandbox executor**: with a provider available (bubblewrap on Linux, Seatbelt on macOS) the five
  tools' effects run inside an operating-system sandbox while the control plane stays outside it.
  `--sandbox auto|off|require`; see [Sandboxing](#sandboxing).
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
  later — after a crash or a reboot — by resuming the session. Ordered argument-prefix rules
  (`approvals.rules`, `--approval-rule '<tool>:<allow|prompt|deny>:<word> <word>...'`) decide per
  bash command segment ahead of the tool-name gate, carry inline `{ command, expect }` tests that
  refuse to start when they fail, and fall back to the tool-name gate for anything they do not
  match. `--grant` and the REPL's `g` answer write a session-scoped "always allow this prefix"
  grant as a journal row that a resume replays; a grant only narrows prompting and never overrides
  a deny rule. The policy
  comes only from CLI flags and `~/.config/pi/config.json`, never from project files or extensions.
  A resumed run continues the suspended run's token, tool-call, and model-request accounting under
  the ceilings recorded on its terminal row: raising one needs an explicit flag and is journaled.
  Only the wall-time deadline restarts, because waiting for a human is not the run's own compute.
- **Prompt-cache conscious**: stable prefix ordering with Anthropic cache breakpoints; normal
  turns append. Explicit microcompaction rewrites only eligible old tool-result blocks, while full
  compaction starts a lineage-linked session and preserves the prior transcript.
- **Fail-closed budgets**: model requests, tool calls, provider-reported tokens, USD spend, and every retained
  tool result are bounded per turn, and dollars, tokens, active time and elapsed time are bounded across the
  whole session tree: `--max-session-spend-usd`, `--max-session-tokens`, `--max-active-time` and
  `--max-elapsed-time` persist across REPL turns and are enforced against a file-backed root-budget ledger that
  every `pi -p` child joins, so a child's exposure is charged to the root and to every ancestor before it can
  dispatch (ADR 0026). Wall deadlines bound harness waits and bundled provider/bash paths,
  including the git workspace fingerprint taken when a bash call is dispatched, which is capped by
  the turn's remaining wall time, canceled with the turn, and killed as a process group;
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

# refuse to start unless the five tools' effects can run inside an OS sandbox
node packages/cli/dist/main.js --sandbox require -p "run the tests"

# headless: final reply on stdout, progress on stderr
node packages/cli/dist/main.js -p "review these files" --max-turns 20

# hard dollar ceiling; exact model key required, with a durable pre-dispatch reservation
node packages/cli/dist/main.js -p --pricing ./model-prices.json --max-spend-usd 0.50 "review these files"
# Every --max-* ceiling is per user turn (in -p, the turn is the run); in the REPL they reset each turn.
# The --max-session-* ceilings are per session tree: they persist across REPL turns and bound every child too.
node packages/cli/dist/main.js --pricing ./model-prices.json --max-session-spend-usd 5.00 --max-elapsed-time 3600

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
  "shutdownGraceSeconds": 10,
  "profiles": {
    "kimi": { "provider": "openai", "baseUrl": "https://api.moonshot.ai/v1", "model": "kimi-k3", "apiKeyEnv": "MOONSHOT_API_KEY" }
  },
  "extensions": []
}
```

`approval` gates those tools behind a human decision for every profile; a profile may set its own
`approval` (a list of tool names or `"*"`) to override it. This file and the `--require-approval`
flag are its only sources. `shutdownGraceSeconds` sets the SIGTERM drain window when
`--shutdown-grace` is absent.

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
| 2 | budget exceeded (per turn: `--max-turns`, tool calls, wall time, tokens, USD spend; per session tree: `--max-session-*`, `--max-active-time`, `--max-elapsed-time`) |
| 3 | incomplete or unknown terminal state |
| 4 | suspended awaiting tool approval; resume with `--approve`/`--reject`/`--edit` |
| 5 | newest resumable session is locked by another process; see `pi doctor sessions` |
| 130 | canceled by the user (SIGINT) |
| 143 | terminated by signal (SIGTERM), after either a cooperative or a forced drain |

SIGTERM is a cooperative drain, not an abort (ADR 0027). It stops admission of new model
requests and tool calls, journals a `run_drain_requested` marker, and gives whatever is already
in flight `--shutdown-grace <seconds>` (default 10; config key `shutdownGraceSeconds`) to reach a
durable terminal state. Work that settles inside the grace period leaves a `canceled` run with no
`outcome_unknown` rows; work that outlives it is aborted, and every dispatched operation without a
terminal acknowledgement stays `outcome_unknown` exactly as ADR 0007 requires. Both paths exit 143,
and `--json` names the path on the terminal row (`"drain": "cooperative" | "forced"`). The REPL
drains the same way. An extension whose tool blocks the event loop synchronously can defeat any
in-process deadline; `--supervise` covers that case for headless runs by re-executing piko as a
child in its own process group and letting the parent own the SIGKILL deadline. That parent never
opens the session journal, so the single-writer rule holds and the child's unknown rows are the
record. A fleet with its own supervisor (systemd, Kubernetes) already sends SIGKILL after its own
timeout and does not need `--supervise`.

A parent process spawning children must treat exit 4 as "forward the decision", not as failure.
A child started with `--parent-run <id>` echoes that id on every JSON row and in telemetry;
`--max-depth <n>` (default 2) with the exported `PI_DEPTH` variable refuses a piko started
past the cap with exit 1 before any model call. When the root sets a session-tree ceiling it
exports `PI_BUDGET_AUTHORITY`, and every child joins that ledger: no child can dispatch a request
the root's remaining budget does not admit, and a request with no terminal acknowledgement keeps
its full reservation on every ancestor until it is explicitly reconciled.

## Sandboxing

Piko now has an operating-system sandbox executor (ADR 0018). When a provider is available, the
five built-in tools' effects (read, write, edit, map, and bash) run inside it, in a tool worker
that is piko's own code started as a child process with the workspace as its working directory.
The control plane stays outside: model calls, credentials, the session journal, budgets,
approvals, and the agent loop all remain in the parent process.

| Provider | Platform | How |
| --- | --- | --- |
| bubblewrap | Linux, when `bwrap` is on PATH | `--unshare-all` (so there is no network namespace at all), `--die-with-parent`, `--new-session`, read-only binds of the system paths node needs, a read-write bind of the workspace, `--proc`, `--dev`, `--tmpfs /tmp` |
| Seatbelt | macOS, via `/usr/bin/sandbox-exec` | a generated deny-by-default profile: reads limited to the system trees node needs plus the workspace, writes limited to the workspace and a private temp directory, network denied, exec limited to node, `/bin/bash`, and the standard tool directories |

`--sandbox auto` (the default) uses a provider when one passes its acquire-time self-test:
inside the sandbox, reading a canary file the parent just created outside the workspace must
fail, connecting to a loopback listener the parent really opened must fail, and a marker
variable the parent really holds must be absent. A provider that fails any of the three is
released and reported, never used. `--sandbox require` exits 1 when none passes.
`--sandbox off` skips the executor entirely. One line on stderr at startup names the provider in
use or says why there is none.

What it contains: writes outside the workspace, reads of your home directory, the piko session
store, the piko configuration, and anything else outside the workspace, all network access from
tool calls, and the provider credential, which is never placed in the sandbox environment.
Because bash runs inside the boundary, `--allow-host-bash` is no longer the only way to get a
shell; when both are set the executor wins.

What it does not contain yet: seccomp system-call filtering on Linux (bwrap wants a compiled BPF
program, which would mean a native dependency, so it is deferred rather than faked); reads of
system directories such as `/usr`, `/System`, `/Library`, and `/private/etc`, which node and
bash cannot start without; a Docker provider; and Windows, which has no provider at all. There
is no contained-delegation path for headless children yet: the executor is per run.

Without a provider nothing changed. On a host where neither `bwrap` nor `sandbox-exec` is usable,
`--sandbox auto` leaves the run exactly as it was before this feature existed: workspace-confined
file tools in process, and bash absent until `--allow-host-bash` is explicit. There is no silent
fallback to host execution anywhere on the path.

The in-process path, which is what you get with no provider or with `--sandbox off`, is still the
one ADR 0022 describes: parent traversal, absolute paths, symlink escapes, and special files are
rejected by path-based checks and writes are atomic, but those checks are not race-proof. A
reproduced parent-symlink swap can defeat them, so that path is best-effort against a hostile
repository. Routing ADR 0022's containment attacks through the executor is follow-on work; the
attacks are red against the in-process path today.

Repository `AGENTS.md` and skills are ignored until `--trust-project` is explicit. Host bash is
absent until `--allow-host-bash` is explicit, and then receives a sanitized environment that
omits provider credential environment variables. That sanitization is hygiene, not a credential
boundary: a host-bash command runs as your user and can inspect the parent piko process (for
example via `ps`), including its environment. Enable host bash without a sandbox provider only
where you would run the model as yourself.

Containment also covers paths inside the workspace. `write` and `edit` refuse anything that
resolves, after symlink resolution, into `.git/`, `.pi/`, `.agent/`, or `.claude/` at any depth,
or onto workspace-root `AGENTS.md`, `.mcp.json`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`,
or `.profile`. Those are the files a hostile repository would use to make an agent persist past the
run: a git hook, an agent instruction file, a shell rc file. Reads stay allowed, and git changes go
through bash, so refusing all of `.git/` costs no legitimate workflow. The refusal names the path
and the rule it broke. `--allow-protected-paths` turns the deny list off for a run and prints a
warning.

`--allow-host-bash` on a host with no sandbox provider is still not an OS sandbox: commands can
access host files and network using the process user's authority. For untrusted autonomous work
there, run the built CLI inside a container or microVM with a project-only mount and an egress
policy. Keep the provider credential in a separate control-plane proxy or use a short-lived
scoped credential; merely injecting a permanent key into the same container is not strong
isolation.

Tool extensions are trusted controller code, not sandboxed model tools. Modules named in config or
passed with `--ext` execute in the CLI process and can use the process user's filesystem, network,
and environment authority. Schema validation limits what they advertise to the model; it does not
make their JavaScript safe. The sanitized bash environment only withholds credential environment
variables from the child process—it cannot stop a command or extension from reading credentials
that are otherwise accessible on disk.

Piko does not yet ship a container or microVM provider, so on a host where neither bubblewrap nor
Seatbelt is usable, host bash remains an explicit trusted-environment capability.

## Maturity

Piko is an experimental, pre-1.0 framework. Its current local evidence includes unit, integration,
fault-injection, packaging, and prompt-budget checks, plus an eval runner that writes versioned
per-trial artifacts. It has not had an independent security audit, ships its first OS sandbox
providers (bubblewrap and Seatbelt) without seccomp filtering or a container provider, and has no
published representative industry benchmark. Approval rules match a tool call's own arguments and
nothing more: they cannot see a command's effect on a file another tool edited, and a denied or
rejected call is not a sandbox; containment still does that work.
APIs are unstable until a compatibility policy is published. The journal now carries an explicit
schema generation: sessions written before the marker are read as generation 1, and a file
declaring a newer generation is refused rather than half-understood.
Workspace packages are intentionally marked private and must not be published until the owner
chooses a license and release policy.
See the [evaluation methodology](docs/evaluation.md) for pass criteria, artifact contents, and the
distinction between the legacy Terminal-Bench adapter and current Harbor-based benchmarks. See
[SECURITY.md](SECURITY.md) for the trust boundaries and responsible-disclosure guidance.
See the [scoped threat model](docs/threat-model.md) for the assets, the trust boundaries, the
attacker capabilities considered, the control-to-test map behind each claim on this page, and the
list of what is explicitly out of scope.

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
