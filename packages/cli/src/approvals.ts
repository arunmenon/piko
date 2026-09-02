import { splitCommandSegments, tokenizeShellWords, type ApprovalDecisionInput, type PendingApproval } from '@pi/core';
import type { ApprovalFlag } from './args.js';
import { oneLine, summarizeArgs } from './render.js';

/** One parsed answer to the inline approve/grant/edit/reject prompt. */
export type ApprovalReply =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'edit' }
  /** Approve, and always allow this prefix for the rest of the session (ADR 0011 addendum). */
  | { kind: 'grant'; prefix?: string }
  | { kind: 'invalid'; message: string };

export const APPROVAL_PROMPT = 'a)pprove  g)rant this prefix for the session  e)dit  r)eject [reason]';

/**
 * Parse one line of the inline prompt. Deliberately strict: an unrecognized
 * answer is never treated as approval.
 */
export function parseApprovalReply(line: string): ApprovalReply {
  const trimmed = line.trim();
  const head = trimmed.split(/\s+/)[0] ?? '';
  const remainder = trimmed.slice(head.length).trim();
  switch (head.toLowerCase()) {
    case 'a':
    case 'approve':
    case 'y':
    case 'yes':
      return { kind: 'approve' };
    case 'e':
    case 'edit':
      return { kind: 'edit' };
    case 'g':
    case 'grant':
      return remainder.length > 0 ? { kind: 'grant', prefix: remainder } : { kind: 'grant' };
    case 'r':
    case 'reject':
    case 'n':
    case 'no':
      return remainder.length > 0 ? { kind: 'reject', reason: remainder } : { kind: 'reject' };
    default:
      return {
        kind: 'invalid',
        message: trimmed.length === 0 ? `answer required — ${APPROVAL_PROMPT}` : `unrecognized answer — ${APPROVAL_PROMPT}`,
      };
  }
}

/** Parse replacement arguments typed at the edit prompt. */
export function parseEditedArguments(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`replacement arguments must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('replacement arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** One line describing a pending approval for a human or a log. */
export function describePendingApproval(pending: PendingApproval): string {
  const rule = pending.rule
    ? `  [rule ${pending.rule.index} ${oneLine(pending.rule.tool, 64)}${pending.rule.prefix ? `:${oneLine(pending.rule.prefix, 128)}` : ''}]`
    : '';
  return `${oneLine(pending.executionId, 128)}  ${oneLine(pending.call.name, 64)} ${summarizeArgs(pending.call.arguments)}${rule}`;
}

/**
 * The prefix the inline prompt offers to grant. For a command-shaped call it is
 * the command word plus its subcommand, which is the unit a human actually
 * means by "always allow this"; for any other tool it is the first string
 * argument, keyed by its parameter name. Undefined when neither exists, in
 * which case the prompt cannot offer a grant at all.
 */
export function defaultGrantPrefix(call: PendingApproval['call']): string | undefined {
  const command = call.arguments['command'];
  if (typeof command === 'string') {
    const segment = splitCommandSegments(command)[0] ?? command;
    const tokenized = tokenizeShellWords(segment);
    const words = tokenized.ok ? tokenized.words : segment.split(/\s+/).filter((word) => word.length > 0);
    const head = words[0];
    if (head === undefined) return undefined;
    const second = words[1];
    return second !== undefined && !second.startsWith('-') ? `${head} ${second}` : head;
  }
  for (const [parameter, value] of Object.entries(call.arguments)) {
    if (typeof value === 'string' && value.length > 0) return `${parameter}=${value}`;
  }
  return undefined;
}

/**
 * Turn command-line decision flags into agent decisions. `--approve all` expands
 * against the executions the reopened session is actually waiting on, so a stale
 * scripted id can never approve something the human never saw.
 */
export function resolveDecisionFlags(
  flags: readonly ApprovalFlag[],
  approveAll: boolean,
  pending: readonly PendingApproval[],
): ApprovalDecisionInput[] {
  if (approveAll) return pending.map((item) => ({ executionId: item.executionId, decision: 'approved' as const }));
  return flags.map((flag) => ({
    executionId: flag.executionId,
    decision: flag.decision,
    ...(flag.editedArguments !== undefined ? { editedArguments: flag.editedArguments } : {}),
    ...(flag.reason !== undefined ? { reason: flag.reason } : {}),
  }));
}
