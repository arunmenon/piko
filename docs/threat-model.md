# Scoped threat model

Status: 2026-09-02. Written for maturity plan T2 section 5a, whose exit
criteria name "a scoped threat model (assets, trust boundaries, attacker
capabilities inside and outside the sandbox) committed under docs/".

Scope is the tree this file is committed on, not a roadmap. Every control
below is one that exists in `packages/` today, cited to the ADR that decided
it and to a named automated test that proves it. Where a control is decided
but not proven, or proven only on one platform, the row says so. Section 6
lists what is out of scope and what is still open; nothing in sections 1
through 5 should be read as covering anything section 6 names.

Companion documents: `SECURITY.md` for disclosure, `docs/adr/` for the
decisions, `docs/adr/evidence/` for the clause-to-test maps, and
`docs/reviews/2026-09-02-red-team-review.md` for the adversarial reading this
model was written against.

## 1. Assets

What an attacker would want, in the order the damage matters.

| Asset | Where it lives | Loss looks like |
|---|---|---|
| The user's provider credentials | The parent process environment only, named in config by variable name | A key is exfiltrated and billed by someone else |
| The workspace | The directory piko was started in, mounted read-write into the sandbox when there is one | Code is modified, or a persistence hook is planted that runs on the user's next commit or next run |
| The session store and journal | `~/.pi/sessions/`, owner-only files outside every sandbox mount | The audit record becomes a fiction: the model edits its own history, or a crash is reported as a clean run |
| The budget ledger | `~/.pi/budgets/<rootRunId>.json`, outside every sandbox mount | A ceiling stops meaning anything and a tree spends without bound |
| The host outside the workspace | The user's home directory, `~/.config/pi`, ssh keys, the rest of the filesystem | Host files are read into model context and sent to the provider, or host files are written |
| The network | Any egress from a tool call | Workspace contents or credentials leave the machine, or the model fetches an attacker's payload |

The two assets that are easy to underrate are the journal and the ledger.
Every durability, cost, and audit claim piko makes reduces to "the model
cannot write these two files". That is why they are physically outside the
mount rather than protected by a rule (ADR 0018 non-negotiables).

## 2. Trust boundaries

Five boundaries. Each one has a side that is trusted and a side that is not,
and a mechanism that decides what crosses.

**The model's output.** Everything the provider returns is untrusted data,
including tool calls. It is never policy. Tool arguments are validated
against the tool's schema before dispatch, the tool-call budget is charged
before dispatch, approval is evaluated at dispatch on the exact arguments the
tool will receive, and only then does an effect happen (ADR 0011, and
`Agent.dispatchToolExecution` as the single branch described in 0018's
shipped addendum).

**Project content under `--trust-project`.** `AGENTS.md`, `.agent/commands`,
and `.agent/skills` are ignored unless the flag is present. With the flag they
are byte-bounded and delimited as project-supplied instructions, and they are
framed as task guidance that cannot relax tool policy, approval policy,
sandbox policy, or budgets (ADR 0006, 0011 decision 1, 0018). A repository
cannot widen the rule that exists to contain it.

**Extensions.** Modules named by `--ext` or by user config run in the parent
process with the process user's authority. ADR 0012 names this trust level
rather than implying it: a malicious extension is game over by definition.
Extensions are never auto-discovered and never loaded from project content;
they are validated for shape, duplicate names, and aggregate schema bytes, and
compiled JavaScript only. A `@sha256:` pin records which bytes were trusted.

**The sandbox boundary.** With a provider available (bubblewrap on Linux,
Seatbelt on macOS) the five built-in tools' effects run inside a tool worker
that is piko's own built code, started as a child process with the workspace
as its working directory and speaking newline-delimited JSON over stdio. Only
tool effects cross inward. Everything the boundary exists to protect stays
outward: model calls, credentials, the journal, budgets, approvals, and the
agent loop (ADR 0018 shipped addendum).

