import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS,
  ANTHROPIC_MIN_CACHEABLE_TOKENS,
  OPENAI_MIN_CACHEABLE_TOKENS,
  cacheEligibility,
  describeCacheEligibility,
  minimumCacheableTokens,
  validateAnthropicCacheTtl,
} from '../src/cache.js';

test('the minimum cacheable size is per provider, with the Haiku class higher', () => {
  assert.equal(minimumCacheableTokens('anthropic', 'claude-sonnet-5'), ANTHROPIC_MIN_CACHEABLE_TOKENS);
  assert.equal(minimumCacheableTokens('anthropic', 'claude-haiku-4-5'), ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS);
  assert.equal(minimumCacheableTokens('openai', 'gpt-5'), OPENAI_MIN_CACHEABLE_TOKENS);
});

test('the eligibility line reports the measurement and the consequence', () => {
  const below = describeCacheEligibility({ provider: 'anthropic', model: 'claude-sonnet-5', prefixTokens: 815 });
  assert.match(below, /anthropic\/claude-sonnet-5/);
  assert.match(below, /~815 tokens vs 1024-token minimum/);
  assert.match(below, /below the minimum and will not cache/);

  // The same prefix clears OpenAI's minimum only once it reaches 1024 tokens.
  const atMinimum = describeCacheEligibility({ provider: 'openai', model: 'gpt-5', prefixTokens: 1024 });
  assert.match(atMinimum, /large enough to cache/);

  // The Haiku class is the case where a prefix over 1024 still does not cache.
  const haiku = cacheEligibility({ provider: 'anthropic', model: 'claude-haiku-4-5', prefixTokens: 1500 });
  assert.equal(haiku.minimumTokens, ANTHROPIC_HAIKU_MIN_CACHEABLE_TOKENS);
  assert.equal(haiku.eligible, false);

  assert.throws(
    () => describeCacheEligibility({ provider: 'openai', model: 'gpt-5', prefixTokens: -1 }),
    /nonnegative finite number/,
  );
});

test('cache TTL accepts only the values Anthropic documents', () => {
  assert.equal(validateAnthropicCacheTtl('5m', 'profiles.p.cacheTtl'), '5m');
  assert.equal(validateAnthropicCacheTtl('1h', 'profiles.p.cacheTtl'), '1h');
  for (const rejected of ['1m', '2h', '3600', 3600, '', null, {}]) {
    assert.throws(() => validateAnthropicCacheTtl(rejected, 'profiles.p.cacheTtl'), /must be one of 5m, 1h/);
  }
});
