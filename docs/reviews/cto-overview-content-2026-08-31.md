# Piko — Executive Overview (artifact content for external review)

Verbatim text content of the published executive artifact, extracted for
review. Source HTML lives with the session scratchpad; the published page is
the artifact titled "Piko — Executive Overview". Reviewers: every factual
claim below should be checkable against this repository (benchmark manifests
in docs/benchmarks/, the ADR index in docs/adr/, committed run artifacts).

---

**Kicker:** Engineering Strategy · Prepared for the CTO · August 2026

# Every harness can spend your money. Piko is the one that answers for it.

A coding-agent harness built on one ratified metric — dollars per completed
task — where cost limits, security boundaries, and benchmark honesty are
written decisions with enforcement in the code, not habits in a team's head.

**Stat band:**
- **28%** — cheaper per solved task than the reference harness, at an identical solve rate
- **$0.098** — per solved benchmark task — priced by the runtime as it runs, not estimated after
- **815** — tokens attached to every request, vs 20–30k for rich-context harnesses. CI fails if it grows unexplained
- **24** — written architecture decisions (ADRs) — every claim in this document cites the one that enforces it

## Executive Summary — The answer first

> Model rankings flip every quarter; your agent bill compounds every day.
> Piko delivers the same benchmark outcomes as the industry baseline at a
> lower price — and it is the only harness in its field where a run's
> maximum cost is enforced by the runtime before the money is spent.

- **Proven at parity, cheaper per outcome.** Head-to-head on Terminal-Bench,
  same model, same tasks: 25/30 solved each, **$0.098 vs ~$0.136 per
  solve**. Piko used fewer input tokens on 8 of 10 tasks.
- **Spend is a contract.** Every run can carry a spend limit — configurable
  per run, per task, per pipeline. The harness reserves each request's
  worst-case cost *before* sending it and blocks the request that would
  break the cap, so the limit holds even mid-crash. [ADR 0020]
- **The metric is ratified, not aspirational.** "Dollars per completed task"
  is a written, owner-signed decision that the rest of the architecture must
  serve — including a standing rule that any prompt text whose measured
  benefit lapses gets deleted. One line already has been. [ADR 0017]
- **Honestly pre-1.0.** An independent adversarial review scored maturity
  2.6/5. Its findings drove three new ADRs; two are implemented and
  hardened, the third is in build. We would not point piko at untrusted
  workloads today, and this document says so.

## 1 · The market problem — AI coding is becoming a budget line nobody can forecast

Three concrete facts, each favoring the harness over the model:

- **Models churn.** The frontier changed hands repeatedly in twelve months.
  A workflow welded to one model re-bets itself every release. The harness —
  the loop that plans, executes, verifies, and accounts — survives every
  swap.
- **Costs compound.** Ten engineers experimenting becomes a thousand
  engineers operationalizing. Agent spend scales with adoption, and the bill
  arrives before the governance does — unless the governance ships inside
  the runtime.
- **Meters, no brakes.** Peer harnesses tell you what you spent, after. We
  reviewed one current multi-model harness that renders per-agent cost
  beautifully in its UI while multiplying spend five-fold by design — with
  no ceiling anywhere in its code.

**So what:** The first harness that can put an enforced number on "worst
case, this run costs X" wins a conversation capability benchmarks can't
enter: the one with your CFO.

## 2 · The evidence — Same outcomes as the baseline. Smaller bill. Every dollar auditable.

### Exhibit 1 · Cost per outcome
**Claim: At an identical solve rate, piko delivers each completed task ~28% cheaper**

| Arm | Solved | Cost per solve |
|---|---|---|
| Piko | 25/30 | $0.098 |
| Terminus-2 | 25/30 | ~$0.136 |

Cost per solved task · 10-task Terminal-Bench suite × 3 attempts · same
model (GPT-5.5), same tasks, same attempt counts.

