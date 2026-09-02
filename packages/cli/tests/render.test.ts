import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatCost,
  formatSpendStop,
  formatTurnIncomplete,
  oneLine,
  red,
  sanitizeTerminalText,
  summarizeArgs,
} from '../src/render.js';

test('terminal sanitizer removes C0, ESC, DEL, and C1 controls but preserves newline and tab', () => {
  const raw = 'before\x1b[2Jafter\u009b31m\rrewrite\b!\x07\tok\nnext';
  const safe = sanitizeTerminalText(raw);

  assert.equal(safe, 'before[2Jafter31mrewrite!\tok\nnext');
  assert.doesNotMatch(safe, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
});

test('cost formatting never presents incomplete pricing as zero dollars', () => {
  assert.equal(
    formatCost({ actualUSD: 0, reservedUSD: 0, pricedRequests: 0, unpricedRequests: 1, unknownRequests: 0 }),
    'unavailable (1 unpriced)',
  );
  assert.equal(
    formatCost({ actualUSD: 0.001, reservedUSD: 0, pricedRequests: 1, unpricedRequests: 0, unknownRequests: 0 }),
    '$0.001000',
  );
});

test('a spend stop prints the reservation, the spend, the ceiling, and the effective ceiling', () => {
  const line = formatSpendStop({ reservationUSD: 8.192, actualUSD: 0.002, reservedUSD: 1.5, ceilingUSD: 8.193 });

  assert.equal(
    line,
    'spend stop: reserved $8.192000 for the next request, spent $0.002000, ceiling $8.193000, ' +
      'effective ceiling $6.693000 (ceiling less $1.500000 outstanding reservations)',
  );
  // The line alone shows why the stop happened: reservation plus spend is above
  // the effective ceiling, with no journal read required.
  assert.ok(8.192 + 0.002 > 6.693);
});

test('a sub-microdollar spend stop still shows two significant digits, not a column of zeros', () => {
  const line = formatSpendStop({
    reservationUSD: 0.00000002,
    actualUSD: 0,
    reservedUSD: 0,
    ceilingUSD: 0.00000001,
  });

  assert.ok(!line.includes('e-'), line);
  assert.ok(!line.includes('$0.000000 '), `six decimals would round the explanation away: ${line}`);
  // The effective ceiling is genuinely zero here: effectiveSpendCeilingUSD
  // quantizes to microdollars, which is core arithmetic and not a rendering
  // artifact. The reservation and the configured ceiling stay distinguishable.
  assert.equal(
    line,
    'spend stop: reserved $0.000000020 for the next request, spent $0.000000000, ceiling $0.000000010, ' +
      'effective ceiling $0.000000000 (ceiling less $0.000000000 outstanding reservations)',
  );
  // The printed numbers keep the inequality that explains the stop.
  const printed = [...line.matchAll(/\$([0-9.]+)/g)].map((match) => Number(match[1]));
  const [reservation, spent, , effectiveCeiling] = printed;
  assert.ok(reservation! + spent! > effectiveCeiling!, line);
});

test('a large spend stop stays in plain decimal notation', () => {
  const line = formatSpendStop({
    reservationUSD: 2500.5,
    actualUSD: 1200.25,
    reservedUSD: 100,
    ceilingUSD: 1500,
  });

  assert.ok(!/e[+-]/i.test(line), line);
  assert.equal(
    line,
    'spend stop: reserved $2500.500000 for the next request, spent $1200.250000, ceiling $1500.000000, ' +
      'effective ceiling $1400.000000 (ceiling less $100.000000 outstanding reservations)',
  );
});

test('the eval fallback detector matches the exact line the CLI writes', () => {
  assert.equal(
    formatTurnIncomplete({ status: 'incomplete', reason: 'provider stream ended prematurely', iterations: 1, toolCalls: 0 }),
    'turn incomplete: provider stream ended prematurely after 1 model request(s) and 0 tool call(s)',
  );
});

test('human-facing summaries neutralize terminal sequences before truncation', () => {
  assert.equal(oneLine('abc\x1b]52;c;payload\x07\nsecond', 100), 'abc]52;c;payload');
  assert.equal(summarizeArgs({ command: 'run\x1b[2J\rspoof' }), 'run[2Jspoof');

  const styled = red('failure\x1b]8;;https://example.invalid\x07label');
  assert.equal(styled.includes('\x1b]8'), false);
  assert.equal(styled.includes('\x07'), false);
});
