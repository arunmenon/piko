import { effectiveSpendCeilingUSD, type SpendStop, type TreeBudgetStop } from '@pi/core';

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

/**
 * Remove terminal control bytes from untrusted text while retaining ordinary
 * multiline output. In particular, ESC/C1 removal neutralizes CSI and OSC
 * sequences instead of allowing model or repository content to control the
 * user's terminal. Application-owned styling is added only after this boundary.
 */
export function sanitizeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
}

function wrap(code: string, text: string): string {
  const safe = sanitizeTerminalText(text);
  return useColor ? `\x1b[${code}m${safe}\x1b[0m` : safe;
}

export const dim = (text: string): string => wrap('2', text);
export const cyan = (text: string): string => wrap('36', text);
export const red = (text: string): string => wrap('31', text);
export const bold = (text: string): string => wrap('1', text);

export function summarizeArgs(args: Record<string, unknown>): string {
  const preferred = args['command'] ?? args['path'] ?? '';
  const text = typeof preferred === 'string' && preferred.length > 0 ? preferred : JSON.stringify(args);
  return oneLine(text, 100);
}

export function oneLine(text: string, max: number): string {
  const line = sanitizeTerminalText(text).split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function cacheHitRate(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number | undefined {
  const totalInputSide = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (totalInputSide === 0 || usage.cacheReadTokens === 0) return undefined;
  return Math.round((usage.cacheReadTokens / totalInputSide) * 100);
}

export function formatUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): string {
  const hit = cacheHitRate(usage);
  const hitText = hit !== undefined ? ` | cache hit ${hit}%` : '';
  return `in ${usage.inputTokens} (cache read ${usage.cacheReadTokens}, write ${usage.cacheWriteTokens}) | out ${usage.outputTokens}${hitText}`;
}

/** `Number.prototype.toFixed` accepts at most 100 fraction digits. */
const MAX_SPEND_DECIMALS = 100;
/** Every spend line keeps at least the six decimals readers already expect. */
const MIN_SPEND_DECIMALS = 6;

/**
 * Plain fixed-point dollars, never scientific notation. `toFixed` switches to
 * exponential form at 1e21 and above, so a value that large is expanded through
 * a grouping-free locale format instead of being printed as `1e+21`.
 */
function fixedDollars(amount: number, decimals: number): string {
  if (!Number.isFinite(amount)) return String(amount);
  const rendered = amount.toFixed(decimals);
  if (!rendered.includes('e') && !rendered.includes('E')) return rendered;
  return amount.toLocaleString('en-US', {
    useGrouping: false,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * The smallest decimal count that shows at least two significant digits of
 * every nonzero amount, so a sub-microdollar stop never renders as a column of
 * `$0.000000` that reads as an impossible all-zero explanation.
 */
function significantDecimals(amounts: readonly number[]): number {
  let decimals = MIN_SPEND_DECIMALS;
  for (const amount of amounts) {
    if (amount === 0 || !Number.isFinite(amount)) continue;
    const leadingDigitExponent = Math.floor(Math.log10(Math.abs(amount)));
    // The second significant digit sits at 10^(exponent - 1), so that many
    // fraction digits are needed to reach it.
    const neededForTwoDigits = 1 - leadingDigitExponent;
    decimals = Math.max(decimals, Math.min(neededForTwoDigits, MAX_SPEND_DECIMALS));
  }
  return decimals;
}

/**
 * One line that explains a dollar ceiling stop without reading the journal
 * (ADR 0020 addendum). The numbers add up: the refused reservation plus the
 * spend already recorded exceeds the effective ceiling, which is the configured
 * ceiling less the reservations still outstanding. Precision is adaptive: six
 * decimals normally, more when the amounts are small enough that six would
 * round the explanation away.
 */
export function formatSpendStop(spend: SpendStop): string {
  const effectiveCeilingUSD = effectiveSpendCeilingUSD(spend);
  let decimals = significantDecimals([
    spend.reservationUSD,
    spend.actualUSD,
    spend.reservedUSD,
    spend.ceilingUSD,
    effectiveCeilingUSD,
  ]);
  // Rounding must not flatten the reason for the stop: whenever the reservation
  // plus the recorded spend really is above the effective ceiling, the printed
  // numbers have to say so too.
  const stopIsExplainable = spend.reservationUSD + spend.actualUSD > effectiveCeilingUSD;
  while (
    stopIsExplainable &&
    decimals < MAX_SPEND_DECIMALS &&
    Number(fixedDollars(spend.reservationUSD, decimals)) + Number(fixedDollars(spend.actualUSD, decimals)) <=
      Number(fixedDollars(effectiveCeilingUSD, decimals))
  ) {
    decimals += 1;
  }
  return (
    `spend stop: reserved $${fixedDollars(spend.reservationUSD, decimals)} for the next request, ` +
    `spent $${fixedDollars(spend.actualUSD, decimals)}, ceiling $${fixedDollars(spend.ceilingUSD, decimals)}, ` +
    `effective ceiling $${fixedDollars(effectiveCeilingUSD, decimals)} ` +
    `(ceiling less $${fixedDollars(spend.reservedUSD, decimals)} outstanding reservations)`
  );
}

/**
 * The session-tree half of a ceiling stop (ADR 0026). Printed next to the
 * per-turn `formatSpendStop` line, or on its own when only the tree is capped,
 * so a stop states the effective ceiling for the tree as well as the turn.
 */
export function formatTreeStop(tree: TreeBudgetStop): string {
  const parts: string[] = [];
  if (tree.spend) {
    const effectiveCeilingUSD = effectiveSpendCeilingUSD(tree.spend);
    const decimals = significantDecimals([
      tree.spend.reservationUSD,
      tree.spend.actualUSD,
      tree.spend.reservedUSD,
      tree.spend.ceilingUSD,
      effectiveCeilingUSD,
    ]);
    parts.push(
      `reserved $${fixedDollars(tree.spend.reservationUSD, decimals)} for the next request, ` +
        `spent $${fixedDollars(tree.spend.actualUSD, decimals)}, ceiling $${fixedDollars(tree.spend.ceilingUSD, decimals)}, ` +
        `effective ceiling $${fixedDollars(effectiveCeilingUSD, decimals)} ` +
        `(ceiling less $${fixedDollars(tree.spend.reservedUSD, decimals)} outstanding reservations)`,
    );
  }
  if (tree.remainingUSD !== undefined) parts.push(`$${tree.remainingUSD.toFixed(6)} remaining`);
  if (tree.remainingTokens !== undefined) parts.push(`${tree.remainingTokens} tokens remaining`);
  if (tree.remainingActiveTimeMs !== undefined) {
    parts.push(`${Math.round(tree.remainingActiveTimeMs / 1_000)}s active time remaining`);
  }
  if (tree.remainingElapsedTimeMs !== undefined) {
    parts.push(`${Math.round(tree.remainingElapsedTimeMs / 1_000)}s elapsed time remaining`);
  }
  return `session tree ${tree.reason} stop (root ${oneLine(tree.rootRunId, 128)}): ${parts.join(', ')}`;
}

/**
 * The single stderr line a headless run prints when the turn did not complete.
 * "turn", not "run": every ceiling here is scoped to one user turn (ADR 0009
 * scope note). The eval fallback detector matches this exact shape, so the
 * format lives in one exported place instead of being restated where it is
 * matched (R2-10).
 */
export function formatTurnIncomplete(terminal: {
  status: string;
  reason: string;
  iterations: number;
  toolCalls: number;
}): string {
  return `turn ${terminal.status}: ${terminal.reason} after ${terminal.iterations} model request(s) and ${terminal.toolCalls} tool call(s)`;
}

export function formatCost(cost: {
  actualUSD: number;
  reservedUSD: number;
  pricedRequests: number;
  unpricedRequests: number;
  unknownRequests: number;
}): string {
  const complete = cost.reservedUSD === 0 && cost.unpricedRequests === 0 && cost.unknownRequests === 0;
  const usd = complete
    ? `$${cost.actualUSD.toFixed(6)}`
    : `unavailable${cost.actualUSD > 0 ? ` ($${cost.actualUSD.toFixed(6)} priced subtotal)` : ''}`;
  const uncertainty = [
    cost.reservedUSD > 0 ? `$${cost.reservedUSD.toFixed(6)} reserved` : '',
    cost.unpricedRequests > 0 ? `${cost.unpricedRequests} unpriced` : '',
    cost.unknownRequests > 0 ? `${cost.unknownRequests} unknown` : '',
  ].filter(Boolean);
  return `${usd}${uncertainty.length > 0 ? ` (${uncertainty.join(', ')})` : ''}`;
}