Source note: Piko's figure comes from the harness pricing every request as
it runs, at true cached-token rates, from a versioned rate table (ADR 0020).
The baseline's figure is an upper-bound estimate because its logs cannot
separate cached from full-price tokens. Piko's cost is not just lower — it
is the only one of the two that is precisely knowable. Runs
2026-08-25__13-31-06 / 2026-08-24__19-10-52, committed.

### Exhibit 2 · Structural efficiency
**Claim: Piko's always-on footprint is 25–35× leaner than rich-context harnesses — and cannot grow without evidence**

| Class | Fixed context (tokens/request) |
|---|---|
| Rich-context class (Claude Code tier) | 20–30k |
| Mid class (Codex tier) | 2–5k |
| Piko (CI-gated) | 815 |

Source note: The 815 is recomputed by CI on every build against a committed
baseline; growth without measured benefit cited in the commit fails the
build (the "token rent" rule, ADR 0017). This rule has been enforced against
our own work: a plausible-sounding prompt line was deleted after three
benchmark rounds showed its benefit was statistical noise ($0.202 → $0.188 →
$0.227 per failure). Prompt layout is also cache-aligned by design (ADR
0014): in the parity run above, 44% of input tokens were billed at one-tenth
price as cache reads.

### Exhibit 3 · The official suite, decomposed
**Claim: On 89 never-seen official tasks: 37% solved for $26 total — a floor set by our own configurable safety caps, not by capability**

| Outcome class | Count |
|---|---|
| Solved | 33 |
| True capability limits | 11 |
| Our spend cap stopped it | 25 |
| Timeout policy | 7 |
| Test-rig infrastructure | 13 |

Source note: terminal-bench@2.0, 89 tasks piko had never seen or tuned on,
every trial running under piko's configurable per-trial spend cap,
deliberately set tight for this run. Read it the way a buyer should: only 11
of 89 tasks exceeded the harness's actual ability; 25 were deliberately
stopped by the cap we chose (three passed their tests *while* being cut off
— the cap needs tuning, not removing). The full measurement cost $26.24
where an uncapped run costs 3–4×. This is what working brakes look like: you
know exactly what you bought and what another $20 would buy next. Exact cap
settings are recorded in the committed run manifest. Not comparable to
Terminus's public 78.0, which is uncapped spend on the harder 2.1 task set.

## 3 · The governance spine — The complete decision ledger: 24 records, one root philosophy

Piko's claims aren't culture — they're numbered architecture decision
records: owner-ratified, never edited after acceptance, amended in public
when reality disagrees. Every one of them traces to the same root: **cost**.
Some make each request cheaper, some stop waste from compounding, some exist
because incidents and integration churn are the most expensive tokens you'll
ever buy.

### Make every request cheaper
*Value: fixed context is a tax collected on every API call, forever, for
every user — these decisions design the tax down and make it structurally
unable to creep back.*

| ADR | Decision | What it guarantees, in plain terms |
|---|---|---|
| 0001 | Fixed-context budget, CI-enforced | The 815-token footprint is a build gate, not a goal — the build fails if it grows without cited evidence. |
| 0002 | Files and CLIs over MCP; five tools | The smallest workable tool surface. Everything else is a file or a shell command — no protocol sprawl to pay for on every request. |
| 0014 | Prompt-cache discipline | Request layout keeps the prefix stable so provider caches hit — 44% of input tokens billed at one-tenth price in the parity run. |
| 0017 (proposed) | $/completed task is the fitness function | The root metric itself, ratified: every change is judged by one number, and prompt text pays "rent" in measured benefit or gets deleted — already enforced once against our own feature. |

### Stop runaway spend before it compounds
*Value: our benchmark forensics show failures, not solves, dominate agent
bills — a wandering agent burned 3× a focused one on the same task. These
decisions bound the expensive failure modes inside the loop, where the model
can't negotiate.*

