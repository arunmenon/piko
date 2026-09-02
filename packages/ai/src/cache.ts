/**
 * Prompt-cache facts that belong to the providers, not to piko: the minimum
 * prefix size a request must reach before anything caches at all, and the cache
 * lifetime the provider lets a caller choose.
 *
 * Sources (re-read these before trusting any number below):
 * - Anthropic prompt caching, "Cache limitations" and the cache_control
 *   reference: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * - OpenAI prompt caching, "Requirements":
 *   https://platform.openai.com/docs/guides/prompt-caching
 *
 * Anthropic publishes the minimum PER MODEL, not per family, and has moved it
 * between 512 and 4096 tokens across generations, so piko carries a dated table
 * keyed on model id prefix rather than a family heuristic. A model piko has no
 * row for has an unknown minimum, and the diagnostics say so instead of
 * guessing. ADR 0001 (two-number gate) and ADR 0014 (cache measurement) both
 * read this table.
 */

export const OPENAI_MIN_CACHEABLE_TOKENS = 1024;

/** The date the table below was last read off the published Anthropic page. */
export const ANTHROPIC_CACHE_MINIMUMS_READ_ON = '2026-09-02';

/** The page the table below was read from; re-read it before trusting a row. */
export const ANTHROPIC_CACHE_MINIMUMS_SOURCE_URL =
  'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';

/**
 * Published minimum cacheable prefix sizes, per model id prefix, as read on
 * {@link ANTHROPIC_CACHE_MINIMUMS_READ_ON}. Matching is longest-prefix so a more
 * specific row (claude-opus-4-7) wins over a shorter one that also matches.
 * Anthropic models absent from this table have an unknown minimum.
 */
export const ANTHROPIC_MIN_CACHEABLE_TOKENS_BY_MODEL: readonly {
  readonly modelIdPrefix: string;
  readonly minimumTokens: number;
}[] = [
  { modelIdPrefix: 'claude-opus-5', minimumTokens: 512 },
  { modelIdPrefix: 'claude-opus-4-7', minimumTokens: 2048 },
  { modelIdPrefix: 'claude-opus-4-6', minimumTokens: 4096 },
  { modelIdPrefix: 'claude-opus-4-5', minimumTokens: 4096 },
  { modelIdPrefix: 'claude-haiku-4-5', minimumTokens: 4096 },
  { modelIdPrefix: 'claude-haiku-3-5', minimumTokens: 2048 },
];

/** Providers piko speaks to directly; mirrors Profile.provider. */
export type CacheProviderName = 'anthropic' | 'openai';

/** Anthropic is the only supported provider that exposes cache lifetime. */
export const ANTHROPIC_CACHE_TTL_VALUES = ['5m', '1h'] as const;
export type AnthropicCacheTtl = (typeof ANTHROPIC_CACHE_TTL_VALUES)[number];

export function validateAnthropicCacheTtl(value: unknown, path: string): AnthropicCacheTtl {
  if (typeof value !== 'string' || !(ANTHROPIC_CACHE_TTL_VALUES as readonly string[]).includes(value)) {
    throw new TypeError(`${path} must be one of ${ANTHROPIC_CACHE_TTL_VALUES.join(', ')}`);
  }
  return value as AnthropicCacheTtl;
}

/**
 * The published minimum for one model, or undefined when piko carries no row
 * for it. OpenAI publishes a single number for the whole line; Anthropic
 * publishes one per model, so an unlisted Anthropic model is unknown rather
 * than defaulted.
 */
export function minimumCacheableTokens(provider: CacheProviderName, model: string): number | undefined {
  if (provider === 'openai') return OPENAI_MIN_CACHEABLE_TOKENS;
  let matched: { readonly modelIdPrefix: string; readonly minimumTokens: number } | undefined;
  for (const row of ANTHROPIC_MIN_CACHEABLE_TOKENS_BY_MODEL) {
    if (!model.startsWith(row.modelIdPrefix)) continue;
    if (!matched || row.modelIdPrefix.length > matched.modelIdPrefix.length) matched = row;
  }
  return matched?.minimumTokens;
}

export interface CacheEligibilityInput {
  readonly provider: CacheProviderName;
  readonly model: string;
  /** Estimated tokens in the fixed prefix (tool schemas plus system prompt). */
  readonly prefixTokens: number;
}

export interface CacheEligibility extends CacheEligibilityInput {
  /** undefined when piko carries no published minimum for this model. */
  readonly minimumTokens?: number;
  /** undefined when the minimum is unknown: no conclusion is drawn. */
  readonly eligible?: boolean;
}

export function cacheEligibility(input: CacheEligibilityInput): CacheEligibility {
  if (!Number.isFinite(input.prefixTokens) || input.prefixTokens < 0) {
    throw new RangeError('prefixTokens must be a nonnegative finite number');
  }
  const minimumTokens = minimumCacheableTokens(input.provider, input.model);
  if (minimumTokens === undefined) return { ...input };
  return { ...input, minimumTokens, eligible: input.prefixTokens >= minimumTokens };
}

/**
 * One line, safe for stderr and for the budget gate. It states the measurement
 * and the consequence, because the consequence (0001's caching inversion) is
 * the part a reader is entitled to know without reading an ADR. The consequence
 * is stated as an expectation, never as a definite claim about the provider's
 * behavior, and a model with no published minimum in the table draws no
 * conclusion at all.
 */
export function describeCacheEligibility(input: CacheEligibilityInput): string {
  const { provider, model, prefixTokens, minimumTokens, eligible } = cacheEligibility(input);
  if (minimumTokens === undefined) {
    return (
      `cache eligibility: ${provider}/${model}: fixed prefix ~${prefixTokens} tokens; ` +
      `the minimum cacheable size for this model is unknown to piko (no row in the ` +
      `${ANTHROPIC_CACHE_MINIMUMS_READ_ON} table in packages/ai/src/cache.ts), so no conclusion is drawn; ` +
      `check ${ANTHROPIC_CACHE_MINIMUMS_SOURCE_URL}`
    );
  }
  const measurement = `${provider}/${model}: fixed prefix ~${prefixTokens} tokens vs ${minimumTokens}-token minimum cacheable size`;
  return eligible
    ? `cache eligibility: ${measurement}; the fixed prefix is large enough to cache`
    : `cache eligibility: ${measurement}; the fixed prefix is below the published minimum and is not expected to cache (ADR 0001 caching inversion), so savings come from the per-turn working set`;
}
