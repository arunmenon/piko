# 0018 — Container sandbox executor behind a provider seam

Status: accepted (2026-09-02 by owner delegation, "take the recommendations"; proposed 2026-08-24; amended below)
Depends on: 0004, 0006, 0009, 0016

## Context

0006 named OS-level isolation as the next layer and was honest that in-harness
checks are not a sandbox. The exoharness/exo study sharpened both the target
and the anti-pattern: their narrow verb seam over many sandbox providers is
the right shape, but their canonical local setup bind-mounts the repository
root — including the event log's storage directory — read-write into the
agent's own sandbox, leaving the system's one claimed invariant protected by
convention. Separately, 0006 left the contained default with no delegation
path: sub-agents (0004) require `--allow-host-bash`.

## Decision

A `SandboxExecutor` implementing the existing tool-execution boundary, with a
deliberately narrow provider seam: `acquire(image) → id`,
`exec(id, cmd, limits) → output`, `release(id)`. Snapshot/rewind is deferred
to a follow-on decision (it is the soak chamber for 0017 v2, not needed for
v1). Docker is the only shipped provider; the seam is designed so Firecracker
or remote providers are additive, never assumed.

Non-negotiables, enforced by construction:

- Only the workspace is mounted into the sandbox. The session store, journal,
  configuration, and credentials are never inside any sandbox mount — the
  invariant layer stays physically below the layer the model can write.
- Egress is default-deny with an explicit allowlist; provider credentials
  follow 0016 (attached at the call boundary by the harness, never present in
  the sandbox environment).
- Sandbox and egress policy follow 0011's provenance rule: set only from user
  config and CLI flags — never by project content under `--trust-project`, by
  extensions, or by an improve run (0017). A repository must not be able to
  widen its own allowlist.
- 0009 budgets are enforced loop-side regardless of executor; a sandbox is
  containment, not a budget.
- Contained spawn: headless children (0004) execute inside sandboxes, so the
  contained default regains a delegation path without granting host bash —
  closing the gap recorded in 0004's addendum.

## Consequences

- "Safe on untrusted repositories" graduates from documentation to mechanism,
  and sub-agents work with host bash disabled.
- Costs: a Docker dependency and its platform matrix; per-exec latency; the
  seam is a new API surface to version; snapshot capability — and therefore
  0017's stronger canary — waits for the follow-on decision.
- The workspace-only mount rule constrains future features: anything that
  wants the model to read harness state must export it into the workspace
  explicitly, never widen the mount.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- corroborates: "Sandlock", Wang & Zheng, arXiv 2605.26298, 2026. Unprivileged
  Landlock and seccomp confinement for agent code, with static filesystem and
  port policy, supervisor-mediated egress with resolved-endpoint allowlists and
  DNS pinning, at about 5 ms startup against Docker; a research precedent for a
  lightweight first provider.
- corroborates: "Firecracker", Agache et al., NSDI 2020. The microVM reference
  for the additive provider this seam anticipates.
- corroborates: "The True Cost of Containing", Young et al., HotCloud 2019.
  gVisor costs more than 2 times in syscall overhead, which prices the heavier
  isolation options against the lighter ones.
- challenges: "Quantifying Frontier LLM Capabilities for Container Sandbox
  Escape", Marchand et al., UK AISI, arXiv 2603.02277, 2026. Frontier models
  comfortably escape misconfigured containers across 18 scenarios, about 40% at
  medium difficulty and 0% at the hardest, with success scaling log-linearly in
  compute. A plain container is not a security boundary unless hardened, so this
  record's non-negotiables need tests rather than prose.

## Amendment (2026-09-02, R0-1 provider order; accepted 2026-09-02 by owner delegation)

Drafted from the 2026-09-02 red-team review and section 4 of
docs/red-team-remediation-plan-2026-09.md. This is a draft for the owner to
accept or reject. It changes nothing until the owner records the decision; the
Decision text above stands exactly as proposed until then.

- Provider order. The first provider is the lightweight one: bwrap plus seccomp
  on Linux and Seatbelt on macOS, or `@anthropic-ai/sandbox-runtime` taken as a
  dependency. Docker becomes the second provider, for CI. Per-exec Docker
  latency on a macOS development host is a virtual-machine round trip for every
  `ls`, which is the wrong default for interactive work and the reason a
  Docker-first seam has not shipped.
