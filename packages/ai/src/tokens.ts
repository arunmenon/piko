/**
 * Cheap token estimate (~4 chars/token for English + code). Used for output caps and
 * the fixed-context budget check; billing-grade counts come from provider usage fields.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// conservative context windows by model family — used to pick the auto-compaction
// threshold; override per profile (contextWindow) or with PI_CONTEXT_WINDOW
const CONTEXT_WINDOWS: [RegExp, number][] = [
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-5/, 400_000],
  [/^o\d/, 200_000],
  [/^gpt-4o/, 128_000],
  [/^claude/, 200_000],
  [/^kimi/, 256_000],
  [/^deepseek/, 128_000],
  [/^qwen/, 128_000],
];

export function contextWindowFor(model: string): number {
  for (const [pattern, window] of CONTEXT_WINDOWS) {
    if (pattern.test(model)) return window;
  }
  return 128_000; // unknown model: assume small rather than overflow
}
