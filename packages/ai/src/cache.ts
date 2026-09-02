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
 * Anthropic publishes the minimum per model family and has moved it between 512
 * and 4096 tokens across generations, so piko carries the two values the plan
 * names (1024 for the general case, 2048 for the Haiku class) as constants
 * rather than literals: they are configuration of a provider policy that
 * changes, not a piko invariant. ADR 0001 (two-number gate) and ADR 0014 (cache
 * measurement) both read them.
 */

export const ANTHROPIC_MIN_CACHEABLE_TOKENS = 1024;
export const ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS = 2048;
export const OPENAI_MIN_CACHEABLE_TOKENS = 1024;

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

/** The Haiku class carries a higher minimum than the rest of the Anthropic line. */
export function minimumCacheableTokens(provider: CacheProviderName, model: string): number {
  if (provider === 'openai') return OPENAI_MIN_CACHEABLE_TOKENS;
  return /haiku/i.test(model) ? ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS : ANTHROPIC_MIN_CACHEABLE_TOKENS;
}

export interface CacheEligibilityInput {
  readonly provider: CacheProviderName;
  readonly model: string;
  /** Estimated tokens in the fixed prefix (tool schemas plus system prompt). */
  readonly prefixTokens: number;
}

export interface CacheEligibility extends CacheEligibilityInput {
  readonly minimumTokens: number;
  readonly eligible: boolean;
}

export function cacheEligibility(input: CacheEligibilityInput): CacheEligibility {
  if (!Number.isFinite(input.prefixTokens) || input.prefixTokens < 0) {
    throw new RangeError('prefixTokens must be a nonnegative finite number');
  }
  const minimumTokens = minimumCacheableTokens(input.provider, input.model);
  return { ...input, minimumTokens, eligible: input.prefixTokens >= minimumTokens };
}

/**
 * One line, safe for stderr and for the budget gate. It states the measurement
 * and the consequence, because the consequence (0001's caching inversion) is
 * the part a reader is entitled to know without reading an ADR.
 */
export function describeCacheEligibility(input: CacheEligibilityInput): string {
  const { provider, model, prefixTokens, minimumTokens, eligible } = cacheEligibility(input);
  const measurement = `${provider}/${model}: fixed prefix ~${prefixTokens} tokens vs ${minimumTokens}-token minimum cacheable size`;
  return eligible
    ? `cache eligibility: ${measurement}; the fixed prefix is large enough to cache`
    : `cache eligibility: ${measurement}; the fixed prefix is below the minimum and will not cache (ADR 0001 caching inversion), so savings come from the per-turn working set`;
}