- The cost is stated plainly: a native or third-party sandbox dependency ends
  the zero-dependency property for that provider. The owner is choosing between
  that and a default nobody runs.

## Amendment (2026-09-02, R0-2 file tools inside the executor; accepted 2026-09-02 by owner delegation)

Drafted from the same review and plan section. It changes nothing until the
owner records the decision.

- Where the tools run. All five tools' effects execute inside the executor, the
  file tools included, while the control plane (session store, journal,
  approvals, budgets) stays outside it. An executor that only runs commands
  leaves 0022 needing a native helper regardless, so the whole-process shape is
  what makes the seam worth its cost.
- Fail-closed is hard-coded, not a flag. When no usable provider is found the
  run refuses to start rather than falling back to host execution.
- The egress proxy is designed as the credential injection point from the
  start, even though v1 networking is none, so credentials are injected at the
  boundary rather than merely absent from the sandbox environment (0016).
- Host bash gets a fresh PID namespace on Linux wherever bwrap is present, which
  closes the read of the parent process environment that 0016 records as
  residual risk.

## Addendum (2026-09-02, first executor: bubblewrap and Seatbelt providers, tool worker)

What shipped, in `packages/core/src/executor/`.

The seam is the one this record names: `SandboxProvider` with
`acquire(spec) -> handle`, `exec(handle, request) -> result`, and
`release(handle)`. `bindSandboxExecutor` pairs an acquired handle with the
provider that made it; that pair is what `ToolExecutionPolicy.executor` carries,
so the agent loop never sees a provider, a spec, a mount, or a profile.

The thing inside the sandbox is a tool worker: piko's own built code
(`packages/core/dist/executor/worker.js`, produced by the ordinary `tsc -b`)
started as a child process with cwd at the workspace root, speaking
newline-delimited JSON over stdio. The worker writes a `ready` line carrying a
protocol version the parent refuses to guess about, then answers
`{id, tool, arguments, policy, cwd}` with `{id, result, cwd, observations}`. It
hosts the five existing tool implementations in-process, so read, write, edit,
map, and bash all execute inside the boundary with no second implementation to
keep in step. `cwd` travels both ways because bash's `cd` persistence is state
the parent stays authoritative over. `observations` exists because telemetry is
control plane: the worker records what the sanitized-environment policy withheld
and the parent replays it through its own observer.

The worker's environment is the sanitized allowlist from `tools/bash.ts`, built
by the parent, with `TMPDIR`/`TEMP`/`TMP` redirected into a private temporary
directory the sandbox owns. It therefore never receives provider credentials.
The session store is not made visible: `~/.pi` is not bound on Linux and not in
the read allowlist on macOS, and `selectSandboxExecutor` refuses to offer any
sandbox at all when this run's session directory would land inside the workspace
(a home directory opened as the workspace), rather than shipping a mount that
contains the journal.

Where the effect happens moved; nothing else did. `Agent.dispatchToolExecution`
is the single branch, taken after argument validation, the tool-call budget,
approval, the abort check, and the workspace digest have all run in the parent.
Only the five built-in implementations are routed, matched by object identity
rather than by name, so an extension tool called `read` stays trusted controller
code in the parent process (0012). With no executor the in-process path is
unchanged, byte for byte.

