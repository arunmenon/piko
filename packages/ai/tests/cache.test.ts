import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTHROPIC_MIN_CACHEABLE_TOKENS_BY_MODEL,
  OPENAI_MIN_CACHEABLE_TOKENS,
  cacheEligibility,
  describeCacheEligibility,
  minimumCacheableTokens,
  validateAnthropicCacheTtl,
} from '../src/cache.js';

test('the Anthropic minimum comes from the dated per-model table, longest prefix first', () => {
  // The published values differ per model, not per family: an Opus is not one number.
  assert.equal(minimumCacheableTokens('anthropic', 'claude-opus-5'), 512);
  assert.equal(minimumCacheableTokens('anthropic', 'claude-opus-4-7'), 2048);
  assert.equal(minimumCacheableTokens('anthropic', 'claude-opus-4-5'), 4096);
  assert.equal(minimumCacheableTokens('anthropic', 'claude-opus-4-6'), 4096);
  assert.equal(minimumCacheableTokens('anthropic', 'claude-haiku-4-5'), 4096);
  assert.equal(minimumCacheableTokens('anthropic', 'claude-haiku-3-5'), 2048);
  // Dated snapshots carry their id suffix; prefix matching still finds the row.
  assert.equal(minimumCacheableTokens('anthropic', 'claude-opus-4-7-20260101'), 2048);
  assert.equal(minimumCacheableTokens('openai', 'gpt-5'), OPENAI_MIN_CACHEABLE_TOKENS);
  // Every row is reachable through the public lookup.
  for (const row of ANTHROPIC_MIN_CACHEABLE_TOKENS_BY_MODEL) {
    assert.equal(minimumCacheableTokens('anthropic', row.modelIdPrefix), row.minimumTokens);
  }
});

test('an Anthropic model with no published row has an unknown minimum', () => {
  assert.equal(minimumCacheableTokens('anthropic', 'claude-sonnet-5'), undefined);
  const unknown = cacheEligibility({ provider: 'anthropic', model: 'claude-sonnet-5', prefixTokens: 815 });
  assert.equal(unknown.minimumTokens, undefined);
  assert.equal(unknown.eligible, undefined);
  const line = describeCacheEligibility({ provider: 'anthropic', model: 'claude-sonnet-5', prefixTokens: 815 });
  assert.match(line, /anthropic\/claude-sonnet-5: fixed prefix ~815 tokens/);
  assert.match(line, /minimum cacheable size for this model is unknown to piko/);
  assert.match(line, /no conclusion is drawn/);
  // No guessed number, and no claim either way about caching.
  assert.doesNotMatch(line, /minimum cacheable size; /);
  assert.doesNotMatch(line, /large enough to cache/);
  assert.doesNotMatch(line, /not expected to cache/);
});

test('the eligibility line reports the measurement and the consequence', () => {
  const below = describeCacheEligibility({ provider: 'anthropic', model: 'claude-opus-4-5', prefixTokens: 815 });
  assert.match(below, /anthropic\/claude-opus-4-5/);
  assert.match(below, /~815 tokens vs 4096-token minimum/);
  // Stated as an expectation against the published number, never as a definite claim.
  assert.match(below, /below the published minimum and is not expected to cache/);
  assert.doesNotMatch(below, /will not cache/);

  // The same prefix clears OpenAI's minimum only once it reaches 1024 tokens.
  const atMinimum = describeCacheEligibility({ provider: 'openai', model: 'gpt-5', prefixTokens: 1024 });
  assert.match(atMinimum, /large enough to cache/);

  // A prefix over 1024 still does not clear the Haiku 4.5 minimum of 4096.
  const haiku = cacheEligibility({ provider: 'anthropic', model: 'claude-haiku-4-5', prefixTokens: 1500 });
  assert.equal(haiku.minimumTokens, 4096);
  assert.equal(haiku.eligible, false);
  // The smallest published minimum is the one a small prefix can clear.
  const opus5 = cacheEligibility({ provider: 'anthropic', model: 'claude-opus-5', prefixTokens: 815 });
  assert.equal(opus5.minimumTokens, 512);
  assert.equal(opus5.eligible, true);

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
