import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/args.js';
import { interpolate } from '../src/templates.js';

test('parseArgs handles flags and positional prompt', () => {
  const args = parseArgs(['-p', '--model', 'm1', '--max-turns', '5', '--ext', 'a.ts', 'fix', 'the', 'bug']);
  assert.equal(args.print, true);
  assert.equal(args.model, 'm1');
  assert.equal(args.maxTurns, 5);
  assert.deepEqual(args.extensions, ['a.ts']);
  assert.equal(args.prompt, 'fix the bug');
});

test('parseArgs rejects missing values', () => {
  assert.throws(() => parseArgs(['--model']));
});

test('interpolate replaces every $ARGUMENTS occurrence', () => {
  const template = { name: 'review', body: 'Review $ARGUMENTS carefully. Focus: $ARGUMENTS', source: 'x' };
  assert.equal(interpolate(template, 'src/'), 'Review src/ carefully. Focus: src/');
});

test('interpolate passes $-sequences in arguments through literally', () => {
  const template = { name: 'echo', body: 'Run: $ARGUMENTS', source: 'x' };
  assert.equal(interpolate(template, "sed 's/x/[$&]/' and $$PID"), "Run: sed 's/x/[$&]/' and $$PID");
});
