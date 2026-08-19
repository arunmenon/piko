import type { Tool } from './types.js';

/**
 * Tool definitions are copied into every model request. Keep the default small
 * enough that one extension cannot silently erase the harness's context-budget
 * advantage. Callers may choose a different (still finite) policy limit.
 */
export const DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES = 8 * 1024;

export interface ToolValidationOptions {
  /** Maximum UTF-8 bytes for the serialized public tool definitions. */
  readonly maxSchemaBytes?: number;
  /** Human-readable origin included in validation errors. */
  readonly source?: string;
}

export interface ToolArgumentValidationOptions {
  /** Maximum nesting in provider-supplied argument data and schema traversal. */
  readonly maxDepth?: number;
  /** Maximum aggregate values/schema branches visited during one validation. */
  readonly maxWork?: number;
  /** Maximum entries accepted in any one provider-supplied object or array. */
  readonly maxCollectionEntries?: number;
}

export const DEFAULT_TOOL_ARGUMENT_VALIDATION_LIMITS = Object.freeze({
  maxDepth: 24,
  maxWork: 20_000,
  maxCollectionEntries: 4_096,
});

const HARD_TOOL_ARGUMENT_VALIDATION_LIMITS = Object.freeze({
  maxDepth: 64,
  maxWork: 100_000,
  maxCollectionEntries: 20_000,
});

export class ToolArgumentValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly path: string,
    message: string,
  ) {
    super(`tool "${toolName}" arguments invalid at ${path}: ${message}`);
    this.name = 'ToolArgumentValidationError';
  }
}

const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  // Core assertions validated again immediately before dispatch.
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  // Provider-visible annotations with no runtime assertion semantics.
  'title',
  'description',
  'default',
  'examples',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const textEncoder = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function label(options: ToolValidationOptions, index?: number): string {
  const source = options.source ?? 'tool set';
  return index === undefined ? source : `${source} tool at index ${index}`;
}

