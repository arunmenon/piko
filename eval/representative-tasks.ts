import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalTask } from './tasks.js';

function commandPasses(dir: string, command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { cwd: dir, encoding: 'utf8', timeout: 20_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function nodeCheck(dir: string, source: string): boolean {
  return commandPasses(dir, 'node', ['--input-type=module', '-e', source]);
}

function pythonCheck(dir: string, source: string): boolean {
  return commandPasses(dir, 'python3', ['-c', source]);
}

function filesUnchanged(dir: string, files: Record<string, string>, names: string[]): boolean {
  return names.every((name) => {
    try { return readFileSync(join(dir, name), 'utf8') === files[name]; }
    catch { return false; }
  });
}

export interface Qualification {
  task: EvalTask;
  applyCorrect(dir: string): void;
  applyWrong: Array<(dir: string) => void>;
}

function integrationRepair(name: string, confirmation = false): Qualification {
  const files: Record<string, string> = {
    'package.json': '{"name":"request-gateway","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    'src/errors.js': "export class InputError extends Error { constructor(message) { super(message); this.name = 'InputError'; } }\n",
    'src/parse.js': "import { InputError } from './errors.js';\nexport function parseRequest(raw) {\n  if (!raw || typeof raw.user !== 'string' || !raw.user.trim()) throw new InputError('user is required');\n  return { user: raw.user.trim(), action: raw.action ?? 'view' };\n}\n",
    'src/audit.js': "export function auditLine(request) { return `${request.user}:${request.action}`; }\n",
    'src/handle.js': confirmation
      ? "import { parseRequest } from './parse.js';\nimport { auditLine } from './audit.js';\nexport function handle(raw) {\n  try { const request = parseRequest(raw); return { status: 200, body: { ok: true }, audit: auditLine(request) }; }\n  catch (error) { return { status: 422, body: { error: 'invalid request' }, audit: null }; }\n}\n"
      : "import { InputError } from './errors.js';\nimport { parseRequest } from './parse.js';\nimport { auditLine } from './audit.js';\nexport function handle(raw) {\n  try { const request = parseRequest(raw); return { status: 200, body: { ok: true }, audit: auditLine(request) }; }\n  catch (error) {\n    return { status: error instanceof InputError ? 500 : 500, body: { error: 'invalid request' }, audit: null };\n  }\n}\n",
    'src/index.js': "export { handle } from './handle.js';\nexport { parseRequest } from './parse.js';\n",
    'test/unit.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; import { parseRequest } from '../src/index.js';\ntest('parses valid requests', () => assert.deepEqual(parseRequest({user:' Ada ',action:'edit'}), {user:'Ada',action:'edit'}));\n",
    'test/integration.test.js': confirmation
      ? "import test from 'node:test'; import assert from 'node:assert/strict'; import { handle } from '../src/index.js';\ntest('malformed input uses the public bad-request contract', () => assert.deepEqual(handle({user:' '}), {status:400,body:{error:'user is required'},audit:null}));\ntest('valid input is unchanged', () => assert.deepEqual(handle({user:'Ada'}), {status:200,body:{ok:true},audit:'Ada:view'}));\n"
      : "import test from 'node:test'; import assert from 'node:assert/strict'; import { handle } from '../src/index.js';\ntest('input errors are client errors', () => assert.deepEqual(handle({user:' '}), {status:400,body:{error:'user is required'},audit:null}));\ntest('valid requests still succeed', () => assert.deepEqual(handle({user:'Ada'}), {status:200,body:{ok:true},audit:'Ada:view'}));\n",
    'README.md': '# Request gateway\n\nSmall request parsing and audit pipeline. Public errors must not expose stack traces.\n',
  };
  const task: EvalTask = {
    name,
    files,
    prompt: 'The integration test for malformed requests is failing. Diagnose the regression and repair the implementation while preserving valid-request behavior. Run the repository tests to validate the fix.',
    verify(dir) {
      const protectedFiles = ['test/unit.test.js', 'test/integration.test.js'];
      if (!filesUnchanged(dir, files, protectedFiles) || !commandPasses(dir, 'node', ['--test'])) return false;
      return nodeCheck(dir, `
        import assert from 'node:assert/strict';
        import { handle } from './src/index.js';
        assert.deepEqual(handle({ user: '\\t' }), { status: 400, body: { error: 'user is required' }, audit: null });
        assert.deepEqual(handle({ user: ' Lin ', action: 'deploy' }), { status: 200, body: { ok: true }, audit: 'Lin:deploy' });
      `);
    },
  };
  return {
    task,
    applyCorrect(dir) {
      const source = readFileSync(join(dir, 'src/handle.js'), 'utf8');
      if (confirmation) {
        writeFileSync(join(dir, 'src/handle.js'), source
          .replace("import { parseRequest }", "import { InputError } from './errors.js';\nimport { parseRequest }")
          .replace("catch (error) { return { status: 422, body: { error: 'invalid request' }, audit: null }; }", "catch (error) { return { status: error instanceof InputError ? 400 : 500, body: { error: error instanceof InputError ? error.message : 'internal error' }, audit: null }; }"));
      } else {
        writeFileSync(join(dir, 'src/handle.js'), source.replace("status: error instanceof InputError ? 500 : 500, body: { error: 'invalid request' }", "status: error instanceof InputError ? 400 : 500, body: { error: error instanceof InputError ? error.message : 'internal error' }"));
      }
    },
    applyWrong: [
      (dir) => writeFileSync(join(dir, 'test/integration.test.js'), files['test/integration.test.js']!.replace('status:400', confirmation ? 'status:422' : 'status:500')),
      (dir) => writeFileSync(join(dir, 'src/handle.js'), readFileSync(join(dir, 'src/handle.js'), 'utf8').replace('status: 200', 'status: 400')),
    ],
  };
}

function crossFileChange(name: string, confirmation = false): Qualification {
  const files: Record<string, string> = confirmation ? {
    'pyproject.toml': '[project]\nname="record-export"\nversion="0.1.0"\n',
    'record_export/__init__.py': 'from .format import format_record\nfrom .batch import export_batch\n',
    'record_export/format.py': "def format_record(record):\n    return f\"{record['id']}|{record['name'].strip()}\"\n",
    'record_export/batch.py': 'from .format import format_record\ndef export_batch(records):\n    return "\\n".join(format_record(record) for record in records)\n',
    'record_export/cli.py': 'import json, sys\nfrom .batch import export_batch\ndef main(argv=None):\n    rows=json.load(sys.stdin)\n    print(export_batch(rows))\n    return 0\n',
    'tests/test_existing.py': "import unittest\nfrom record_export import format_record, export_batch\nclass Existing(unittest.TestCase):\n def test_default(self): self.assertEqual(format_record({'id':2,'name':' Ada '}),'2|Ada')\n def test_batch(self): self.assertEqual(export_batch([{'id':1,'name':'A'},{'id':2,'name':'B'}]),'1|A\\n2|B')\nif __name__=='__main__': unittest.main()\n",
    'README.md': '# record-export\n\nFormats records for downstream import.\n',
  } : {
    'package.json': '{"name":"label-kit","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    'src/options.js': "export function options(value={}) { return { separator: value.separator ?? ':' }; }\n",
    'src/format.js': "import { options } from './options.js';\nexport function formatLabel(key, value, config) { const { separator } = options(config); return `${key}${separator}${value}`; }\n",
    'src/list.js': "import { formatLabel } from './format.js';\nexport function formatList(entries, config) { return entries.map(([key,value]) => formatLabel(key,value,config)).join('\\n'); }\n",
    'src/cli.js': "import { formatList } from './list.js';\nexport function run(argv, entries) { const separator = argv[0] === '--separator' ? argv[1] : undefined; return formatList(entries, { separator }); }\n",
    'src/index.js': "export { formatLabel } from './format.js'; export { formatList } from './list.js'; export { run } from './cli.js';\n",
    'test/existing.test.js': "import test from 'node:test'; import assert from 'node:assert/strict'; import { formatLabel,formatList } from '../src/index.js';\ntest('existing defaults',()=>{assert.equal(formatLabel('a','b'),'a:b');assert.equal(formatList([['a','b'],['c','d']]),'a:b\\nc:d')});\n",
    'README.md': '# label-kit\n\nFormats labels for configuration displays.\n',
  };
  const task: EvalTask = {
    name,
    files,
    prompt: confirmation
      ? 'Add an optional prefix string to both single-record and batch formatting. Preserve all existing output when the option is omitted, expose the option through the package API, and update the implementation across files. Validate existing and new behavior.'
      : 'Add an optional prefix string supported consistently by formatLabel, formatList, and run. Existing callers that omit the option must behave exactly as before. Implement the cross-file change and validate it.',
    verify(dir) {
      const protectedFiles = confirmation ? ['tests/test_existing.py'] : ['test/existing.test.js'];
      if (!filesUnchanged(dir, files, protectedFiles)) return false;
      if (confirmation) {
        if (!commandPasses(dir, 'python3', ['-m', 'unittest', 'discover', '-s', 'tests'])) return false;
        return pythonCheck(dir, "from record_export import format_record,export_batch\nassert format_record({'id':3,'name':' C '},{'prefix':'v1/'})=='v1/3|C'\nassert export_batch([{'id':1,'name':'A'},{'id':2,'name':'B'}],{'prefix':'x-'})=='x-1|A\\nx-2|B'\nassert format_record({'id':4,'name':'D'})=='4|D'");
      }
      if (!commandPasses(dir, 'node', ['--test'])) return false;
      return nodeCheck(dir, `
        import assert from 'node:assert/strict'; import { formatLabel,formatList,run } from './src/index.js';
        assert.equal(formatLabel('a','b',{prefix:'env/'}),'env/a:b');
        assert.equal(formatList([['a','b'],['c','d']],{prefix:'x-'}),'x-a:b\\nx-c:d');
        assert.equal(run(['--prefix','p/'],[['a','b']]),'p/a:b');
        assert.equal(formatLabel('a','b'),'a:b');
      `);
    },
  };
  return {
    task,
    applyCorrect(dir) {
      if (confirmation) {
        writeFileSync(join(dir, 'record_export/format.py'), "def format_record(record, options=None):\n    options=options or {}\n    return f\"{options.get('prefix','')}{record['id']}|{record['name'].strip()}\"\n");
        writeFileSync(join(dir, 'record_export/batch.py'), "from .format import format_record\ndef export_batch(records, options=None):\n    return '\\n'.join(format_record(record, options) for record in records)\n");
      } else {
        writeFileSync(join(dir, 'src/options.js'), "export function options(value={}) { return { separator: value.separator ?? ':', prefix: value.prefix ?? '' }; }\n");
        writeFileSync(join(dir, 'src/format.js'), "import { options } from './options.js';\nexport function formatLabel(key,value,config){const {separator,prefix}=options(config);return `${prefix}${key}${separator}${value}`;}\n");
        writeFileSync(join(dir, 'src/cli.js'), "import { formatList } from './list.js';\nexport function run(argv,entries){let config={};if(argv[0]==='--separator')config.separator=argv[1];if(argv[0]==='--prefix')config.prefix=argv[1];return formatList(entries,config);}\n");
      }
    },
    applyWrong: confirmation ? [
      (dir) => writeFileSync(join(dir, 'record_export/format.py'), "def format_record(record, options=None): return 'v1/'+str(record['id'])+'|'+record['name'].strip()\n"),
      (dir) => writeFileSync(join(dir, 'tests/test_existing.py'), '# disabled\n'),
    ] : [
      (dir) => writeFileSync(join(dir, 'src/format.js'), "export function formatLabel(key,value,config={}){return `${config.prefix??''}${key}:${value}`;}\n"),
      (dir) => writeFileSync(join(dir, 'test/existing.test.js'), '// skipped\n'),
    ],
  };
}

function regressionRepair(name: string, confirmation = false): Qualification {
  const files: Record<string, string> = confirmation ? {
    'package.json': '{"name":"job-queue","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    'src/deferred.js': "export function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}\n",
    'src/queue.js': "import { deferred } from './deferred.js';\nexport class Queue { constructor(){this.jobs=new Map()} start(id,worker){const done=deferred();this.jobs.set(id,{worker,done});worker.start().then(v=>done.resolve({status:'done',value:v}));return done.promise} cancel(id){const job=this.jobs.get(id);if(!job)return false;job.worker.stop();this.jobs.delete(id);return true} }\n",
    'src/index.js': "export { Queue } from './queue.js';\n",
    'test/queue.test.js': "import test from 'node:test';import assert from 'node:assert/strict';import {Queue} from '../src/index.js';\ntest('normal completion',async()=>{const q=new Queue();const worker={start:async()=>7,stop(){}};assert.deepEqual(await q.start('a',worker),{status:'done',value:7})});\n",
    'README.md': '# job-queue\n\nCoordinates cancellable asynchronous workers.\n',
  } : {
    'pyproject.toml': '[project]\nname="config-ledger"\nversion="0.1.0"\n',
    'ledger/__init__.py': 'from .reader import read_entries\n',
    'ledger/decode.py': "import json\ndef decode(line):\n data=json.loads(line)\n if data.get('version')==1:return {'key':data['name'],'value':data['value']}\n return {'key':data['key'],'value':data['value']}\n",
    'ledger/reader.py': "from .decode import decode\ndef read_entries(text):\n rows=[]\n for line in text.splitlines():\n  if not line.strip(): continue\n  rows.append(decode(line))\n return rows[-1:]\n",
    'ledger/merge.py': "def merge(entries):\n return {entry['key']:entry['value'] for entry in entries}\n",
    'ledger/api.py': "from .reader import read_entries\nfrom .merge import merge\ndef load(text): return merge(read_entries(text))\n",
    'tests/test_reader.py': "import unittest\nfrom ledger.reader import read_entries\nclass Reader(unittest.TestCase):\n def test_single(self): self.assertEqual(read_entries('{\"version\":2,\"key\":\"a\",\"value\":1}'),[{'key':'a','value':1}])\nif __name__=='__main__': unittest.main()\n",
    'tests/test_api.py': "import unittest\nfrom ledger.api import load\nclass Api(unittest.TestCase):\n def test_history(self): self.assertEqual(load('{\"version\":1,\"name\":\"a\",\"value\":1}\\n{\"version\":2,\"key\":\"b\",\"value\":2}'),{'a':1,'b':2})\nif __name__=='__main__': unittest.main()\n",
    'README.md': '# config-ledger\n\nReads mixed-version append-only configuration ledgers.\n',
  };
  const task: EvalTask = {
    name,
    files,
    prompt: confirmation
      ? 'A cancellation regression leaves callers waiting forever. Investigate the queue lifecycle and repair cancellation so the worker is stopped and the pending result settles, without changing normal completion behavior. Validate the fix.'
      : 'A regression causes mixed-version ledger history to lose earlier entries. Investigate and repair it while preserving decoding behavior and validating the full repository tests.',
    verify(dir) {
      const protectedFiles = confirmation ? ['test/queue.test.js'] : ['tests/test_reader.py', 'tests/test_api.py'];
      if (!filesUnchanged(dir, files, protectedFiles)) return false;
      if (confirmation) {
        if (!commandPasses(dir, 'node', ['--test'])) return false;
        return nodeCheck(dir, `
          import assert from 'node:assert/strict'; import {Queue} from './src/index.js';
          let stopped=0; const q=new Queue();
          const worker={start:()=>new Promise(()=>{}),stop(){stopped++}};
          const result=q.start('x',worker); assert.equal(q.cancel('x'),true);
          assert.deepEqual(await Promise.race([result,new Promise(r=>setTimeout(()=>r('timeout'),50))]),{status:'canceled'});
          assert.equal(stopped,1); assert.equal(q.cancel('x'),false);
        `);
      }
      if (!commandPasses(dir, 'python3', ['-m', 'unittest', 'discover', '-s', 'tests'])) return false;
      return pythonCheck(dir, "from ledger.api import load\ntext='{\"version\":1,\"name\":\"x\",\"value\":1}\\n{\"version\":2,\"key\":\"x\",\"value\":2}\\n{\"version\":2,\"key\":\"y\",\"value\":3}'\nassert load(text)=={'x':2,'y':3}");
    },
  };
  return {
    task,
    applyCorrect(dir) {
      if (confirmation) {
        writeFileSync(join(dir, 'src/queue.js'), "import { deferred } from './deferred.js';\nexport class Queue { constructor(){this.jobs=new Map()} start(id,worker){const done=deferred();this.jobs.set(id,{worker,done});worker.start().then(v=>{if(this.jobs.delete(id))done.resolve({status:'done',value:v})});return done.promise} cancel(id){const job=this.jobs.get(id);if(!job)return false;job.worker.stop();job.done.resolve({status:'canceled'});this.jobs.delete(id);return true} }\n");
      } else {
        writeFileSync(join(dir, 'ledger/reader.py'), "from .decode import decode\ndef read_entries(text):\n rows=[]\n for line in text.splitlines():\n  if line.strip(): rows.append(decode(line))\n return rows\n");
      }
    },
    applyWrong: confirmation ? [
      (dir) => writeFileSync(join(dir, 'src/queue.js'), readFileSync(join(dir, 'src/queue.js'), 'utf8').replace('job.worker.stop();', "job.worker.stop();job.done.resolve({status:'done',value:null});")),
      (dir) => writeFileSync(join(dir, 'test/queue.test.js'), '// removed\n'),
    ] : [
      (dir) => writeFileSync(join(dir, 'ledger/reader.py'), "from .decode import decode\ndef read_entries(text): return [decode(text.splitlines()[0])]\n"),
      (dir) => writeFileSync(join(dir, 'tests/test_api.py'), '# disabled\n'),
    ],
  };
}

export const representativeQualifications: Qualification[] = [
  integrationRepair('coding-dev-integration'),
  crossFileChange('coding-dev-cross-file'),
  regressionRepair('coding-dev-regression'),
  integrationRepair('coding-confirm-integration', true),
  crossFileChange('coding-confirm-cross-file', true),
  regressionRepair('coding-confirm-regression', true),
];

export const representativeDevelopment = representativeQualifications.slice(0, 3).map(({ task }) => task);
export const representativeConfirmation = representativeQualifications.slice(3).map(({ task }) => task);
export const representativeSuites: Record<string, EvalTask[]> = {
  'representative-development': representativeDevelopment,
  'representative-confirmation': representativeConfirmation,
};
