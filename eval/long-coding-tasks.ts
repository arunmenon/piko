import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalTask } from './tasks.js';
import { representativeQualifications, type Qualification } from './representative-tasks.js';

const extras: Array<Record<string, string>> = [
  {
    'src/policy.js': "export function mayAudit(action){return action!=='health'}\n",
    'src/response.js': "export function response(status,body){return {status,body}}\n",
    'src/request-id.js': "export function requestId(sequence){return `req-${String(sequence).padStart(4,'0')}`}\n",
    'src/metrics.js': "export function metric(status){return status<400?'request.ok':'request.error'}\n",
    'test/support.test.js': "import test from 'node:test';import assert from 'node:assert/strict';import {mayAudit} from '../src/policy.js';import {requestId} from '../src/request-id.js';import {metric} from '../src/metrics.js';test('support contracts',()=>{assert.equal(mayAudit('edit'),true);assert.equal(mayAudit('health'),false);assert.equal(requestId(7),'req-0007');assert.equal(metric(400),'request.error')});\n",
    'docs/error-contract.md': '# Error contract\n\nInput errors are public client errors. Unexpected failures remain internal.\n',
  },
  {
    'src/parse-args.js': "export function pairs(argv){const out=[];for(let i=0;i<argv.length;i+=2)out.push([argv[i],argv[i+1]]);return out}\n",
    'src/validate.js': "export function validEntry(entry){return Array.isArray(entry)&&entry.length===2&&entry.every(v=>typeof v==='string')}\n",
    'src/table.js': "import {formatList} from './list.js';export function table(entries,config){return formatList(entries.filter(Boolean),config)}\n",
    'src/defaults.js': "export const DEFAULT_SEPARATOR=':';export const DEFAULT_PREFIX='';\n",
    'test/support.test.js': "import test from 'node:test';import assert from 'node:assert/strict';import {pairs} from '../src/parse-args.js';import {validEntry} from '../src/validate.js';import {table} from '../src/table.js';test('support behavior',()=>{assert.deepEqual(pairs(['--a','1','--b','2']),[['--a','1'],['--b','2']]);assert.equal(validEntry(['a','b']),true);assert.equal(table([['a','b']]),'a:b')});\n",
    'docs/compatibility.md': '# Compatibility\n\nOmitting all options must preserve the original label representation.\n',
  },
  {
    'ledger/validate.py': "def validate(entry):\n if not isinstance(entry.get('key'),str): raise ValueError('key')\n return entry\n",
    'ledger/stream.py': "from .decode import decode\ndef stream(lines):\n for line in lines:\n  if line.strip(): yield decode(line)\n",
    'ledger/export.py': "def export(entries):\n return '\\n'.join(f\"{e['key']}={e['value']}\" for e in entries)\n",
    'ledger/stats.py': "def count_keys(entries): return len({e['key'] for e in entries})\n",
    'tests/test_support.py': "import unittest\nfrom ledger.stream import stream\nfrom ledger.export import export\nfrom ledger.stats import count_keys\nclass Support(unittest.TestCase):\n def test_stream_export(self):\n  rows=list(stream(['{\"version\":2,\"key\":\"a\",\"value\":1}']))\n  self.assertEqual(export(rows),'a=1'); self.assertEqual(count_keys(rows),1)\nif __name__=='__main__': unittest.main()\n",
    'docs/formats.md': '# Ledger formats\n\nVersion 1 uses `name`; version 2 uses `key`. History order is significant.\n',
  },
];

const confirmationExtras: Array<Record<string, string>> = [
  extras[0]!,
  {
    'record_export/schema.py': "REQUIRED=('id','name')\ndef valid(record): return all(key in record for key in REQUIRED)\n",
    'record_export/stream.py': "from .format import format_record\ndef export_stream(records, options=None):\n for record in records: yield format_record(record, options)\n",
    'record_export/stats.py': "def count(records): return sum(1 for _ in records)\n",
    'tests/test_support.py': "import unittest\nfrom record_export.schema import valid\nfrom record_export.stream import export_stream\nclass Support(unittest.TestCase):\n def test_support(self):\n  self.assertTrue(valid({'id':1,'name':'A'})); self.assertEqual(list(export_stream([{'id':1,'name':' A '} ])),['1|A'])\nif __name__=='__main__': unittest.main()\n",
    'docs/format-contract.md': '# Format contract\n\nOptions apply identically to single-record, batch, and streaming paths.\n',
  },
  {
    'src/state.js': "export const RUNNING='running';export const DONE='done';export const CANCELED='canceled';\n",
    'src/result.js': "export function completed(value){return {status:'done',value}};export function canceled(){return {status:'canceled'}};\n",
    'src/registry.js': "export class Registry{constructor(){this.ids=new Set()}add(id){if(this.ids.has(id))throw new Error('duplicate');this.ids.add(id)}delete(id){return this.ids.delete(id)}}\n",
    'src/clock.js': "export function deadline(start,timeout){return start+timeout}\n",
    'test/support.test.js': "import test from 'node:test';import assert from 'node:assert/strict';import {Registry} from '../src/registry.js';import {completed,canceled} from '../src/result.js';test('support contracts',()=>{const r=new Registry();r.add('a');assert.equal(r.delete('a'),true);assert.deepEqual(completed(2),{status:'done',value:2});assert.deepEqual(canceled(),{status:'canceled'})});\n",
    'docs/lifecycle.md': '# Lifecycle\n\nEvery started job settles exactly once as done or canceled.\n',
  },
];

function protectedTestNames(files: Record<string, string>): string[] {
  return Object.keys(files).filter((name) => name.startsWith('test/') || name.startsWith('tests/'));
}

function longer(base: Qualification, name: string, extra: Record<string, string>, confirmation: boolean): Qualification {
  const files = { ...base.task.files, ...extra };
  const tests = protectedTestNames(files);
  const task: EvalTask = {
    ...base.task,
    name,
    files,
    prompt: `${base.task.prompt} Do not modify or remove existing tests; fix production code and use the tests only as evidence.${confirmation ? ' This task is reserved for confirmation and must not influence proposal selection.' : ''}`,
    verify(dir) {
      for (const test of tests) {
        try {
          if (readFileSync(join(dir, test), 'utf8') !== files[test]) return false;
        } catch { return false; }
      }
      return base.task.verify(dir);
    },
  };
  return { task, applyCorrect: base.applyCorrect, applyWrong: base.applyWrong };
}

export const longCodingQualifications: Qualification[] = [
  longer(representativeQualifications[0]!, 'long-dev-integration', extras[0]!, false),
  longer(representativeQualifications[1]!, 'long-dev-cross-file', extras[1]!, false),
  longer(representativeQualifications[2]!, 'long-dev-regression', extras[2]!, false),
  longer(representativeQualifications[3]!, 'long-confirm-integration', confirmationExtras[0]!, true),
  longer(representativeQualifications[4]!, 'long-confirm-cross-file', confirmationExtras[1]!, true),
  longer(representativeQualifications[5]!, 'long-confirm-regression', confirmationExtras[2]!, true),
];

export const longCodingDevelopment = longCodingQualifications.slice(0, 3).map(({ task }) => task);
export const longCodingConfirmation = longCodingQualifications.slice(3).map(({ task }) => task);
export const longCodingSuites: Record<string, EvalTask[]> = {
  'long-coding-development': longCodingDevelopment,
  'long-coding-confirmation': longCodingConfirmation,
};
