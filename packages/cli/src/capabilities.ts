/**
 * The self-description a `--json` consumer reads off the first row of the
 * headless stream (ADR 0010 addendum, 2026-09-02). It exists so an adapter can
 * discover the journal generation, the tools in play, the exit-code set it must
 * interpret, and the scope every budget ceiling is enforced against, without
 * hard-coding a piko version.
 */
import { JOURNAL_SCHEMA_VERSION } from '@pi/core';

/** Every exit code the headless contract may return (0010 and its 0024 amendment). */
export const HEADLESS_EXIT_CODES = [0, 1, 2, 3, 4, 5, 130] as const;

/** Budget ceilings are enforced per user turn (ADR 0009 scope note; ADR 0026 proposes session scope). */
export const BUDGET_SCOPE = 'turn';

export interface HeadlessCapabilities {
  journalSchemaVersion: number;
  tools: string[];
  exitCodes: number[];
  budgetScope: string;
}

export function headlessCapabilities(tools: readonly { name: string }[]): HeadlessCapabilities {
  return {
    journalSchemaVersion: JOURNAL_SCHEMA_VERSION,
    tools: tools.map((tool) => tool.name),
    exitCodes: [...HEADLESS_EXIT_CODES],
    budgetScope: BUDGET_SCOPE,
  };
}

/**
 * The honest subset a `run_error` row can carry. A run that fails before the
 * tool set is resolved (a bad flag, an extension refusal, a locked head, the
 * depth refusal) still knows its schema generation, its exit-code set, and its
 * budget scope, but it does not know the tool names. `tools` is therefore
 * omitted rather than guessed, and `partial` says so explicitly so a consumer
 * never mistakes the absence of a tool list for an empty tool list.
 */
export interface PartialHeadlessCapabilities {
  journalSchemaVersion: number;
  exitCodes: number[];
  budgetScope: string;
  partial: true;
}

export function partialHeadlessCapabilities(): PartialHeadlessCapabilities {
  return {
    journalSchemaVersion: JOURNAL_SCHEMA_VERSION,
    exitCodes: [...HEADLESS_EXIT_CODES],
    budgetScope: BUDGET_SCOPE,
    partial: true,
  };
}
