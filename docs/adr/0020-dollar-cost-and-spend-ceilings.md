# 0020 — Dollar-denominated cost accounting and spend ceilings

Status: accepted (2026-08-24; implemented and fault-verified same day; owner-ratified 2026-08-24)
Amends: 0009

## Context

0009 conceded that monetary cost was bounded only via token proxies until
per-model pricing was wired into enforcement. Two developments call that due:
0017's fitness function is cost per completed task in dollars, and the
exoharness/exo study showed both the right implementation pattern (a loader
over LiteLLM's public price database: explicit path → fresh cache → fetch →
stale cache → empty, never failing) and the failure mode to avoid — Exo
computes cost but bounds nothing, so accounting exists without enforcement.

## Decision

1. Pricing: a table loader following the resolution chain above, with a 24h
   cache TTL. Any error degrades to an empty table: cost becomes unset, token
   accounting is unaffected. No network fetch on the request path — load once
   at startup, and the fetch is disableable outright (explicit table path or
   offline flag) for air-gapped use.
2. Accounting: per-request cost computed from provider-reported usage at the
   resolved model's price, carried in the per-turn ledger, `/tokens`,
   `--usage`, `--audit`, and eval/bench artifacts, alongside — never replacing
   — token counts.
3. Enforcement: `RunBudget` gains an optional `maxSpendUSD` hard ceiling with
   stop reason `spend`, mapped like every budget to status `budget_exceeded`
   and exit 2. Before dispatch, the loop durably reserves a conservative upper
   bound from the complete serialized request, enforced output cap, worst
   applicable input/cache rate, and billable attempt count. A terminal usage
   row replaces that reservation with actual cost; a failed/unknown terminal
   retains it as exposure. If the next reservation does not fit, no provider
   request is made. Consistent with 0009: the model is never asked to respect it.
4. Fail-closed pairing: setting a spend ceiling for a model absent from the
   pricing table refuses to start the run — an unpriceable model with a spend
   cap is an error, not a warning. Without a ceiling, unpriced models run
   normally with cost unset.
5. Completeness: aggregates expose actual priced subtotal, reserved exposure,
   and priced/unpriced/unknown request counts. A single unpriced or unknown
   request leaves aggregate USD unset; it is never serialized as a zero-cost run.

The implementation evidence is maintained in
`docs/adr/evidence/0020-pricing-test-map.md`.

## Consequences

- Budgets speak the unit users and fleet operators actually think in, and
  0017 gets its fitness metric from artifacts that already exist.
- Costs: an external price database becomes a soft dependency (cached,
  degradable, and never load-bearing for correctness — only for the spend
  feature); prices go stale between refreshes and the ledger records which
   table revision priced a run; per-model aliases and unpriced fine-tunes need
  explicit config rather than guessing. Public rows with usage-dependent token
  rate splits that the normalized provider ledger cannot reconstruct are also
  left unpriced rather than reported as falsely exact.
- The 0009 principle extends unchanged: enforcement lives in the loop; this
  record only adds a currency to it.


Scope note (2026-09-02): `maxSpendUSD` is enforced per user turn (see 0009's scope note). The reservation is conservative (byte-derived input bound, maximum applicable rates), so a nominal cap stops work at roughly half its value on long contexts; the effective ceiling is the number to design against. Aggregate session and child-tree ceilings: ADR 0026 (proposed).

## Addendum (2026-09-02, legible ceiling)

R2-2 of the red-team remediation plan makes a dollar ceiling stop explain
itself without a journal read. Every spend stop now carries four numbers, and
only four:

- `reservationUSD`: the conservative reservation the refused next provider
  request would have needed (zero when a completed response, not a pending
  reservation, was what crossed the line).
- `actualUSD`: priced spend already recorded for this turn.
- `reservedUSD`: reservations still outstanding, whose request has produced no
  priced terminal usage.
- `ceilingUSD`: the configured `maxSpendUSD` for the turn.

They add up: a stop happens exactly when
`actualUSD + reservedUSD + reservationUSD > ceilingUSD`. The number to design
against is the effective ceiling, `ceilingUSD - reservedUSD`, which is what the
conservatism of the reservation actually leaves spendable.

Where they appear:

- the core `budget_exceeded` event carries them as `spend` whenever its reason
  is `spend`, at all four stop sites (pre-dispatch reservation, post-response
  actual overshoot, and both compaction-summary paths);
- the terminal `turn_done` event repeats the same object, so the last row of a
  `--json` stream is sufficient on its own;
- headless (without `--json`) and the REPL print one line,
  `spend stop: reserved $X for the next request, spent $Y, ceiling $Z,
  effective ceiling $W (ceiling less $R outstanding reservations)`, in the same
  six-decimal dollar format the rest of the CLI uses;
- `--usage` adds a `spendCeiling` object (`ceilingUSD`, `actualUSD`,
  `reservedUSD`, `effectiveCeilingUSD`) to its `usage_summary` row whenever a
  ceiling is configured.

This is output only. The reservation math, the enforcement points, and the
scope of `maxSpendUSD` are unchanged, and ADR 0026's proposed session-scoped
design is untouched: it inherits this presentation rather than replacing it.
