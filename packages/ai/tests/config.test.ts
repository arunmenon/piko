import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProfile, validateConfig } from '../src/config.js';

test('validateConfig accepts typed profiles and extensions', () => {
  assert.deepEqual(
    validateConfig({
      defaultProfile: 'local',
      extensions: ['./tool.js'],
      profiles: {
        local: { provider: 'openai', model: 'qwen', baseUrl: 'http://localhost:8000/v1', contextWindow: 32768 },
      },
    }),
    {
      defaultProfile: 'local',
      extensions: ['./tool.js'],
      profiles: {
        local: { provider: 'openai', model: 'qwen', baseUrl: 'http://localhost:8000/v1', contextWindow: 32768 },
      },
    },
  );
});

test('validateConfig rejects malformed provider and budget fields', () => {
  assert.throws(() => validateConfig([]), /config must be an object/);
  assert.throws(() => validateConfig({ extensions: ['ok', 2] }), /extensions/);
  assert.throws(() => validateConfig({ profiles: { bad: { provider: 'mystery' } } }), /provider/);
  assert.throws(() => validateConfig({ profiles: { bad: { contextWindow: -1 } } }), /contextWindow/);
  assert.throws(() => validateConfig({ shutdownGraceSeconds: -1 }), /shutdownGraceSeconds/);
  assert.throws(() => validateConfig({ shutdownGraceSeconds: 1.5 }), /shutdownGraceSeconds/);
  assert.throws(() => validateConfig({ shutdownGraceSeconds: '10' }), /shutdownGraceSeconds/);
});

test('validateConfig accepts a shutdown grace period, including zero (ADR 0027)', () => {
  assert.equal(validateConfig({ shutdownGraceSeconds: 30 }).shutdownGraceSeconds, 30);
  assert.equal(validateConfig({ shutdownGraceSeconds: 0 }).shutdownGraceSeconds, 0);
  assert.equal(validateConfig({}).shutdownGraceSeconds, undefined);
});

test('approval gating is read from user config, per profile or as a default', () => {
  const config = validateConfig({
    approval: ['bash'],
    profiles: {
      strict: { provider: 'anthropic', model: 'm', apiKeyEnv: 'CFG_KEY', approval: '*' },
      lenient: { provider: 'anthropic', model: 'm', apiKeyEnv: 'CFG_KEY' },
    },
  });
  assert.deepEqual(config.approval, ['bash']);
  process.env['CFG_KEY'] = 'test-key';
  try {
    assert.equal(resolveProfile(config, 'strict').approval, '*');
    assert.deepEqual(resolveProfile(config, 'lenient').approval, ['bash'], 'the top-level setting is the default');
    assert.equal(resolveProfile(validateConfig({ profiles: config.profiles }), 'lenient').approval, undefined);
  } finally {
    delete process.env['CFG_KEY'];
  }
});

test('cacheTtl is a validated profile option that only Anthropic receives', () => {
  const config = validateConfig({
    profiles: {
      long: { provider: 'anthropic', model: 'm', apiKeyEnv: 'CFG_TTL_KEY', cacheTtl: '1h' },
      plain: { provider: 'anthropic', model: 'm', apiKeyEnv: 'CFG_TTL_KEY' },
      other: { provider: 'openai', model: 'm', apiKeyEnv: 'CFG_TTL_KEY', cacheTtl: '1h' },
    },
  });
  assert.equal(config.profiles?.['long']?.cacheTtl, '1h');
  process.env['CFG_TTL_KEY'] = 'test-key';
  try {
    assert.equal(resolveProfile(config, 'long').cacheTtl, '1h');
    assert.equal(resolveProfile(config, 'plain').cacheTtl, undefined, 'omitted means the provider default');
    // The option is carried on any profile; providerFor is what drops it for OpenAI.
    assert.equal(resolveProfile(config, 'other').cacheTtl, '1h');
  } finally {
    delete process.env['CFG_TTL_KEY'];
  }
  assert.throws(() => validateConfig({ profiles: { p: { cacheTtl: '30m' } } }), /profiles\.p\.cacheTtl must be one of 5m, 1h/);
  assert.throws(() => validateConfig({ profiles: { p: { cacheTtl: 3600 } } }), /profiles\.p\.cacheTtl/);
});

test('validateConfig rejects an approval policy that is neither "*" nor a list of tool names', () => {
  assert.throws(() => validateConfig({ approval: 'bash' }), /must be "\*" or an array/);
  assert.throws(() => validateConfig({ approval: ['bash', ''] }), /must be "\*" or an array/);
  assert.throws(() => validateConfig({ profiles: { p: { approval: 7 } } }), /profiles\.p\.approval/);
});
