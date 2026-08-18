import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface EvalTask {
  name: string;
  /** files written into the scratch dir before the agent runs */
  files: Record<string, string>;
  prompt: string;
  verify(dir: string): boolean;
}

function runNode(dir: string, file: string): string {
  try {
    return execFileSync('node', [file], { cwd: dir, encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return '<error>';
  }
}

export const tasks: EvalTask[] = [
  {
    name: 'create-file',
    files: {},
    prompt: 'Create a file greeting.txt containing exactly the text: hello world',
    verify: (dir) => existsSync(join(dir, 'greeting.txt')) && readFileSync(join(dir, 'greeting.txt'), 'utf8').trim() === 'hello world',
  },
  {
    name: 'fix-syntax-error',
    files: {
      'calc.js': 'function add(a, b {\n  return a + b;\n}\nconsole.log(add(3, 4));\n',
    },
    prompt: 'calc.js has a syntax error. Fix it so `node calc.js` prints 7.',
    verify: (dir) => runNode(dir, 'calc.js') === '7',
  },
  {
    name: 'rename-function',
    files: {
      'math.js': 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n',
      'main.js': "const { add } = require('./math.js');\nconsole.log(add(2, 2));\n",
    },
    prompt: 'Rename the function add to sum everywhere (definition, export, and all callers). `node main.js` must still print 4.',
    verify: (dir) =>
      runNode(dir, 'main.js') === '4' &&
      !readFileSync(join(dir, 'math.js'), 'utf8').includes('add') &&
      readFileSync(join(dir, 'math.js'), 'utf8').includes('sum'),
  },
  {
    name: 'bump-version',
    files: {
      'package.json': '{\n  "name": "demo",\n  "version": "1.4.2",\n  "private": true\n}\n',
    },
    prompt: 'Bump the version in package.json to 2.0.0.',
    verify: (dir) => (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version === '2.0.0',
  },
  {
    name: 'fix-off-by-one',
    files: {
      'range.js':
        'function rangeSum(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\nmodule.exports = { rangeSum };\n',
      'test.js':
        "const { rangeSum } = require('./range.js');\nif (rangeSum(5) !== 15) { console.error('FAIL: got ' + rangeSum(5)); process.exit(1); }\nconsole.log('PASS');\n",
    },
    prompt: 'rangeSum(5) should equal 15 (inclusive sum 1..n) but the test fails. Fix the bug and make `node test.js` pass.',
    verify: (dir) => runNode(dir, 'test.js') === 'PASS',
  },
  {
    name: 'new-module',
    files: {
      'index.js': "console.log('placeholder');\n",
    },
    prompt:
      'Create shout.js exporting a function shout(s) that returns s uppercased with "!" appended, and rewrite index.js to print shout("hey"). `node index.js` must print HEY!',
    verify: (dir) => runNode(dir, 'index.js') === 'HEY!',
  },
  {
    name: 'count-todos',
    files: {
      'a.js': '// TODO: refactor\nmodule.exports = 1;\n',
      'b.js': 'module.exports = 2;\n',
      'src/c.js': '// TODO: delete\nmodule.exports = 3;\n',
      'src/d.js': '/* TODO handle errors */\nmodule.exports = 4;\n',
    },
    prompt: 'Count how many .js files in this project contain the string TODO and write just that number to todo-count.txt.',
    verify: (dir) => readFileSync(join(dir, 'todo-count.txt'), 'utf8').trim() === '3',
  },
  {
    name: 'modernize-var',
    files: {
      'legacy.js':
        'var count = 0;\nvar step = 2;\nfor (var i = 0; i < 5; i++) {\n  count += step;\n}\nconsole.log(count);\n',
    },
    prompt: 'Replace every var declaration in legacy.js with let or const as appropriate. `node legacy.js` must still print 10.',
    verify: (dir) => runNode(dir, 'legacy.js') === '10' && !/\bvar\b/.test(readFileSync(join(dir, 'legacy.js'), 'utf8')),
  },
  {
    name: 'fibonacci',
    files: {},
    prompt: 'Write fib.js that prints the 10th Fibonacci number (1,1,2,... so the answer is 55) and verify it by running it.',
    verify: (dir) => runNode(dir, 'fib.js') === '55',
  },
  {
    name: 'multi-step-feature',
    files: {
      'math.js': 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n',
      'index.js': "const { add } = require('./math.js');\nconsole.log(add(1, 1));\n",
    },
    prompt:
      'Add a subtract(a, b) function to math.js, export it, and change index.js to print subtract(5, 2) instead. `node index.js` must print 3.',
    verify: (dir) => runNode(dir, 'index.js') === '3' && readdirSync(dir).includes('math.js'),
  },
];
