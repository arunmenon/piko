import type { SpawnSyncReturns } from 'node:child_process';

export interface UsageSummary {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  cost?: {
    usd?: number;
    actualUSD: number;
    reservedUSD: number;
    pricedRequests: number;
    unpricedRequests: number;
    unknownRequests: number;
    complete: boolean;
  };
  requests: number;
  session?: string;
  status?: string;
  reason?: string;
}

export type EvalOutcomeReason =
  | 'completed'
  | 'timeout'
  | 'spawn_error'
  | 'signal'
  | 'incomplete'
  | 'nonzero_exit'
  | 'usage_missing'
  | 'terminal_status_missing'
  | 'evidence_error'
  | 'verification_error'
  | 'verification_failed';

export interface EvalOutcome {
  pass: boolean;
  reason: EvalOutcomeReason;
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parse only the CLI's structured --usage record, ignoring unrelated JSON log lines. */
export function parseUsageSummary(stderr: string): UsageSummary | undefined {
  for (const line of stderr.trim().split('\n').reverse()) {
    if (!line.trimStart().startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(value) ||
      value['v'] !== 1 ||
      value['type'] !== 'usage_summary' ||
      !isRecord(value['usage']) ||
      !isCount(value['requests'])
    ) continue;
    const usage = value['usage'];
    if (
      !isCount(usage['inputTokens']) ||
      !isCount(usage['outputTokens']) ||
      !isCount(usage['cacheReadTokens']) ||
      !isCount(usage['cacheWriteTokens'])
    ) {
      continue;
    }
    const cost = value['cost'];
    if (
      cost !== undefined &&
      (!isRecord(cost) ||
        !isMoney(cost['actualUSD']) ||
        !isMoney(cost['reservedUSD']) ||
        !isCount(cost['pricedRequests']) ||
        !isCount(cost['unpricedRequests']) ||
        !isCount(cost['unknownRequests']) ||
        typeof cost['complete'] !== 'boolean')
    ) {
      continue;
    }
    if (
      isRecord(cost) &&
      ((cost['complete'] === true && !isMoney(cost['usd'])) ||
        (cost['usd'] !== undefined && !isMoney(cost['usd'])))
    ) {
      continue;
    }
    return {
      usage: {
        inputTokens: usage['inputTokens'],
        outputTokens: usage['outputTokens'],
        cacheReadTokens: usage['cacheReadTokens'],
        cacheWriteTokens: usage['cacheWriteTokens'],
      },
      requests: value['requests'],
      ...(cost !== undefined
        ? {
            cost: {
              ...(cost['usd'] !== undefined ? { usd: cost['usd'] as number } : {}),
              actualUSD: cost['actualUSD'] as number,
              reservedUSD: cost['reservedUSD'] as number,
              pricedRequests: cost['pricedRequests'] as number,
              unpricedRequests: cost['unpricedRequests'] as number,
              unknownRequests: cost['unknownRequests'] as number,
              complete: cost['complete'] as boolean,
            },
          }
        : {}),
      ...(typeof value['session'] === 'string' ? { session: value['session'] } : {}),
      ...(typeof value['status'] === 'string' ? { status: value['status'] } : {}),
      ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
    };
  }
  return undefined;
}

function processErrorCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function incompleteMarker(stderr: string, usage: UsageSummary | undefined): string | undefined {
  if (usage?.status && usage.status !== 'completed') {
    return `usage reported status ${usage.status}${usage.reason ? `: ${usage.reason}` : ''}`;
  }
  const match = stderr.match(/^run (incomplete|budget_exceeded|failed|canceled|suspended):\s*(.*)$/m);
  return match ? `${match[1]}${match[2] ? `: ${match[2]}` : ''}` : undefined;
}

/**
 * A task passes only when both the agent process and deterministic verifier succeed.
 * Filesystem state alone is deliberately insufficient evidence.
 */
export function classifyEvalOutcome(
  processResult: Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stderr'>,
  verification: { passed: boolean; error?: string },
  usage: UsageSummary | undefined,
): EvalOutcome {
  const code = processResult.error ? processErrorCode(processResult.error) : undefined;
  if (code === 'ETIMEDOUT') {
    return { pass: false, reason: 'timeout', detail: processResult.error?.message };
  }
  if (processResult.error) {
    return { pass: false, reason: 'spawn_error', detail: `${code ? `${code}: ` : ''}${processResult.error.message}` };
  }
  if (processResult.signal) {
    return { pass: false, reason: 'signal', detail: processResult.signal };
  }
  const incomplete = incompleteMarker(processResult.stderr ?? '', usage);
  if (incomplete) return { pass: false, reason: 'incomplete', detail: incomplete };
  if (processResult.status !== 0) {
    return {
      pass: false,
      reason: 'nonzero_exit',
      detail: processResult.status === null ? 'process ended without an exit status' : `exit ${processResult.status}`,
    };
  }
  if (!usage) return { pass: false, reason: 'usage_missing', detail: '--usage summary was not emitted' };
  if (!usage.status) {
    return { pass: false, reason: 'terminal_status_missing', detail: '--usage did not attest a terminal run status' };
  }
  if (verification.error) return { pass: false, reason: 'verification_error', detail: verification.error };
  if (!verification.passed) return { pass: false, reason: 'verification_failed' };
  return { pass: true, reason: 'completed' };
}
