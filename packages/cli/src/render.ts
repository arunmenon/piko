const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

function wrap(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
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
  const line = text.split('\n')[0] ?? '';
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
