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

test('validateConfig rejects an approval policy that is neither "*" nor a list of tool names', () => {
  assert.throws(() => validateConfig({ approval: 'bash' }), /must be "\*" or an array/);
  assert.throws(() => validateConfig({ approval: ['bash', ''] }), /must be "\*" or an array/);
  assert.throws(() => validateConfig({ profiles: { p: { approval: 7 } } }), /profiles\.p\.approval/);
});
