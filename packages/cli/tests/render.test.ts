import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCost, formatSpendStop, oneLine, red, sanitizeTerminalText, summarizeArgs } from '../src/render.js';

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

test('human-facing summaries neutralize terminal sequences before truncation', () => {
  assert.equal(oneLine('abc\x1b]52;c;payload\x07\nsecond', 100), 'abc]52;c;payload');
  assert.equal(summarizeArgs({ command: 'run\x1b[2J\rspoof' }), 'run[2Jspoof');

  const styled = red('failure\x1b]8;;https://example.invalid\x07label');
  assert.equal(styled.includes('\x1b]8'), false);
  assert.equal(styled.includes('\x07'), false);
});