function schemaLimit(options: ToolValidationOptions): number {
  const value = options.maxSchemaBytes ?? DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${options.source ?? 'tool validation'}: maxSchemaBytes must be a positive safe integer`);
  }
  return value;
}

/** Ensure JSON.stringify cannot omit, coerce, or loop over schema values. */
function assertJsonData(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must not contain non-finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${path} must not contain circular references`);
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      assertJsonData(value[index], `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new Error(`${path} must contain only JSON-compatible values`);
  if (ancestors.has(value)) throw new Error(`${path} must not contain circular references`);
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertJsonData(child, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function validateTypeKeyword(value: unknown, path: string): void {
  const types = Array.isArray(value) ? value : [value];
  if (
    types.length === 0 ||
    types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) ||
    new Set(types).size !== types.length
  ) {
    throw new Error(`${path} must be a JSON Schema type or a nonempty array of unique JSON Schema types`);
  }
}

/**
 * Validate structural keywords that provider tool APIs commonly rely on. This
 * intentionally is not a full JSON Schema implementation; unknown JSON-safe
 * annotations remain forward-compatible.
 */
function validateSchemaNode(schema: unknown, path: string, ancestors = new Set<object>()): void {
  if (!isPlainObject(schema)) throw new Error(`${path} must be a JSON Schema object`);
  if (ancestors.has(schema)) throw new Error(`${path} must not contain circular references`);
  ancestors.add(schema);

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`${path} uses unsupported JSON Schema keyword "${keyword}"`);
    }
  }

  if ('type' in schema) validateTypeKeyword(schema['type'], `${path}.type`);

  for (const keyword of ['title', 'description', '$comment'] as const) {
    if (keyword in schema && typeof schema[keyword] !== 'string') {
      throw new Error(`${path}.${keyword} must be a string`);
    }
  }
  for (const keyword of ['deprecated', 'readOnly', 'writeOnly'] as const) {
    if (keyword in schema && typeof schema[keyword] !== 'boolean') {
      throw new Error(`${path}.${keyword} must be a boolean`);
    }
  }
  if ('examples' in schema && !Array.isArray(schema['examples'])) {
    throw new Error(`${path}.examples must be an array`);
  }
  if ('enum' in schema && (!Array.isArray(schema['enum']) || schema['enum'].length === 0)) {
    throw new Error(`${path}.enum must be a nonempty array`);
  }

  if ('properties' in schema) {
    const properties = schema['properties'];
    if (!isPlainObject(properties)) throw new Error(`${path}.properties must be an object`);
    for (const [name, propertySchema] of Object.entries(properties)) {
      validateSchemaNode(propertySchema, `${path}.properties.${name}`, ancestors);
    }
  }

  if ('required' in schema) {
    const required = schema['required'];
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== 'string') ||
      new Set(required).size !== required.length
    ) {
      throw new Error(`${path}.required must be an array of unique strings`);
    }
    const properties = schema['properties'];
    if (isPlainObject(properties)) {
      for (const name of required as string[]) {
        if (!Object.hasOwn(properties, name)) {
          throw new Error(`${path}.required names undefined property "${name}"`);
        }
      }
    }
  }

  if ('items' in schema) {
    const items = schema['items'];
    if (Array.isArray(items)) {
      for (let index = 0; index < items.length; index += 1) {
        validateSchemaNode(items[index], `${path}.items[${index}]`, ancestors);
      }
    } else {
      validateSchemaNode(items, `${path}.items`, ancestors);
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!(keyword in schema)) continue;
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new Error(`${path}.${keyword} must be a nonempty array of schema objects`);
    }
    for (let index = 0; index < branches.length; index += 1) {
      validateSchemaNode(branches[index], `${path}.${keyword}[${index}]`, ancestors);
    }
  }

  for (const keyword of ['additionalProperties', 'not'] as const) {
    if (!(keyword in schema)) continue;
    const child = schema[keyword];
    if (keyword === 'additionalProperties' && typeof child === 'boolean') continue;
    validateSchemaNode(child, `${path}.${keyword}`, ancestors);
  }

  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (keyword in schema && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))) {
      throw new Error(`${path}.${keyword} must be a finite number`);
    }
  }
  for (const keyword of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const) {
    if (keyword in schema && (!Number.isSafeInteger(schema[keyword]) || (schema[keyword] as number) < 0)) {
      throw new Error(`${path}.${keyword} must be a nonnegative safe integer`);
    }
  }

  ancestors.delete(schema);
}

function validateToolShape(value: unknown, options: ToolValidationOptions, index?: number): Tool {
  const origin = label(options, index);
  if (!isPlainObject(value)) throw new Error(`${origin}: tool must be a plain object`);

  const name = value['name'];
  if (typeof name !== 'string' || !SAFE_TOOL_NAME.test(name)) {
    throw new Error(`${origin}: name must match ${SAFE_TOOL_NAME} (1-64 provider-safe characters)`);
  }

  const description = value['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`${origin} (${name}): description must be a nonempty string`);
  }

  if (typeof value['execute'] !== 'function') {
    throw new Error(`${origin} (${name}): execute must be a function`);
  }

  const parameters = value['parameters'];
  if (!isPlainObject(parameters) || parameters['type'] !== 'object' || !isPlainObject(parameters['properties'])) {
    throw new Error(`${origin} (${name}): parameters must be a JSON Schema object with type "object" and properties`);
  }
  assertJsonData(parameters, `${origin} (${name}).parameters`);
  validateSchemaNode(parameters, `${origin} (${name}).parameters`);

  return value as unknown as Tool;
}

function serializedDefinitions(tools: readonly Tool[]): string {
  return JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
}

/** Runtime-check one provider-visible tool definition. */
export function validateTool(value: unknown, options: ToolValidationOptions = {}): Tool {
  const tool = validateToolShape(value, options);
  const bytes = textEncoder.encode(serializedDefinitions([tool])).byteLength;
  const limit = schemaLimit(options);
  if (bytes > limit) {
    throw new Error(`${options.source ?? `tool ${tool.name}`}: serialized schema is ${bytes} bytes (limit ${limit})`);
  }
  return tool;
}

/**
 * Runtime-check a complete tool set and reject ambiguous dispatch. The returned
 * array is a shallow copy so callers cannot accidentally rely on input mutation.
 */
export function validateToolSet(values: readonly unknown[], options: ToolValidationOptions = {}): Tool[] {
  if (!Array.isArray(values)) throw new Error(`${options.source ?? 'tool set'}: expected an array of tools`);
  const tools = values.map((value, index) => validateToolShape(value, options, index));
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`${options.source ?? 'tool set'}: duplicate tool name "${tool.name}"`);
    seen.add(tool.name);
  }

  const bytes = textEncoder.encode(serializedDefinitions(tools)).byteLength;
  const limit = schemaLimit(options);
  if (bytes > limit) {
    throw new Error(`${options.source ?? 'tool set'}: serialized schemas total ${bytes} bytes (limit ${limit})`);
  }
  return tools;
}

interface ArgumentValidationLimits {
  maxDepth: number;
  maxWork: number;
  maxCollectionEntries: number;
}

interface ArgumentValidationState extends ArgumentValidationLimits {
  toolName: string;
  work: number;
}

interface ValidationIssue {
  path: string;
  message: string;
  schemaMalformed?: boolean;
}

function argumentValidationLimits(options: ToolArgumentValidationOptions): ArgumentValidationLimits {
  const entries = [
    ['maxDepth', options.maxDepth ?? DEFAULT_TOOL_ARGUMENT_VALIDATION_LIMITS.maxDepth],
    ['maxWork', options.maxWork ?? DEFAULT_TOOL_ARGUMENT_VALIDATION_LIMITS.maxWork],
    [
      'maxCollectionEntries',
      options.maxCollectionEntries ?? DEFAULT_TOOL_ARGUMENT_VALIDATION_LIMITS.maxCollectionEntries,
    ],
  ] as const;
  const resolved: Record<string, number> = {};
  for (const [name, value] of entries) {
    const hardLimit = HARD_TOOL_ARGUMENT_VALIDATION_LIMITS[name];
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) {
      throw new Error(`${name} must be a positive safe integer no greater than ${hardLimit}`);
    }
    resolved[name] = value;
  }
  return resolved as unknown as ArgumentValidationLimits;
}

function consumeWork(state: ArgumentValidationState, path: string, amount = 1): void {
  state.work += amount;
  if (state.work > state.maxWork) {
    throw new ToolArgumentValidationError(
      state.toolName,
      path,
      `validation work exceeded the ${state.maxWork}-step limit`,
    );
  }
}

function checkDepth(state: ArgumentValidationState, path: string, depth: number): void {
  if (depth > state.maxDepth) {
    throw new ToolArgumentValidationError(
      state.toolName,
      path,
      `nesting exceeds the ${state.maxDepth}-level validation limit`,
    );
  }
}

function propertyPath(parent: string, property: string): string {
  const bounded = property.length <= 80 ? property : `${property.slice(0, 77)}...`;
  return `${parent}[${JSON.stringify(bounded)}]`;
}

/** Validate the raw arguments as bounded JSON data, including schema-ignored extras. */
function validateArgumentData(
  value: unknown,
  path: string,
  state: ArgumentValidationState,
  depth: number,
  ancestors: Set<object>,
): void {
  checkDepth(state, path, depth);
  consumeWork(state, path);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ToolArgumentValidationError(state.toolName, path, 'numbers must be finite JSON numbers');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > state.maxCollectionEntries) {
      throw new ToolArgumentValidationError(
        state.toolName,
        path,
        `array has ${value.length} entries (limit ${state.maxCollectionEntries})`,
      );
    }
    if (ancestors.has(value)) {
      throw new ToolArgumentValidationError(state.toolName, path, 'arguments must not contain circular references');
    }
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        validateArgumentData(value[index], `${path}[${index}]`, state, depth + 1, ancestors);
      }
    } finally {
      ancestors.delete(value);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw new ToolArgumentValidationError(state.toolName, path, 'value is not JSON-compatible');
  }
  const keys = Object.keys(value);
  if (keys.length > state.maxCollectionEntries) {
    throw new ToolArgumentValidationError(
      state.toolName,
      path,
      `object has ${keys.length} properties (limit ${state.maxCollectionEntries})`,
    );
  }
  if (ancestors.has(value)) {
    throw new ToolArgumentValidationError(state.toolName, path, 'arguments must not contain circular references');
  }
  ancestors.add(value);
  try {
    for (const key of keys) {
      validateArgumentData(value[key], propertyPath(path, key), state, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function matchesSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function boundedJsonEqual(
  left: unknown,
  right: unknown,
  path: string,
  state: ArgumentValidationState,
  depth: number,
): boolean {
  checkDepth(state, path, depth);
  consumeWork(state, path);
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    if (left.length > state.maxCollectionEntries) return false;
    return left.every((entry, index) => boundedJsonEqual(entry, right[index], `${path}[${index}]`, state, depth + 1));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.length > state.maxCollectionEntries ||
    leftKeys.some((key) => !Object.hasOwn(right, key))
  ) {
    return false;
  }
  return leftKeys.every((key) =>
    boundedJsonEqual(left[key], right[key], propertyPath(path, key), state, depth + 1),
  );
}

function malformedSchema(path: string, detail: string): ValidationIssue {
  return { path, message: `tool schema is malformed: ${detail}`, schemaMalformed: true };
}

function validateValueAgainstSchema(
  value: unknown,
  schema: unknown,
  path: string,
  state: ArgumentValidationState,
  depth: number,
): ValidationIssue | undefined {
  checkDepth(state, path, depth);
  consumeWork(state, path);
  if (!isPlainObject(schema)) return malformedSchema(path, 'expected a schema object');
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      return malformedSchema(path, `unsupported JSON Schema keyword "${keyword}"`);
    }
  }

  const rawType = schema['type'];
  if (rawType !== undefined) {
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (
      types.length === 0 ||
      types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type))
    ) {
      return malformedSchema(path, 'type must contain supported JSON Schema types');
    }
    if (!(types as string[]).some((type) => matchesSchemaType(value, type))) {
      return { path, message: `expected ${types.join(' or ')}` };
    }
  }

  if ('const' in schema && !boundedJsonEqual(value, schema['const'], path, state, depth + 1)) {
    return { path, message: 'does not match the schema const value' };
  }
  if ('enum' in schema) {
    const choices = schema['enum'];
    if (!Array.isArray(choices) || choices.length === 0) return malformedSchema(path, 'enum must be nonempty');
    let matched = false;
    for (const choice of choices) {
      if (boundedJsonEqual(value, choice, path, state, depth + 1)) {
        matched = true;
        break;
      }
    }
    if (!matched) return { path, message: 'does not match any allowed enum value' };
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!(keyword in schema)) continue;
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) {
      return malformedSchema(path, `${keyword} must be a nonempty array`);
    }
    const issues = branches.map((branch) => validateValueAgainstSchema(value, branch, path, state, depth + 1));
    const malformed = issues.find((issue) => issue?.schemaMalformed);
    if (malformed) return malformed;
    const matches = issues.filter((issue) => issue === undefined).length;
    if (keyword === 'allOf' && matches !== branches.length) return issues.find((issue) => issue !== undefined);
    if (keyword === 'anyOf' && matches === 0) return { path, message: 'does not match any anyOf branch' };
    if (keyword === 'oneOf' && matches !== 1) {
      return { path, message: `must match exactly one oneOf branch (matched ${matches})` };
    }
  }
  if ('not' in schema) {
    const issue = validateValueAgainstSchema(value, schema['not'], path, state, depth + 1);
    if (issue?.schemaMalformed) return issue;
    if (issue === undefined) return { path, message: 'matches a disallowed schema' };
  }

  if (isPlainObject(value)) {
    const properties = schema['properties'] ?? {};
    if (!isPlainObject(properties)) return malformedSchema(path, 'properties must be an object');
    const required = schema['required'] ?? [];
    if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
      return malformedSchema(path, 'required must be an array of strings');
    }
    for (const name of required as string[]) {
      if (!Object.hasOwn(value, name)) {
        return { path: propertyPath(path, name), message: 'required property is missing' };
      }
    }

    const additional = schema['additionalProperties'];
    if (additional !== undefined && typeof additional !== 'boolean' && !isPlainObject(additional)) {
      return malformedSchema(path, 'additionalProperties must be a boolean or schema object');
    }
    for (const [name, child] of Object.entries(value)) {
      const childPath = propertyPath(path, name);
      if (Object.hasOwn(properties, name)) {
        const issue = validateValueAgainstSchema(child, properties[name], childPath, state, depth + 1);
        if (issue) return issue;
      } else if (additional === false) {
        return { path: childPath, message: 'additional property is not allowed' };
      } else if (isPlainObject(additional)) {
        const issue = validateValueAgainstSchema(child, additional, childPath, state, depth + 1);
        if (issue) return issue;
      }
    }

    const propertyCount = Object.keys(value).length;
    for (const [keyword, compare] of [
      ['minProperties', (limit: number) => propertyCount >= limit],
      ['maxProperties', (limit: number) => propertyCount <= limit],
    ] as const) {
      if (!(keyword in schema)) continue;
      const limit = schema[keyword];
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
        return malformedSchema(path, `${keyword} must be a nonnegative safe integer`);
      }
      if (!compare(limit as number)) return { path, message: `violates ${keyword} ${limit}` };
    }
  }

  if (Array.isArray(value)) {
    const items = schema['items'];
    if (items !== undefined) {
      if (Array.isArray(items)) {
        for (let index = 0; index < Math.min(value.length, items.length); index += 1) {
          const issue = validateValueAgainstSchema(value[index], items[index], `${path}[${index}]`, state, depth + 1);
          if (issue) return issue;
        }
      } else if (isPlainObject(items)) {
        for (let index = 0; index < value.length; index += 1) {
          const issue = validateValueAgainstSchema(value[index], items, `${path}[${index}]`, state, depth + 1);
          if (issue) return issue;
        }
      } else {
        return malformedSchema(path, 'items must be a schema object or schema array');
      }
    }
    for (const [keyword, compare] of [
      ['minItems', (limit: number) => value.length >= limit],
      ['maxItems', (limit: number) => value.length <= limit],
    ] as const) {
      if (!(keyword in schema)) continue;
      const limit = schema[keyword];
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
        return malformedSchema(path, `${keyword} must be a nonnegative safe integer`);
      }
      if (!compare(limit as number)) return { path, message: `violates ${keyword} ${limit}` };
    }
  }

  if (typeof value === 'string') {
    for (const [keyword, compare] of [
      ['minLength', (limit: number) => value.length >= limit],
      ['maxLength', (limit: number) => value.length <= limit],
    ] as const) {
      if (!(keyword in schema)) continue;
      const limit = schema[keyword];
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
        return malformedSchema(path, `${keyword} must be a nonnegative safe integer`);
      }
      if (!compare(limit as number)) return { path, message: `violates ${keyword} ${limit}` };
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    for (const [keyword, compare] of [
      ['minimum', (limit: number) => value >= limit],
      ['maximum', (limit: number) => value <= limit],
      ['exclusiveMinimum', (limit: number) => value > limit],
      ['exclusiveMaximum', (limit: number) => value < limit],
    ] as const) {
      if (!(keyword in schema)) continue;
      const limit = schema[keyword];
      if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return malformedSchema(path, `${keyword} must be a finite number`);
      }
      if (!compare(limit)) return { path, message: `violates ${keyword} ${limit}` };
    }
  }

  return undefined;
}

/**
 * Fail-closed validation for model-supplied tool arguments. This intentionally
 * supports the provider-facing subset declared above rather than executing a
 * tool on the strength of TypeScript casts alone.
 */
export function validateToolArguments(
  tool: Pick<Tool, 'name' | 'parameters'>,
  argumentsValue: unknown,
  options: ToolArgumentValidationOptions = {},
): asserts argumentsValue is Record<string, unknown> {
  const limits = argumentValidationLimits(options);
  const state: ArgumentValidationState = { toolName: tool.name, work: 0, ...limits };
  validateArgumentData(argumentsValue, '$', state, 0, new Set());
  const issue = validateValueAgainstSchema(argumentsValue, tool.parameters, '$', state, 0);
  if (issue) throw new ToolArgumentValidationError(tool.name, issue.path, issue.message);
}
