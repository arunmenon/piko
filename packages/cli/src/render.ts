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
