# Independent replication of the capability matrix (received 2026-09-01)

Parallel investigation run with
docs/reviews/capability-matrix-parallel-investigation-prompt.md: blind
re-investigation of all 13 harnesses under the same rubric, then a
cell-by-cell diff against our grounding artifact. Received verbatim from
the operator; recorded as provenance. Reported caveat: a local search
briefly exposed grounding-file snippets during the piko audit; peer rows
came from blind investigators and the piko row was frozen first, so
separation was strong but not perfect.

Headline: 90/143 cells agree (62.9%) — the study does NOT substantially
replicate as published. The strongest replicated conclusion: piko tops no
capability column alone. The conclusion requiring revision: "three
mechanisms the field genuinely lacks" is false.

## Findings accepted after our own verification (adjudication 2026-09-01)

1. OpenHands invalidates both exclusivity claims (verified directly by us
   against docs.openhands.dev the same day): MAX_BUDGET_PER_TASK is a real
   per-task dollar stop (post-spend; can overshoot the final request), and
   the SDK EventLog documents thread- and process-safe locked appends with
   a stated flock()/NFS caveat. D2 and D7 wording retired accordingly.
2. Sandbox mode-restriction rule applied inconsistently: Claude and
   Gemini sandboxing is opt-in (Claude documented fail-open unless
   failIfUnavailable) — both D6 downgraded strong -> partial. Codex D6
   stays strong: default-on OS enforcement, which the replication itself
   concedes is materially stronger.
3. Durability is not locking: Codex and DeepSeek D7 downgraded strong ->
   partial (resume/append durability established; cross-process locking
   not demonstrated). The five-level decomposition (resumable history;
   durable append/recovery; in-process serialization; cross-process
   locking; stale-lock diagnosis+recovery) is adopted for future grading.
4. piko D4 absent -> partial with honest wording: primitive headless
   self-spawn exists via explicitly enabled host execution (ADR 0004);
   native contained delegation is not shipped.
5. D2 rubric split adopted, applied uniformly: STRONG requires an
   enforced ceiling that cannot be exceeded (pre-dispatch reservation —
   piko only, among those inspected); enforced stops that can overshoot
   grade PARTIAL (OpenHands per-task stop, mini-swe-agent post-response
   cost_limit, Claude print-mode cap as mode-restricted); accounting-only
   cells grade ABSENT (Codex, Gemini, OpenCode, Aider, pi-mono, Exo,
   Terminus-2, DeepSeek, fusion). This is a mechanical rubric, not an
   exclusivity claim; several peers enforce dollar stops.

## Findings not accepted (open disputes, recorded)

- Terminus-2 D10: the replication concedes its blind pass initially
  missed Terminus's published Terminal-Bench evidence; our STRONG stands.
- Assorted D1/D8 strong-vs-partial diffs reflect rubric strictness
  variance rather than factual disagreement; grounded grades stand, and
  the variance is disclosed in the artifact's provenance.

## Sentence replacements adopted (as proposed by the replication)

The published study's "field genuinely lacks" framings are replaced with:
piko is differentiated by pre-dispatch spend reservation and durable
exposure accounting rather than post-request budget checks; process-safe
event-log locking exists in OpenHands, and piko's narrower distinction is
lock-capability mutation with explicit stale-lock diagnosis and recovery;
piko's edge is the unusually explicit COMPOSITION of cost reservation,
durable lifecycle accounting, lock-capability sessions, stale-lock
recovery, and evidence-budget ratchets.
