# 0012 — Tool extensions are trusted controller code

Status: accepted (2026-08-19, backfilled same day)
Amends: 0002

## Context

`--ext` / config-listed extension modules add tools beyond the built-in five.
A sandboxed plugin host was considered and rejected: it would add a process
boundary, an IPC contract, and a false sense of safety (a tool that can touch
the workspace is powerful regardless of where it runs). The honest alternative
is to name the trust level.

## Decision

Extensions run in-process, unsandboxed, with the process user's authority.
They are trusted controller code: loaded only when explicitly listed by the
user (never auto-discovered, never from project content), validated at load
time (shape, duplicate names rejected, aggregate schema byte ceilings,
TypeScript sources rejected — compiled JS only), and their schemas join the
provider-visible tool list within 0001's accounting.

This amends 0002: "never resident schemas" now reads "no MCP catalogs; bounded
resident schemas via explicitly listed extensions are the sanctioned
exception." Validation bounds what an extension advertises, not what it does.

## Consequences

- Extension authorship stays trivial (export Tool[]), and the trust model is
  stated instead of implied.
- A malicious extension is game over by definition — equivalent to running any
  other program. Users must treat extension installation like installing
  software, and docs say so.
- Approval policy (0011) can gate extension tools by name, but extensions can
  never modify policy.

## Research (2026-09-02)

Citations from the 2026-09-02 red-team review
(docs/reviews/2026-09-02-red-team-review.md), added after the fact. They
corroborate or challenge the decision above; they do not change it.

- challenges: "Credential Leakage in LLM Agent Skills", Chen et al.,
  arXiv 2604.03070, 2026. Of 17,022 skills, 520 carry 1,708 issues with 83
  confirmed malicious and 89.6% exploitable without elevated privileges; the
  risk this record knowingly accepts is measured, not hypothetical.
- challenges: "Skill-Inject", Schmotz et al., arXiv 2602.20156, 2026. Up to 80%
  attack success through skill files, including exfiltration and
  ransomware-like behaviour.
- challenges: "IsolateGPT", Wu et al., NDSS 2025, arXiv 2403.04960.
  Hub-and-spoke isolation of third-party apps prevents cross-app attacks at
  under 30% overhead on three quarters of queries, so partial isolation is
  feasible, against this record's argument that it would only buy a false sense
  of safety.
- corroborates: "LLM Platform Security", Iqbal, Kohno & Roesner, AIES 2024,
  doi 10.1609/aies.v7i1.31664. The taxonomy of third-party extension risk on LLM
  platforms, which is the trust level this record states rather than implies.

## Addendum (2026-09-02, content-hash pins and load-time journal row)

The decision above names the trust level but records nothing about which bytes
were trusted: a path that passed the shape and size checks yesterday could be a
different file today, and a session gave a reader no way to tell. R2-5 closes
that without changing the trust model.

- `--ext <path>@sha256:<hex>` pins a module to a digest. The file is hashed
  before the dynamic import, so a mismatch refuses to start (exit 1) with a
  message naming the path, the expected digest, and the digest on disk, rather
  than refusing after the module's top level has already run. A bare
  `--ext <path>` keeps working exactly as before; the suffix is read as a pin
  only when it is a full 64-character digest, so an `@` inside an ordinary path
  stays part of the path.
- Every loaded extension, pinned or not, appends an `extension_loaded`
  lifecycle row to the session: path, SHA-256 of the imported bytes, the tool
  names it contributed, and whether a pin was given. The row lands on the
  locked session handle before the first model call, so a transcript says what
  code the run actually carried.

Scope. This is provenance, not sandboxing: a pinned extension still runs with
the process user's authority, and pinning the digest of a malicious module
changes nothing about what it can do. The row is additive under 0019, so
`JOURNAL_SCHEMA_VERSION` stays at 2. Additive rows are meant to be ignorable by
older readers; today's reader validates row types strictly and would refuse an
unknown one, which makes the tolerant-reader rule a real gap for 0019 to close
rather than something this change can claim. Config-listed extensions accept
the same pin syntax. Verifying a published digest against an upstream source is
the user's job; piko only checks that the bytes it imported are the bytes the
user named.