**The control plane.** The parent piko process is trusted. It holds the
session lock, the budget ledger, the credential, and the decision logic. The
library surface enforces this structurally rather than by convention: a
`SessionView` has no append methods and a `LockedSession` is obtainable only
through `Session.openLocked()`, with a module-private owner token verified on
every append (ADR 0023).

## 3. Attacker capabilities considered

Three attackers, described by what they can do rather than by who they are.
They compose: the realistic case is a hostile repository whose content steers
a model into writing a file that a later run loads.

### 3.1 A hostile repository

Controls every byte of the workspace before piko starts, and can change bytes
during a run through a concurrent process the user did not notice.

- Plants prompt injection in source comments, README files, test fixtures,
  and, under `--trust-project`, in `AGENTS.md` and skill files. The 2026
  literature the ADRs cite puts injected-rule-file command execution at up to
  84% against comparable editors and adaptive injection above 85% against
  filter defenses, which is why containment here is architectural rather than
  a filter (0006 Research).
- Plants a persistence payload inside the workspace: `.git/hooks/pre-commit`,
  `.git/config` with `core.hooksPath` or `core.pager`, `AGENTS.md`, `.agent/`,
  `.claude/`, `.mcp.json`, or a shell rc file in a workspace that happens to
  be a home directory.
- Races the file tools: swaps a validated parent directory for a symlink
  pointing outside the workspace between the containment check and the
  operation.
- Ships a symlink, a FIFO, a device node, or a deep alias that spells an
  out-of-workspace target.

### 3.2 A hostile model output

The provider, or an injection that reached it, emits tool calls chosen by an
adversary rather than by the task.

- Reads paths outside the workspace, absolute or traversing.
- Writes the persistence payloads above.
- Runs `bash` to read `/proc/self/environ`, `ps eww $PPID`, `env`, or the
  user's dotfiles, and to open a network connection.
- Rewrites `~/.pi/sessions/*.jsonl` so a failed run reads as a clean one, or
  deletes a session lock so a second writer is admitted.
- Rewrites `~/.pi/budgets/<id>.json` so its own ceiling disappears.
- Spawns children in a loop to multiply spend, or to escape a per-turn cap by
  splitting work across turns.

### 3.3 A hostile extension

Code the user installed and named explicitly.

- Runs arbitrary JavaScript in the parent process at import time, before any
  approval gate exists to stop it.
- Reads the credential from `process.env`, opens the network, writes anywhere
  the user can write.
- Blocks the event loop synchronously, defeating any in-process deadline.

This attacker is not contained. ADR 0012 says so in terms, and the research
addendum records the measured base rate (520 of 17,022 surveyed skills
carrying issues, 83 confirmed malicious). The controls that exist are
provenance and bounds, not confinement.

### 3.4 Inside versus outside the sandbox

Inside the sandbox, the attacker is whatever the tool worker will do: a
process with the workspace read-write, a private temporary directory, no
network namespace at all on Linux, a deny-by-default Seatbelt profile on
macOS, and no credential in its environment. Outside the sandbox, the attacker
is whatever the parent process will do on the model's behalf, plus, when
`--allow-host-bash` is set without a provider, a shell running as the user.
The interesting boundary case is the third: on a host where no provider is
usable, the attacker inside and the attacker outside are the same attacker.

## 4. Controls, by asset

Test names are the stable evidence identifiers; `npm test` runs them all. A
test marked "provider-gated" runs only where a sandbox provider exists and
skips with a stated reason elsewhere, which today means the Linux rows are
proven in CI and not on a macOS development host, and vice versa.

### 4.1 The user's credentials

