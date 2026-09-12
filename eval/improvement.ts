/** Pure evidence and decision layer. No model-generated text is executable. */
export interface OffloadPolicy { thresholdChars: number; keepRecentMessages: number }
export const baselinePolicy: OffloadPolicy = { thresholdChars: 4000, keepRecentMessages: 6 };
export interface TraceEvidence {
  offloaded: number; largeOutputs: number; recalls: number; references: number[];
}
export function diagnose(jsonl: string): TraceEvidence {
  const evidence: TraceEvidence = { offloaded: 0, largeOutputs: 0, recalls: 0, references: [] };
  let firstRow = true;
  for (const [index, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    const row = JSON.parse(line); // broken evidence never silently disappears
    if (!row || row.v !== 1) throw new Error(`invalid event stream at line ${index + 1}`);
    // The CLI emits a standalone capabilities contract before its agent events.
    // Recognize that specific header; never silently discard arbitrary non-events.
    if (firstRow && !('event' in row) && typeof row.sessionId === 'string'
        && row.sessionId.length > 0 && row.capabilities
        && Number.isSafeInteger(row.capabilities.journalSchemaVersion)
        && row.capabilities.journalSchemaVersion > 0
        && Array.isArray(row.capabilities.tools)
        && row.capabilities.tools.every((tool: unknown) => typeof tool === 'string')
        && Array.isArray(row.capabilities.exitCodes)
        && row.capabilities.exitCodes.length > 0
        && row.capabilities.exitCodes.every((code: unknown) => Number.isSafeInteger(code))
        && row.capabilities.budgetScope === 'turn'
        && row.capabilities.sessionBudgetScope === 'tree') {
      firstRow = false;
      continue;
    }
    firstRow = false;
    if (!row.event || typeof row.event.type !== 'string') throw new Error(`invalid event stream at line ${index + 1}`);
    const event = row.event;
    let relevant = false;
    if (event.type === 'offloaded') {
      if (!Number.isSafeInteger(event.count) || event.count < 0) throw new Error('invalid offload event');
      evidence.offloaded += event.count; relevant = true;
    }
    if (event.type === 'tool_end' && Array.isArray(event.result?.content)) {
      const length = event.result.content.reduce((n: number, block: { type: string; text?: string }) =>
        n + (block.type === 'text' ? (block.text?.length ?? 0) : 0), 0);
      if (length >= 4000) { evidence.largeOutputs++; relevant = true; }
    }
    if (event.type === 'tool_start' && event.call?.name === 'read'
        && typeof event.call.arguments?.path === 'string'
        && /(?:^|\/)\.pi\/artifacts\/.*\/offload-\d+\.txt$/.test(event.call.arguments.path)) {
      evidence.recalls++; relevant = true;
    }
    if (relevant) evidence.references.push(index + 1);
  }
  return evidence;
}
export function propose(evidence: TraceEvidence): { policy: OffloadPolicy; hypothesis: string } | undefined {
  if (!evidence.offloaded && !evidence.largeOutputs) return undefined;
  if (evidence.recalls > 0) return {
    policy: { thresholdChars: 8000, keepRecentMessages: 12 },
    hypothesis: 'Observed artifact recalls suggest testing longer retention. Accept only if total cost falls without unacceptable outcome regression.',
  };
  return {
    policy: { thresholdChars: 2000, keepRecentMessages: 4 },
    hypothesis: 'Large outputs with no observed artifact recalls suggest testing earlier offload. This is a hypothesis, not evidence of savings.',
  };
}
export interface Measurement {
  task: string; repeat: number; arm: 'baseline' | 'candidate'; pass: boolean;
  usd: number | null; offloaded: number; artifact: string;
}
export interface Acceptance {
  repeats: number; maxQualityLoss: number; minSavings: number; perTrialUSD: number;
}
export function compare(rows: Measurement[], taskNames: string[], rule: Acceptance, confirm = true) {
  const insufficient = (reason: string) => ({ verdict: 'insufficient_evidence' as const, reason });
  if (!taskNames.length || new Set(taskNames).size !== taskNames.length
      || !Number.isSafeInteger(rule.repeats) || rule.repeats < 1
      || !Number.isFinite(rule.perTrialUSD) || rule.perTrialUSD <= 0
      || !Number.isFinite(rule.maxQualityLoss) || rule.maxQualityLoss < 0 || rule.maxQualityLoss >= 1
      || !Number.isFinite(rule.minSavings) || rule.minSavings <= 0 || rule.minSavings >= 1) {
    return insufficient('invalid predeclared acceptance rule');
  }
  const expected = taskNames.length * rule.repeats * 2;
  if (rows.length !== expected) return insufficient('missing or unexpected trials');
  const indexed = new Map<string, Measurement>();
  for (const row of rows) {
    const key = `${row.task}:${row.repeat}:${row.arm}`;
    if (indexed.has(key) || !taskNames.includes(row.task) || !Number.isSafeInteger(row.repeat)
        || row.repeat < 0 || row.repeat >= rule.repeats || !['baseline', 'candidate'].includes(row.arm)
        || typeof row.pass !== 'boolean') return insufficient('invalid or duplicate trial identity');
    if (row.usd === null || !Number.isFinite(row.usd) || row.usd < 0 || row.usd > rule.perTrialUSD) {
      return insufficient('cost evidence is incomplete or exceeds its predeclared bound');
    }
    indexed.set(key, row);
  }
  let baselineCost = 0, candidateCost = 0, baselinePass = 0, candidatePass = 0, activation = 0;
  for (const task of taskNames) for (let repeat = 0; repeat < rule.repeats; repeat++) {
    const a = indexed.get(`${task}:${repeat}:baseline`);
    const b = indexed.get(`${task}:${repeat}:candidate`);
    if (!a || !b) return insufficient('unpaired trial');
    baselineCost += a.usd!; candidateCost += b.usd!;
    baselinePass += Number(a.pass); candidatePass += Number(b.pass);
    activation += b.offloaded;
  }
  const n = expected / 2;
  if (!baselinePass || !candidatePass || !baselineCost || !activation) return insufficient('no verified solves, baseline cost, or candidate mechanism activation');
  const qualityDifference = (candidatePass - baselinePass) / n;
  // Paired bounded differences in [-1, 1]. Each one-sided bound has alpha=.025;
  // union bound gives >=95% joint coverage under independent repeat trials.
  // Costs use (1-minSavings)*baseline - candidate, with range <=2*perTrialUSD.
  // Deliberately conservative: small pilot runs generally cannot certify a win.
  const radius = Math.sqrt(2 * Math.log(40) / n);
  const qualityLower = Math.max(-1, qualityDifference - radius);
  const savingDifference = ((1 - rule.minSavings) * baselineCost - candidateCost) / n;
  const savingLowerUSD = savingDifference - rule.perTrialUSD * radius;
  const metrics = {
    pairs: n, baselinePass, candidatePass, baselineCost, candidateCost,
    baselineCostPerSolve: baselineCost / baselinePass,
    candidateCostPerSolve: candidateCost / candidatePass,
    qualityDifference, qualityLower, savingLowerUSD,
    relativeCostSaving: 1 - candidateCost / baselineCost,
    scope: 'fixed synthetic task suite; independent repeat trials assumed; no broad capability claim',
  };
  if (qualityDifference < -rule.maxQualityLoss || candidateCost / candidatePass >= baselineCost / baselinePass) {
    return { verdict: 'rejected' as const, reason: 'observed quality or cost-per-solve screen failed', metrics };
  }
  if (confirm && (qualityLower < -rule.maxQualityLoss || savingLowerUSD <= 0)) {
    return { verdict: 'insufficient_evidence' as const, reason: 'confidence bounds do not establish the predeclared improvement', metrics };
  }
  return { verdict: 'supported' as const, reason: confirm ? 'quality and cost bounds passed; human review required' : 'development screen passed; confirmation required', metrics };
}

/** One frozen proposal, then screening, then a separately evaluated confirmation.
 * Callers own execution and budget accounting; the proposer sees scout evidence only. */
export function runCycle(input: {
  development: string[]; confirmation: string[]; rule: Acceptance;
  trial(suite: string, task: string, repeat: number, arm: Measurement['arm'], policy: OffloadPolicy): { row: Measurement; evidence: TraceEvidence };
  onProposal(proposal: NonNullable<ReturnType<typeof propose>>, scout: { row: Measurement; evidence: TraceEvidence }): void;
  onStage(suite: string, decision: ReturnType<typeof compare>): void;
}): ReturnType<typeof compare> {
  if (!input.development.length || !input.confirmation.length
      || input.development.some(task => input.confirmation.includes(task))) {
    return { verdict: 'insufficient_evidence', reason: 'development and confirmation tasks must be nonempty and disjoint' };
  }
  const scout = input.trial('offload-development', input.development[0]!, 0, 'baseline', baselinePolicy);
  const proposal = propose(scout.evidence);
  if (!proposal) return { verdict: 'insufficient_evidence', reason: 'scout found no large-output evidence to justify an offload experiment' };
  Object.freeze(proposal.policy);
  Object.freeze(proposal);
  input.onProposal(proposal, scout);
  for (const [suite, tasks, confirmation] of [
    ['offload-development', input.development, false],
    ['offload-confirmation', input.confirmation, true],
  ] as const) {
    const rows: Measurement[] = [];
    for (let repeat = 0; repeat < input.rule.repeats; repeat++) for (const [index, task] of tasks.entries()) {
      const arms = (repeat + index) % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const;
      for (const arm of arms) rows.push(input.trial(suite, task, repeat, arm, arm === 'baseline' ? baselinePolicy : proposal.policy).row);
    }
    const decision = compare(rows, tasks, input.rule, confirmation);
    input.onStage(suite, decision);
    if (decision.verdict !== 'supported' || confirmation) return decision;
  }
  return { verdict: 'insufficient_evidence', reason: 'missing confirmation verdict' };
}

export interface ResearchAccount { spentUSD: number; reservedUSD: number }
export function reserveTrial(account: ResearchAccount, ceiling: number, budget: number): void {
  if (![account.spentUSD, account.reservedUSD, ceiling, budget].every(Number.isFinite)
      || account.spentUSD < 0 || account.reservedUSD < 0 || ceiling <= 0 || budget <= 0
      || account.reservedUSD !== 0
      || account.spentUSD + ceiling > budget + 1e-9) throw new Error('research budget exhausted or prior reservation unreconciled');
  account.reservedUSD = ceiling;
}
export function settleTrial(account: ResearchAccount, cost?: {
  complete: boolean; usd?: number; unknownRequests: number; unpricedRequests: number; reservedUSD: number;
}): number {
  if (!cost?.complete || cost.unknownRequests !== 0 || cost.unpricedRequests !== 0 || cost.reservedUSD !== 0
      || typeof cost.usd !== 'number' || !Number.isFinite(cost.usd) || cost.usd < 0
      || account.reservedUSD <= 0 || cost.usd > account.reservedUSD) {
    throw new Error('incomplete or out-of-bound cost; reservation retained and experiment stopped');
  }
  account.spentUSD += cost.usd;
  account.reservedUSD = 0;
  return cost.usd;
}