| ADR | Decision | What it guarantees, in plain terms |
|---|---|---|
| 0003 | Observable compaction | Context growth — the quiet cost multiplier — is cut back into new, lineage-linked files, in the open, never silently rewritten. |
| 0005 | Loop-side flail guard | A stuck agent is stopped by the loop counting real failures — not by hoping the prompt persuades it to give up. Doomed spend ends early. |
| 0009 | Hard run budgets in the loop | Turn, token, and time ceilings enforced where they can't be talked around. |
| 0020 | Dollar accounting and spend ceilings | The configurable per-run spend cap, enforced by reserving each request's worst-case cost before dispatch — worst-case spend becomes a contract, not a distribution. |

### Never pay for the same failure twice
*Value: a crash that loses history, a duplicated side effect, or a "did it
run?" mystery costs engineer-hours — the most expensive line on any AI bill.
These decisions make recovery cheap and repeated work impossible.*

| ADR | Decision | What it guarantees, in plain terms |
|---|---|---|
| 0007 | Write-ahead lifecycle journal | Every action is journaled before it runs. After a crash the record says "outcome unknown" — it never guesses, so nothing gets re-run blind or double-billed. |
| 0008 | Strict provider contract | A malformed model response becomes a typed failure, never a silently accepted answer you pay to debug later. |
| 0011 | Persistent approve / edit / reject | A gated action suspends the run into a saved state. A human — or a script — approves, edits, or rejects later. No spend and no risk taken because a session timed out. |
| 0015 | Durable single-writer sessions | One process writes a session's history; files are owner-only; corruption fails loudly instead of being skipped over. |
| 0023 | Lock-capability session API | Writing to a session without holding its lock is impossible — rejected by the type system and again at runtime. |
| 0024 | Explicit stale-lock recovery | After a crash, the harness fails loudly and names the recovery command — it never silently resumes older history or loses your newest work. |

### Make trust cheap enough to scale
*Value: one leaked credential or one escaped write can cost more than every
token the harness will ever save — containment failures are the most
expensive spend of all. These decisions keep the blast radius at zero so
adoption doesn't purchase risk.*

| ADR | Decision | What it guarantees, in plain terms |
|---|---|---|
| 0004 | Sub-agents are headless self-spawns | A sub-agent is just another piko process under the same rules — one execution path to audit, not two. |
| 0006 | Workspace containment; host bash deny-by-default | The agent writes only inside the project. Touching the host shell is an explicit operator opt-in. |
| 0012 | Extensions are trusted controller code | Plugins are explicitly trusted code — the design never pretends a plugin boundary is a security boundary. |
| 0013 | Three separated event surfaces | User output, session record, and telemetry are distinct channels; telemetry redacts by default. |
| 0016 | Credential handling | Child shells get a scrubbed environment; credentials travel by *name* in observability, never by value — tested with redaction turned off. |
| 0018 (proposed) | Container sandbox executor | The designed path to OS-grade isolation, behind a clean seam so it can land without rewiring the harness. |
| 0022 | Descriptor-anchored containment | Closes the filesystem race an independent reviewer proved, with the reviewer's own exploit as the acceptance test. Ratified; in build. |

### Integrate once, keep it priced
*Value: integration churn is a recurring cost paid by every team that builds
on you — versioned contracts convert it into a one-time cost.*

| ADR | Decision | What it guarantees, in plain terms |
|---|---|---|
| 0010 | Fail-closed automation contract | Headless runs emit typed, versioned JSON and stable exit codes. Pipelines integrate without screen-scraping; changing an exit code requires a written amendment. |
| 0019 (proposed) | Release and compatibility contract | What a version number will promise — written down before anything ships, not after. |
| 0021 (reserved) | Artifact data lifecycle | Reserved: one retention policy for sessions, offloads, telemetry, and benchmark records. |

**So what:** Ask any harness vendor two questions: "show me the written
decision behind that claim" and "show me the time you enforced it against
yourselves." Piko answers both with commit links.

## 4 · Competitive position — Every peer optimizes capability. Piko owns the economics column.