| Control | ADR | Test |
|---|---|---|
| Config stores the environment variable name, never the key | 0016 | `apiKeyEnv rejects strings that are not environment variable names` (`packages/core/tests/telemetry-secrets.test.ts`) |
| The key leaves only as the auth header to the configured endpoint | 0016 | `credential.attach reports the environment variable name for both providers`; `a keyless endpoint emits no credential.attach: nothing was attached` (same file) |
| Telemetry never carries the value, even with redaction disabled | 0013, 0016 | `the credential value never reaches telemetry even with redaction disabled` (same file) |
| Bash children get a sanitized allowlist environment; credentials are not inherited | 0006, 0016 | `bash inherits a minimal environment and omits credentials by default`; `bash policy can explicitly inject environment without inheriting other variables` (`packages/core/tests/tools.test.ts`); `policy.env_sanitized reports the names bash withheld from the child` (telemetry-secrets) |
| No credential is present in the sandbox environment at all | 0016, 0018 | `a secret in the parent environment is absent inside the sandbox` (`packages/core/tests/executor.test.ts`, provider-gated) |
| Session transcripts are owner-only, because tool output can carry secrets the user chose to expose | 0015, 0016 | `UUID creation is exclusive and session files are owner-only` (`packages/core/tests/session.test.ts`) |

Residual: with `--allow-host-bash` and no provider, a command runs as the user
and can read the parent process environment through `ps` or `/proc`. The
warning says so. The sandbox is the answer, and where it is unavailable there
is no answer.

### 4.2 The workspace

| Control | ADR | Test |
|---|---|---|
| Paths resolve against a workspace root; traversal and absolute paths are rejected | 0006 | `file tools reject parent traversal and absolute paths by default`; `absolute-path opt-in still confines canonical targets to the workspace` (`packages/core/tests/tools.test.ts`) |
| Symlink escapes are rejected for existing and new targets | 0006 | `file tools reject symlink escapes for existing and new targets` (same file) |
| Special files are refused without being opened | 0006 | `read, write, and edit reject special files without opening them` (same file) |
| Protected paths inside the workspace are unwritable: `.git/`, `.pi/`, `.agent/`, `.claude/` at any depth, and the root `AGENTS.md`, `.mcp.json`, and shell rc files | 0006 addendum | `write and edit refuse every protected path inside the workspace`; `a nested .git directory deeper in the tree is protected too`; `ordinary files beside the protected ones stay writable` (same file) |
| A symlink alias cannot launder a protected target | 0006 addendum | `a symlink alias inside the workspace does not launder a protected path` (same file) |
| Case folding is decided by the filesystem, not the platform | 0006 addendum | `a case-sensitive filesystem keeps .Git writable while .git stays refused`; `a case-insensitive filesystem refuses every spelling of a protected path` (same file) |
| Reads of protected paths stay allowed, because reading does not create persistence | 0006 addendum | `reads of protected paths stay allowed` (same file) |
| Project content cannot relax any of this | 0006, 0011 | `project instructions are opt-in` (`packages/cli/tests/cli.test.ts`); `AGENTS.md is byte bounded and explicitly delimited`; `project instructions and skills cannot read host files through symlinks` (`packages/core/tests/prompt.test.ts`) |
| A parent-symlink swap during a file operation fails closed | 0022 | Not proven. The eight acceptance tests exist in `packages/core/tests/containment.test.ts` and are marked `todo`: they perform the real attack and fail on the in-process path by design. The one passing test is the positive control, `positive control: a plain symlink escape out of the workspace is refused today`. See `docs/adr/evidence/0022-containment-test-map.md` |

### 4.3 The session store and journal

