import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oneLine, red, sanitizeTerminalText, summarizeArgs } from '../src/render.js';

test('terminal sanitizer removes C0, ESC, DEL, and C1 controls but preserves newline and tab', () => {
  const raw = 'before\x1b[2Jafter\u009b31m\rrewrite\b!\x07\tok\nnext';
  const safe = sanitizeTerminalText(raw);

  assert.equal(safe, 'before[2Jafter31mrewrite!\tok\nnext');
  assert.doesNotMatch(safe, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
});

test('human-facing summaries neutralize terminal sequences before truncation', () => {
  assert.equal(oneLine('abc\x1b]52;c;payload\x07\nsecond', 100), 'abc]52;c;payload');
  assert.equal(summarizeArgs({ command: 'run\x1b[2J\rspoof' }), 'run[2Jspoof');

  const styled = red('failure\x1b]8;;https://example.invalid\x07label');
  assert.equal(styled.includes('\x1b]8'), false);
  assert.equal(styled.includes('\x07'), false);
});