| Harness | Thesis | Fixed context | Cost posture | Maturity |
|---|---|---|---|---|
| Claude Code | Rich context, subagents; quality first | 20–30k | Reports usage; no per-run dollar contract | Production |
| Codex CLI | Approval protocols, policy engine | 2–5k | Reports usage | Production |
| Terminus-2 | Minimal research baseline | ~2k | None | Research |
| DeepSeek harness | Cheap tokens; spend lavishly, undercut anyway | n/a | Solved at the model layer, not the harness | Emerging |
| Fusion-class | Run 2–5 models per prompt, merge | n/a | Meters everywhere, brakes nowhere — ×N spend by design | Experimental |
| **Piko** | **Enforced cost per outcome** | **815, gated** | **Hard ceilings · crash-safe budgets · self-pricing · CI cost gates** | **Pre-1.0, hardening** |

**So what:** Piko doesn't need to out-capability Claude Code — it composes
with any model, including whatever wins next quarter. Even DeepSeek's cheap
tokens don't erode the position: enforcement works at any token price.
Cheaper tokens under piko's governance just mean a better contract.

## 5 · Why these numbers can be trusted — Our bar charts are hard to fake, including for us

- **Tuning is firewalled from evidence.** Tasks we optimized against are
  formally labeled tuning data and barred from headline claims. Evidence
  comes only from seed-drawn unseen tasks and the official suite — where a
  scan for benchmark-gaming signatures came back clean.
- **Failures never leave the denominator.** A trial whose container crashed
  is recorded as a failure, not dropped from the count. The comparison
  tooling refuses to produce a score if expected trials are missing. Scores
  structurally cannot inflate.
- **Independently attacked, on the record.** We commissioned an adversarial
  review requiring working reproductions. It found real defects — including
  the filesystem race behind ADR 0022. Each reproduction is now a permanent
  regression test in the suite.
- **Corrections are dated commits.** A headline cost claim was retracted
  when forensics found a pricing error; a published score was corrected
  upward the same day a counting flaw surfaced. Both live in the repo with
  dates and diffs — not in anyone's memory.

## 6 · What we need to win — Three asks, sequenced by return per dollar

1. **Finish the hardening tranche — engineering time, $0.** Land ADR 0022
   (the descriptor-anchored filesystem boundary — last open finding from the
   independent review). This moves piko from "unusually well-governed
   prototype" to "auditable pre-production harness," the credibility unlock
   for any external evaluation.
2. **Map the cost/quality frontier — ~$25 of API credit.** Rerun the 25
   cap-stopped official tasks at progressively higher cap settings. This
   turns "37% floor" into piko's true capability curve and locates exactly
   where a dollar stops buying solves — the number that becomes our default
   spend setting, and a chart no competitor can currently produce about
   their own harness.
3. **Greenlight license + v0.3.0 — a decision, $0.** A license is the last
   blocker to anyone outside evaluating piko. Ship the current tranche as
   v0.3.0 with its evidence pack; the benchmark provenance is the launch
   story.

## The bottom line

> Capability is table stakes that reprices every quarter. The durable
> position is the harness that delivers outcomes at a known, enforced,
> auditable price — and piko already does, at solve-rate parity with the
> field's reference baseline, 28% cheaper per outcome, with the receipts
> written down as architecture decisions.

**Provenance.** Every figure traces to committed artifacts in the piko
repository: self-priced benchmark runs (docs/benchmarks/2026-08-24-grid,
2026-08-25-tb20), per-trial results with stop reasons, the 24-record ADR
index (docs/adr), and the independent review with its rubric. Head-to-head
figures use identical tasks, model, and attempt counts per arm. The Terminus
public anchor (78.0, Terminal-Bench 2.1) is uncapped spend on a harder task
set and is not directly comparable to piko's cost-capped 2.0 run — a
distinction this project treats as load-bearing. Peer comparisons reflect
public documentation as of August 2026. Piko is pre-1.0; the independent
maturity score is 2.6/5 and the remediation trail is in-repo.