| Control | ADR | Test |
|---|---|---|
| The store is never inside a sandbox mount; a run whose session directory would land inside the workspace is refused a sandbox rather than given a leaky one | 0018 | `the sessions directory is not visible inside the sandbox` (`packages/core/tests/executor.test.ts`, provider-gated); `the sandbox is refused when the session store would sit inside the workspace` (`packages/cli/tests/cli.test.ts`) |
| The worker policy carries containment fields and never control-plane state | 0018 | `the worker policy carries containment and never the control plane` (executor.test.ts) |
| No public API yields an unlocked mutable session; a forged owner token is rejected at append | 0023 | `0023 acceptance: no public API yields an unlocked mutable session` (`packages/core/tests/session.test.ts`); see `docs/adr/evidence/0023-lock-capability-test-map.md` |
| The lock is exclusive and owner-only; a hard link cannot mint a second writer | 0015, 0023 | `session locks are exclusive, owner-token protected, and owner-only`; `hard-linked journal cannot bypass single-writer (owner review repro)` (session.test.ts) |
| A crash leaves a loud, recoverable stop rather than a silent wrong-session resume | 0024 | `0024 acceptance: crash leaves a lock, selection fails loudly, doctor recovers, selection resumes` (session.test.ts); `0024 CLI acceptance: crash, exit 5 with typed JSON, doctor list, recovery, resume` (`packages/cli/tests/doctor.test.ts`) |
| Invalid middle rows fail closed; only a corrupt partial tail is repaired, and the repair is itself a row | 0015 | `open rejects corrupt or schema-invalid rows anywhere except a partial JSON tail`; `0015: a crash-shaped partial tail leaves a durable repair row with its byte counts` (session.test.ts) |
| An uncertain write poisons the handle instead of continuing | 0015 | `an append failure poisons that Session object until the journal is reopened` (session.test.ts) |
| A tool that started with no terminal row is `outcome_unknown`, never "did not run" | 0007, 0027 | `a forced drain leaves the unsettled tool outcome_unknown, the run canceled, and exits 143`; `--supervise kills a blocking extension at the deadline and the journal reopens outcome_unknown` (`packages/cli/tests/shutdown.test.ts`) |
| A cooperative drain produces a clean `canceled` run with no unknown rows | 0027 | `a cooperative drain lets an in-flight tool settle: canceled, no unknown rows, exit 143`; `a fleet-style SIGTERM between operations leaves no unknown rows` (shutdown.test.ts) |
| An approval decision is a journal row, so it survives a crash and a reboot | 0011 | See `docs/adr/evidence/0011-approval-test-map.md`, rows for decisions 3 and 4 |

Residual, and it is the sharpest one in this document: with
`--allow-host-bash` and no sandbox provider, the model can delete or rewrite
the lock file and the journal directly. ADR 0023 is honest against a second
piko process, not against the model. The sandbox mount rule is what makes the
control plane a boundary rather than a convention, and it holds only where a
provider is usable.

### 4.4 The budget ledger