Providers. Linux is bubblewrap: `--unshare-all --die-with-parent --new-session`,
`--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, read-only binds of the system
paths a dynamically linked node needs plus the resolved node install prefix and
piko's own package root, a read-write bind of the workspace at its own path and
of the private temporary directory, and `--chdir <workspace>`. Networking is
absent by construction because `--unshare-all` includes the network namespace,
so there is no egress allowlist to get wrong. macOS is Seatbelt through
`sandbox-exec -p <profile>` with a generated profile: `(deny default)`,
`(deny network*)`, `process-fork` and `process-exec` limited to the node bin
directory, `/bin/bash`, and the standard tool directories, `file-read*` over the
system trees plus the node prefix, piko's package root, the workspace, and the
private temporary directory, and `file-write*` over the workspace, the private
temporary directory, and the usual writable character devices.

Two Seatbelt details were determined empirically on macOS 26.3 (build 25D125,
node v23.8.0) and are load-bearing rather than decorative. First, node aborts in
`node::InitializeOncePerProcessInternal` unless the root directory node itself is
readable, so the profile carries `(allow file-read* (literal "/"))`, which grants
the root entry and nothing below it. Second, node canonicalises its entry script
with `realpath`, which lstats every path component, so each ancestor of each
allowed tree needs `file-read-metadata` even though its contents stay
unreadable; the profile generator emits those ancestors. A blanket
`(allow sysctl-read)` was tightened to a named list by removing it until node
aborted in `node::os::GetOSInformation` and re-adding names until it started
again; `NODE_STARTUP_SYSCTL_NAMES` is that list, and everything else is denied.
`(allow mach-lookup)` turned out not to be needed at all and is not granted.

Fail closed, and proved rather than assumed. A provider is usable only if its
binary exists and an acquire-time self-test passes inside the sandbox: reading a
canary file the parent just created outside the workspace must fail, connecting
to a loopback listener the parent really opened must fail, and a marker variable
the parent really holds must be absent. Each check is written so that any
failure to perform the forbidden action counts as a pass and only an
unambiguous success counts as a failure. A provider that acquires but fails a
check is released and reported, never used. If no provider is usable, behaviour
is exactly today's: bash disabled unless `--allow-host-bash`, file tools in
process. There is no silent host fallback anywhere on the path.

CLI. `--sandbox auto|off|require`, default `auto`. `require` exits 1 with a
one-line reason when no provider passes; `off` is today's behaviour. One stderr
line at startup names the provider in use or says why there is none. Bash is
available when either gate allows it: `bash.allowHostExecution` for the host
shell as before, and a new `bash.sandboxedExecution` for the shell inside the
executor. They are separate fields because they enable different shells, and the
sandboxed one is not an opt-in to the host; when both are set the executor wins
and the CLI says so instead of printing the host-bash warning.

Divergence from the R0-2 amendment, recorded rather than quietly taken. That
amendment says fail-closed means the run refuses to start when no provider is
found. This first executor refuses only under `--sandbox require`; under the
default `auto` a host with no provider gets exactly the contained behaviour it
has today. Refusing to start would have made piko unusable on every host without
bwrap or Seatbelt the day this landed, including Windows and containers without
user namespaces, so the flag carries the choice and the stderr line makes the
weaker state legible. `auto` is the default and `require` is one flag away.

Deferred, and named as deferred. Seccomp is not attempted: bwrap takes a
compiled BPF program on a file descriptor, and shipping one would mean either a
native dependency, which the zero-dependency property forbids, or a
hand-assembled filter nothing in this repository can test. There is no Docker
provider and no Windows provider. The egress proxy that 0016 wants as the
credential injection point is not built, because v1 networking is none and there
is nothing yet to inject through. Snapshot and rewind stay deferred as the
original decision says. Contained delegation for headless children (0004) is not
wired: this executor is per-run, not per-child.

Limitations found on this macOS host, stated plainly. The Seatbelt profile
grants read over `/usr`, `/System`, `/Library`, `/private/etc`, and `/dev`
because node and bash cannot start without them, so system configuration such as
`/etc/hosts` remains readable inside the sandbox. What is not readable is the
user's home directory, the session store, the piko configuration, and anything
else outside the workspace, and nothing outside the workspace and the private
temporary directory is writable. Seatbelt is also a deprecated Apple interface
with no supported replacement for this use, which is a real dependency risk
rather than a hypothetical one. The Linux provider is written but was not
executed on this host: its tests skip with a stated reason where `bwrap` is
absent, and CI is where they run.

ADR 0022's eight containment attacks are deliberately not routed through the
executor in this change; they remain red against the in-process path, and the
follow-on that runs them through the worker is what closes 0022's addendum.

### What the first CI run taught, 2026-09-03

Two things the developer host could not have shown, both fixed in place.

The Seatbelt profile was built from directory names, and a hosted macOS runner
puts `bash` at a Homebrew prefix whose `bin` entry is a symlink into the package
tree. Seatbelt judges the resolved target, so `(subpath "/opt/homebrew/bin")`
permitted the link and denied the binary behind it: acquire and the self-test
both passed, and the first bash call came back as a bare `spawn EPERM` from
node, naming neither the sandbox nor the binary. The profile now derives its
exec and read rules from the binaries themselves, resolved through `realpath`
on the host the sandbox will run on: `process.execPath`, the `bash` that the
worker's own PATH search will find, and `/bin/bash`, each named as a literal
alongside its containing directory, with the package prefixes (`/usr/local`,
`/opt/homebrew`, `/opt/local`) permitted whole rather than by their `bin`.
The bubblewrap provider binds the same resolved directories read-only for the
same reason. A denied child process now reports which sandbox denied it and
that its policy has to permit the binary at its resolved path.

The Linux legs could not build a sandbox at all:
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. bubblewrap
configures loopback itself whenever it creates a network namespace and offers
no option to skip that step, and Ubuntu 24.04 with
`kernel.apparmor_restrict_unprivileged_userns=1` creates the namespace while
withholding the capability that configuration needs. The invocation is not
changed: `--share-net` would hand the sandbox the host network, dropping
`--unshare-user` only works with a setuid bwrap that the Ubuntu package is not,
and `--disable-userns` addresses something else. The provider fails closed with
the bwrap message plus a sentence saying what the host has to change, and the
run falls back to the contained in-process path. The acceptance suite treats an
unusable provider as a skip with that reason on the record rather than a
failure, which also stops one refusal from cancelling every later subtest. This
reasoning comes from bubblewrap's source and the CI output; it was not verified
on a Linux host.

### The self-test grew a fourth check, 2026-09-03

The macOS fix above was not enough. The hosted runner (macOS 26.5.2, build
25F84, arm64) still answered `spawn EPERM` for every bash call with the
resolved binaries named as literals, while acquire and all three self-test
checks passed: node started, the canary stayed unreadable, the network stayed
closed, the parent's marker stayed absent. A sandbox that hosts four working
tools and one that always fails is worse than no sandbox, because it looks like
it works and only the fifth tool tells the truth.

So the self-test now has a fourth check: the worker must be able to start a
child process, running the resolved shell as `bash -c true` through the same
detached spawn the bash tool uses. It probes twice, once by the absolute path
the parent resolved and once by the bare name the tool actually passes, and
reports both outcomes with the shell each spelling resolved to inside the
sandbox. A provider that fails it is released and reported, so
`selectSandboxExecutor` falls back to the contained in-process path and the
acceptance suite skips with the reason on the record. A runner whose profile is
wrong now shows the sandbox as unavailable and says which binary was refused,
rather than going green on a boundary that cannot run a shell.

The profile itself was widened in the exec dimension only, on the evidence of
CI probes run on that runner: an unfiltered `(allow process-exec)` with
`file-read*` and `sysctl-read` started bash without trouble there, and
`mach-lookup` turned out not to be needed. `process-exec` became
`process-exec*`, which also covers the interpreter path a script with a shebang
takes, and the filters became whole subpaths of the trees that are already
granted `file-read*` and are system-owned and read-only: `/bin`, `/sbin`,
`/usr`, `/System`, `/Library`, `/opt/homebrew`, `/opt/local`,
`/private/var/select`, plus the resolved node prefix and piko's own package
root. The resolved binaries stay as literals beside them. Nothing about writes
changed: the workspace and the private temporary directory are still the only
writable places, and reads are unchanged, so this widens nothing that the
threat model depends on.

Both the startup line and every refusal now name the two paths that matter,
`node <path>, shell <path>`, because a denial on a machine the author cannot
log into is unreadable without them.

Verified on this macOS 26.3 host, where all fifteen executor tests pass with
the new profile and the new check, and by construction for the refusal path
(two tests drive deliberately broken profiles: one that grants blanket read so
the canary check fails, one that permits only node so the child-process check
fails). Whether the widened profile fixes the hosted runner is confirmed by CI
and not by this host.
