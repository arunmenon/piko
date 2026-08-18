/** Drops a trailing lone high surrogate so a slice never emits invalid UTF-16
 *  (an unpaired surrogate in the request body is rejected by the APIs). */
export function trimTrailingSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function trimLeadingSurrogate(text: string): string {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/**
 * Caps tool output by keeping the head and tail — errors usually live at the end,
 * context at the start. The marker tells the model how much it is not seeing.
 */
export function truncateMiddle(text: string, maxChars = 30_000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  const head = trimTrailingSurrogate(text.slice(0, half));
  const tail = trimLeadingSurrogate(text.slice(text.length - half));
  return `${head}\n[... ${omitted} chars truncated ...]\n${tail}`;
}
