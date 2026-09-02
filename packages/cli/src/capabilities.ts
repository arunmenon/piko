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
