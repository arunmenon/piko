import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEvalOutcome, parseUsageSummary, type UsageSummary } from './result.js';

const usage: UsageSummary = {
  usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  cost: {
    usd: 0.0012,
    actualUSD: 0.0012,
    reservedUSD: 0,
    pricedRequests: 1,
    unpricedRequests: 0,
    unknownRequests: 0,
    complete: true,
  },
  requests: 1,
  session: '/tmp/session.jsonl',
  status: 'completed',
};

function processResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    signal: null,
    error: undefined,
    stderr: '',
    ...overrides,
  } as Parameters<typeof classifyEvalOutcome>[0];
}

test('parseUsageSummary ignores other JSON and validates counters', () => {
  const stderr = [
    '{"event":"tool"}',
    JSON.stringify({ usage: { inputTokens: 999, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, requests: 77 }),
    '{bad json}',
    JSON.stringify({ v: 1, type: 'usage_summary', ...usage }),
  ].join('\n');
  assert.deepEqual(parseUsageSummary(stderr), usage);
  assert.equal(parseUsageSummary('{"v":1,"type":"usage_summary","usage":{"inputTokens":1},"requests":1}'), undefined);
  assert.equal(
    parseUsageSummary(
      '{"v":1,"type":"usage_summary","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},"cost":{"actualUSD":"free"},"requests":1}',
    ),
    undefined,
  );
});

test('successful files do not hide process failures', () => {
  const verified = { passed: true };
  assert.equal(classifyEvalOutcome(processResult({ status: 7 }), verified, usage).reason, 'nonzero_exit');
  assert.equal(classifyEvalOutcome(processResult({ signal: 'SIGTERM' }), verified, usage).reason, 'signal');
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  assert.equal(classifyEvalOutcome(processResult({ status: null, error: timeout }), verified, usage).reason, 'timeout');
  const spawnError = Object.assign(new Error('missing executable'), { code: 'ENOENT' });
  assert.equal(classifyEvalOutcome(processResult({ status: null, error: spawnError }), verified, usage).reason, 'spawn_error');
});

test('incomplete terminal marker fails even if the process exits zero', () => {
  const outcome = classifyEvalOutcome(
    processResult({ stderr: 'run incomplete: provider stream ended prematurely after 1 model request(s)\n' }),
    { passed: true },
    usage,
  );
  assert.equal(outcome.reason, 'incomplete');
  assert.equal(outcome.pass, false);
  assert.equal(
    classifyEvalOutcome(
      processResult(),
      { passed: true },
      { ...usage, status: 'budget_exceeded', reason: 'tool call limit reached' },
    ).reason,
    'incomplete',
  );
});

test('usage and verification are required for a pass', () => {
  assert.equal(classifyEvalOutcome(processResult(), { passed: true }, undefined).reason, 'usage_missing');
  const { status: _status, ...withoutStatus } = usage;
  assert.equal(
    classifyEvalOutcome(processResult(), { passed: true }, withoutStatus).reason,
    'terminal_status_missing',
  );
  assert.equal(classifyEvalOutcome(processResult(), { passed: false }, usage).reason, 'verification_failed');
  assert.equal(classifyEvalOutcome(processResult(), { passed: false, error: 'boom' }, usage).reason, 'verification_error');
  assert.deepEqual(classifyEvalOutcome(processResult(), { passed: true }, usage), {
    pass: true,
    reason: 'completed',
  });
});