| Control | ADR | Test |
|---|---|---|
| One root ledger per session tree, outside the workspace, with atomic reserve and reconcile under a lock | 0026 | `reserve and reconcile keep the tree exposure exact, and an unknown outcome retains it` (`packages/core/tests/budget-authority.test.ts`) |
| A child's exposure is charged to itself, every ancestor, and the root | 0026 | `a child's exposure is charged to itself, to every ancestor, and to the root` (same file) |
| Two REPL turns cannot exceed the session cap | 0026 | `two REPL turns cannot exceed the session cap while each alone passes the per-turn cap` (same file) |
| Concurrent children never admit more than the root allows | 0026 | `twenty concurrent children never exceed the root, and no reservation is lost or double counted` (same file) |
| An unknown outcome keeps its full reservation until explicitly reconciled | 0026 | `a child killed after reserving keeps its exposure until an explicit reconcile` (same file) |
| A child joins the tree through `PI_BUDGET_AUTHORITY`, set explicitly per call so a stale path cannot reach a foreign tree | 0026 | `PI_BUDGET_AUTHORITY names the tree a child joins and reaches every bash child` (same file); `a headless child joins the inherited tree and is refused once the root is exhausted` (`packages/cli/tests/session-budget.test.ts`) |
| Active time and elapsed time are separate ceilings | 0026 | `active time and elapsed time are separate ceilings` (budget-authority.test.ts) |
| Spend is reserved before dispatch, so no request is billed past the ceiling | 0009, 0020 | `spend reservation stops a later provider request before it can be billed` (`packages/core/tests/budget.test.ts`); see `docs/adr/evidence/0020-pricing-test-map.md` |
| A capped run with an unpriceable model refuses to start | 0020 | `a spend ceiling refuses an unpriceable model before provider dispatch` (budget.test.ts); `--max-session-spend-usd creates a tree, reports it, and requires an exact price` (session-budget.test.ts) |
| Nesting depth is capped and a malformed inherited depth is refused | 0004 | `a child started past the depth cap exits 1 before any provider request`; `a malformed inherited depth is refused rather than guessed` (`packages/cli/tests/child-bounds.test.ts`) |

The ledger file is written `0600` in a `0700` directory (ADR 0026 addendum).
No test asserts those modes; the claim rests on the record and the source,
not on evidence.

### 4.5 The host outside the workspace

| Control | ADR | Test |
|---|---|---|
| Nothing outside the workspace is readable from inside the sandbox, home directory and config included | 0018 | `a canary outside the workspace is unreadable through read`; `a canary outside the workspace is unreadable through bash` (executor.test.ts, provider-gated) |
| Nothing outside the workspace and the private temporary directory is writable | 0018 | `the workspace is writable through the sandbox` plus the canary reads above; the bubblewrap argv binds only the workspace and the private temp read-write, and the Seatbelt profile's `file-write*` names only those two plus the usual writable character devices |
| A provider that does not actually contain is never used | 0018 | `the self-test refuses a provider whose sandbox is deliberately broken` (executor.test.ts, provider-gated) |
| There is no silent host fallback | 0018 | `--sandbox off keeps today behaviour: no executor, and bash stays disabled`; `--sandbox auto and require agree with what this host can actually provide` (cli.test.ts); `selectSandboxExecutor reports no executor when no provider is available` (executor.test.ts) |
| Host bash is deny-by-default and its persisted cwd is revalidated per call | 0006 | Covered by the bash environment and containment tests in `packages/core/tests/tools.test.ts` |

### 4.6 The network

| Control | ADR | Test |
|---|---|---|
| No network from inside the sandbox | 0018 | `a network connect from bash inside the sandbox fails` (executor.test.ts, provider-gated) |
| On Linux the network namespace is absent by construction, so there is no egress allowlist to get wrong | 0018 | `--unshare-all` in `packages/core/src/executor/bubblewrap.ts`; proven by the connect test above where bwrap is present |
| On macOS the profile denies networking outright | 0018 | `(deny network*)` in `seatbeltProfile`, `packages/core/src/executor/seatbelt.ts`; proven by the same connect test |
| The model never reaches the provider from inside the boundary; model calls are made by the parent | 0018 | `the worker policy carries containment and never the control plane` (executor.test.ts) |

Outside the sandbox, there is no network control at all. Host bash can reach
anything the user can reach. That is the point of the flag and the warning.

### 4.7 Extensions, across assets

| Control | ADR | Test |
|---|---|---|
| Loaded only when explicitly named; never auto-discovered, never from project content | 0012 | `config extension paths are config-relative while explicit CLI paths remain cwd-relative` (`packages/cli/tests/extensions.test.ts`) |
| Shape, duplicate names, aggregate schema bytes, and compiled-JS-only validated at load | 0012 | `loadExtensions validates every exported tool`; `loadExtensions rejects duplicate names across extension modules`; `loadExtensions applies the aggregate schema byte policy`; `TypeScript extension sources fail clearly on the supported Node 20 runtime` (same file) |
| A `@sha256:` pin is checked before import and refuses on mismatch | 0012 addendum | `a mismatched sha256 pin refuses the extension and names both digests` (extensions.test.ts); `a mismatched pin refuses to start with exit 1 and no session row` (`packages/cli/tests/extension-pins.test.ts`) |
| A swap inside the read-import window is detected after the fact and refuses the run | 0012 addendum | `an entry module that changes between the two reads refuses to start` (extension-pins.test.ts) |
| Every load is journaled with the entry module's digest | 0012 addendum | `a pinned extension loads and is journaled with its digest`; `an unpinned extension is journaled too, marked unpinned` (extension-pins.test.ts) |
| Extension tools are not routed into the executor; an extension named `read` stays parent-process controller code | 0012, 0018 | Routing is by object identity in `Agent.dispatchToolExecution`, recorded in 0018's shipped addendum |

## 5. What the model of section 4 assumes

Three assumptions, stated so a reviewer can attack them.

1. The parent process is not already compromised. Everything in section 4.3
   and 4.4 is enforced by the parent. An extension, or host bash, breaks this
   assumption directly.
2. A usable sandbox provider exists. Every provider-gated row above is
   unproven and largely unenforced on a host without `bwrap` or
   `sandbox-exec`. The default `--sandbox auto` degrades to the pre-executor
   behaviour there and says so on stderr; `--sandbox require` is the way to
   turn the assumption into a precondition.
3. Session directories are on a local filesystem. The lock is undefined on
   NFS and SMB, and piko does not detect a network filesystem (ADR 0024
   addendum).

## 6. Out of scope and still open

Nothing below is claimed to be covered. Several are deliberate deferrals with
a record; the rest are honest gaps.

**No seccomp on Linux.** bwrap takes a compiled BPF program on a file
descriptor. Shipping one would mean either a native dependency, which the
zero-dependency property forbids, or a hand-assembled filter nothing in this
repository can test. Deferred and named as deferred (0018 shipped addendum).
The Linux sandbox therefore restricts the filesystem and the namespaces, not
the system-call surface.

**Seatbelt is a deprecated Apple interface** with no supported replacement for
this use. That is a real dependency risk, not a hypothetical one.

**`/usr`, `/System`, `/Library`, `/private/etc`, and `/dev` are readable
inside the macOS sandbox** because node and bash cannot start without them,
so system configuration such as `/etc/hosts` remains readable from inside.
What is not readable is the user's home directory, the session store, the piko
configuration, and anything else outside the workspace. The Linux provider
binds a comparable read-only set (`/usr`, `/bin`, `/sbin`, the library
directories, and a short list of `/etc` entries).

**No Docker provider and no microVM provider.** The seam is designed for them;
neither is built.

**No Windows.** There is no provider, and supported hosts are macOS and Linux
because session durability and host-bash cancellation rely on POSIX
semantics.

**Host bash with `--allow-host-bash` runs as the user.** No namespace, no
profile, no filter. It can read the parent process environment, the session
store, the budget ledger, and the credential material on disk. The sanitized
child environment is hygiene, not a boundary, and ADR 0016 says so.

**The in-process file tools are not race-proof.** ADR 0022's parent-symlink
swap is reproduced and open on that path. The eight acceptance tests are
written and red by design; the recorded mechanism is the executor path, and
routing those attacks through the worker is follow-on work. Until that lands,
the in-process path is best-effort against a hostile repository, not a
boundary.

**Extension pins cover the entry module only.** Transitive imports are not
hashed and can change with no effect on the digest and no refusal
(`a transitive import is outside what the pin covers`). A pin says "these
entry bytes", not "this dependency closure". Detection of a swap inside the
read-import window is after the fact: the module's top level has already run.
And pinning a malicious module changes nothing about what it can do.

**The budget bound is conservative.** The reservation uses a byte-derived
input bound plus the enforced output cap, which on long contexts stops work at
roughly half a ceiling's nominal value. The tokenizer-based bound ADR 0026
allows is not taken, because no committed corpus proves one conservative.
Time ceilings are checked at admission, not on a timer, so a tree that exceeds
`maxActiveTimeMs` mid-tool-call is stopped at the next provider request.

**Concurrency of children is unbounded.** Nothing limits how many children may
run at once. Depth is capped and spend is admitted against the root, but the
count is not bounded (ADR 0026 addendum, "Also not atomic, deliberately").

**No external audit.** Piko has not had an independent security review. The
2026-09-02 red-team review is an adversarial reading of the records against
the field, not a penetration test, and it is the strongest external evidence
that exists.

**Also not covered here:** supply-chain integrity of the npm dependency graph
(there are no third-party runtime packages, but the toolchain is not
attested); a compromised model provider or a man-in-the-middle on the provider
endpoint; the physical machine and the user's account; denial of service
against the host; and the approval gate's blind spot, which is that a rule
reads a tool call's own arguments and cannot see a command's effect on a file
another tool edited (ADR 0011's argument-prefix addendum, "What a rule cannot
see").
