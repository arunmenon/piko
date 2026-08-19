import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES,
  defaultTools,
  validateTool,
  validateToolArguments,
  validateToolSet,
  type Tool,
} from '../src/tools/index.js';

function makeTool(name = 'example', overrides: Record<string, unknown> = {}): Tool {
  return {
    name,
    description: 'A small test tool.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    ...overrides,
  } as Tool;
}

test('validateToolSet accepts built-ins and returns a shallow copy', () => {
  const builtins = defaultTools();
  const validated = validateToolSet(builtins);
  assert.notEqual(validated, builtins);
  assert.deepEqual(validated, builtins);
  assert.equal(DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES, 8192);
});

test('tool names use the provider-safe interoperable format', () => {
  for (const name of ['', 'has space', 'dot.name', 'x'.repeat(65)]) {
    assert.throws(() => validateTool(makeTool(name)), /name must match/);
  }
  assert.equal(validateTool(makeTool('Alpha_2-beta')).name, 'Alpha_2-beta');
});

test('tool descriptions, executors, and top-level argument schemas are required', () => {
  assert.throws(() => validateTool(makeTool('blank', { description: '  ' })), /description must be a nonempty/);
  assert.throws(() => validateTool(makeTool('executor', { execute: 'not callable' })), /execute must be a function/);
  assert.throws(
    () => validateTool(makeTool('array-parameters', { parameters: { type: 'array', properties: {} } })),
    /type "object" and properties/,
  );
  assert.throws(
    () => validateTool(makeTool('array-properties', { parameters: { type: 'object', properties: [] } })),
    /type "object" and properties/,
  );
});

test('malformed nested schemas and non-JSON data are rejected', () => {
  assert.throws(
    () =>
      validateTool(
        makeTool('bad-property', {
          parameters: { type: 'object', properties: { value: 'string' } },
        }),
      ),
    /properties\.value must be a JSON Schema object/,
  );
  assert.throws(
    () =>
      validateTool(
        makeTool('bad-required', {
          parameters: { type: 'object', properties: {}, required: ['value', 'value'] },
        }),
      ),
    /required must be an array of unique strings/,
  );
  assert.throws(
    () =>
      validateTool(
        makeTool('bad-value', {
          parameters: { type: 'object', properties: {}, default: undefined },
        }),
      ),
    /JSON-compatible values/,
  );
  assert.throws(
    () =>
      validateTool(
        makeTool('unsupported-assertion', {
          parameters: { type: 'object', properties: { value: { type: 'string', pattern: '^safe$' } } },
        }),
      ),
    /unsupported JSON Schema keyword "pattern"/,
  );
  assert.throws(
    () =>
      validateTool(
        makeTool('undefined-required', {
          parameters: { type: 'object', properties: {}, required: ['missing'] },
        }),
      ),
    /required names undefined property "missing"/,
  );
});

test('duplicate names are rejected across a complete tool set', () => {
  assert.throws(
    () => validateToolSet([makeTool('same'), makeTool('same')], { source: 'configured tools' }),
    /configured tools: duplicate tool name "same"/,
  );
});

test('aggregate serialized schemas have a configurable byte limit', () => {
  const tools = [makeTool('one'), makeTool('two')];
  assert.throws(
    () => validateToolSet(tools, { maxSchemaBytes: 100, source: 'configured tools' }),
    /serialized schemas total .*limit 100/,
  );
  assert.equal(validateToolSet(tools, { maxSchemaBytes: 4096 }).length, 2);
  assert.throws(() => validateToolSet(tools, { maxSchemaBytes: 0 }), /positive safe integer/);
});

test('validateToolArguments enforces required fields, nested types, and additionalProperties', () => {
  const tool = makeTool('strict', {
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        options: {
          type: 'object',
          properties: { retries: { type: 'integer', minimum: 0 } },
          required: ['retries'],
          additionalProperties: false,
        },
      },
      required: ['path', 'options'],
      additionalProperties: false,
    },
  });

  assert.doesNotThrow(() => validateToolArguments(tool, { path: 'src/a.ts', options: { retries: 2 } }));
  assert.throws(() => validateToolArguments(tool, { options: { retries: 2 } }), /\["path"\].*required property/);
  assert.throws(
    () => validateToolArguments(tool, { path: 'src/a.ts', options: { retries: 1.5 } }),
    /\["options"\]\["retries"\].*expected integer/,
  );
  assert.throws(
    () => validateToolArguments(tool, { path: 'src/a.ts', options: { retries: 2, surprise: true } }),
    /\["options"\]\["surprise"\].*additional property/,
  );
});

test('validateToolArguments supports arrays, enums, alternatives, and scalar bounds', () => {
  const tool = makeTool('bounded', {
    parameters: {
      type: 'object',
      properties: {
        mode: { enum: ['read', 'write'] },
        values: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 3 },
        target: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
      },
      required: ['mode', 'values', 'target'],
    },
  });

  assert.doesNotThrow(() => validateToolArguments(tool, { mode: 'read', values: [0, 2.5], target: null }));
  assert.throws(
    () => validateToolArguments(tool, { mode: 'delete', values: [0], target: null }),
    /allowed enum value/,
  );
  assert.throws(
    () => validateToolArguments(tool, { mode: 'read', values: [-1], target: null }),
    /violates minimum 0/,
  );
});

test('argument validation is fail-closed and bounded for hostile values', () => {
  const tool = makeTool('bounded-input', {
    parameters: { type: 'object', properties: { nested: { type: 'object' } } },
  });
  assert.throws(
    () => validateToolArguments(tool, { unexpected: undefined }),
    /value is not JSON-compatible/,
  );
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  assert.throws(() => validateToolArguments(tool, circular), /must not contain circular references/);
  assert.throws(
    () => validateToolArguments(tool, { many: [1, 2, 3] }, { maxCollectionEntries: 2 }),
    /array has 3 entries \(limit 2\)/,
  );
  assert.throws(
    () => validateToolArguments(tool, { nested: { deeper: {} } }, { maxDepth: 1 }),
    /nesting exceeds the 1-level validation limit/,
  );
  assert.throws(
    () => validateToolArguments(tool, { many: [1, 2, 3] }, { maxWork: 3 }),
    /validation work exceeded the 3-step limit/,
  );
});
