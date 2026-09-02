import { estimateTokens, estimateTokensForBytes } from '@pi/ai';
import { MAX_AGENTS_MD_BYTES, MAX_SKILL_INDEX_ENTRIES, MAX_SKILL_SUMMARY_BYTES } from './prompt.js';
import { DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES } from './tools/validation.js';
import type { Tool } from './tools/types.js';

/**
 * The arithmetic behind ADR 0001's two-number gate. Number one is the default
 * prefix that scripts/check-budget.ts ratchets. Number two is this: what a first
 * request can cost when every bounded input arrives at its cap on the same run.
 * Only caps that exist as constants are counted; an input with no constant is
 * reported as unbounded rather than given an invented number.
 */

/** Aggregate bytes the skill index can contribute through its capped fields. */
export const SKILL_INDEX_SUMMARY_CAP_BYTES = MAX_SKILL_INDEX_ENTRIES * MAX_SKILL_SUMMARY_BYTES;

export interface BoundedContextInput {
  readonly label: string;
  /** Names of the constants that bound this input, for the gate's output. */
  readonly constants: string;
  readonly capBytes: number;
  readonly capTokens: number;
  /** Stated when the bound is loose, so a reader is not misled by the total. */
  readonly note?: string;
}

export interface UnboundedContextInput {
  readonly label: string;
  readonly reason: string;
}

export interface WorstCaseFirstRequest {
  readonly defaultPrefixTokens: number;
  readonly boundedInputs: readonly BoundedContextInput[];
  readonly unboundedInputs: readonly UnboundedContextInput[];
  /** Default prefix plus every bounded cap. An upper bound, deliberately loose. */
  readonly totalTokens: number;
}

/**
 * Bounded worst case for the first request of a run: the default prefix plus
 * every capped first-request input at its cap.
 */
export function worstCaseFirstRequest(defaultPrefixTokens: number): WorstCaseFirstRequest {
  if (!Number.isSafeInteger(defaultPrefixTokens) || defaultPrefixTokens < 0) {
    throw new RangeError('defaultPrefixTokens must be a nonnegative safe integer');
  }
  const boundedInputs: BoundedContextInput[] = [
    {
      label: 'AGENTS.md cap',
      constants: 'MAX_AGENTS_MD_BYTES',
      capBytes: MAX_AGENTS_MD_BYTES,
      capTokens: estimateTokensForBytes(MAX_AGENTS_MD_BYTES),
    },
    {
      label: 'skill index cap',
      constants: 'MAX_SKILL_INDEX_ENTRIES x MAX_SKILL_SUMMARY_BYTES',
      capBytes: SKILL_INDEX_SUMMARY_CAP_BYTES,
      capTokens: estimateTokensForBytes(SKILL_INDEX_SUMMARY_CAP_BYTES),
      note: 'summaries only; entry names and paths are unbounded (see below)',
    },
    {
      label: 'extension schema ceiling',
      constants: 'DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES',
      capBytes: DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES,
      capTokens: estimateTokensForBytes(DEFAULT_MAX_TOOL_SET_SCHEMA_BYTES),
      note: 'the ceiling covers the whole tool set, so the built-in schemas already counted in the default prefix are counted twice here',
    },
  ];
  const unboundedInputs: UnboundedContextInput[] = [
    {
      label: 'skill index entry names and paths',
      reason:
        'the per-entry name and path bytes are bounded only by the filesystem name limit; no piko constant caps them',
    },
  ];
  return {
    defaultPrefixTokens,
    boundedInputs,
    unboundedInputs,
    totalTokens: boundedInputs.reduce((sum, input) => sum + input.capTokens, defaultPrefixTokens),
  };
}

/** Exactly the provider-visible tool definitions, in the order they are sent. */
export function toolSchemaJson(tools: readonly Tool[]): string {
  return JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
}

export interface FixedPrefixSize {
  readonly systemPromptChars: number;
  readonly systemPromptTokens: number;
  readonly toolSchemaChars: number;
  readonly toolSchemaTokens: number;
  readonly totalTokens: number;
}

/**
 * Size of the cacheable fixed prefix (tool schemas plus system prompt, 0014's
 * prefix ordering). Both the budget gate and the startup cache-eligibility line
 * measure it here so the two numbers cannot drift apart.
 */
export function fixedPrefixSize(systemPrompt: string, tools: readonly Tool[]): FixedPrefixSize {
  const toolSchemas = toolSchemaJson(tools);
  const systemPromptTokens = estimateTokens(systemPrompt);
  const toolSchemaTokens = estimateTokens(toolSchemas);
  return {
    systemPromptChars: systemPrompt.length,
    systemPromptTokens,
    toolSchemaChars: toolSchemas.length,
    toolSchemaTokens,
    totalTokens: systemPromptTokens + toolSchemaTokens,
  };
}
