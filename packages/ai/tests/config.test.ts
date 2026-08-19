import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config.js';

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
