/**
 * Argument-prefix approval rules (ADR 0011 addendum, 2026-09-02).
 *
 * ADR 0011 v1 gated tool calls by name alone and named argument-pattern gating
 * and session-scoped grants as non-goals. This module retires both. A rule is a
 * `{ tool, prefix, decision, tests }` record; a grant is a journal row that can
 * only narrow prompting. Everything here is pure: it reads a tool name and the
 * exact arguments the tool is about to receive and returns a decision. Nothing
 * in it touches the filesystem, the journal, or a shell.
 *
 * The tokenizer is deliberately timid. It refuses any construct whose effective
 * words it cannot know statically (command substitution, variable expansion,
 * subshells, `eval`, `bash -c`, leading environment assignments), and a refused
 * segment can never be allowed by a rule or a grant.
 */
import { requiresApproval, type ToolExecutionPolicy } from './types.js';

export type ApprovalRuleDecision = 'allow' | 'prompt' | 'deny';

/** One inline example carried by the rule that must keep producing `expect`. */
export interface ApprovalRuleTest {
  /** A bash command, or a JSON object of tool arguments when it starts with `{`. */
  readonly command: string;
  readonly expect: ApprovalRuleDecision;
}

/**
 * One authored rule. `prefix` is either a word prefix (bash: the words of a
 * command segment) or a map of parameter name to argument-value prefix, which is
 * how a non-command tool is addressed. An absent prefix matches every call of
 * the tool.
 */
export interface ApprovalRule {
  readonly tool: string;
  readonly prefix?: string | Readonly<Record<string, string>>;
  readonly decision: ApprovalRuleDecision;
  readonly tests?: readonly ApprovalRuleTest[];
}

/** One parameter-keyed prefix condition of a compiled rule or grant. */
export interface ParameterPrefix {
  readonly parameter: string;
  readonly prefix: string;
}

/** A rule with its prefix parsed once, so dispatch never re-parses it. */
export interface CompiledApprovalRule {
  readonly index: number;
  readonly tool: string;
  readonly decision: ApprovalRuleDecision;
  /** Word prefix for command-shaped calls; absent for a parameter-keyed rule. */
  readonly words?: readonly string[];
  /** Parameter-keyed prefixes; every entry must match. */
  readonly parameters?: readonly ParameterPrefix[];
  /** Canonical prefix text, as journaled and as printed to a human. */
  readonly prefix?: string;
  readonly tests: readonly ApprovalRuleTest[];
}

/** The rule that decided one gated call, journaled on the approval-requested row. */
export interface ApprovalRuleMatch {
  /** Position in the rule list the decision came from. */
  readonly index: number;
  readonly tool: string;
  readonly decision: ApprovalRuleDecision;
  readonly prefix?: string;
}

/**
 * A session-scoped "always allow this prefix" grant. Written as an additive
 * `tool_approval_grant` journal row, replayed on resume, and revocable. A grant
 * can only turn a prompt into an allow; it can never reach a deny rule or a
 * segment the tokenizer refused.
 */
export interface ToolApprovalGrant {
  readonly tool: string;
  readonly prefix: string;
  readonly grantedAt: string;
  /** A revoking row for an existing `(tool, prefix)` pair. */
  readonly revoked?: boolean;
}

export type ShellTokenization =
  | { readonly ok: true; readonly words: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Command words the tokenizer never looks past: their effective command is data, not text. */
const OPAQUE_COMMAND_WORDS = new Set(['eval', 'source', '.', 'exec']);
const SHELL_COMMAND_WORDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a bash command into the segments a rule is evaluated against: `&&`,
 * `||`, `|`, `;`, `&`, and newlines, respected outside quotes. A command whose
 * quoting does not close is returned whole so the tokenizer can refuse it.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  for (let position = 0; position < command.length; position++) {
    const character = command[position]!;
    if (quote) {
      current += character;
      if (character === '\\' && quote === '"' && position + 1 < command.length) {
        current += command[++position]!;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '\\' && position + 1 < command.length) {
      current += character + command[++position]!;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '\n' || character === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (character === '|' || character === '&') {
      if (command[position + 1] === character) position++;
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);
  const nonEmpty = segments.filter((segment) => segment.trim().length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [command];
}

/**
 * Tokenize one command segment into the literal words a prefix is compared
 * against. Single quotes, double quotes, and backslash escapes are honored; a
 * construct whose expansion is unknowable at dispatch is refused rather than
 * guessed at.
 */
export function tokenizeShellWords(segment: string): ShellTokenization {
  const words: string[] = [];
  let current = '';
  let started = false;
  const push = (): void => {
    if (started) words.push(current);
    current = '';
    started = false;
  };
  for (let position = 0; position < segment.length; position++) {
    const character = segment[position]!;
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (character === '\\') {
      if (position + 1 >= segment.length) return { ok: false, reason: 'trailing backslash' };
      current += segment[++position]!;
      started = true;
      continue;
    }
    if (character === '`') return { ok: false, reason: 'command substitution' };
    if (character === '$') return { ok: false, reason: 'expansion' };
    if (character === '(' || character === ')') return { ok: false, reason: 'subshell or process substitution' };
    if (character === "'") {
      const end = segment.indexOf("'", position + 1);
      if (end === -1) return { ok: false, reason: 'unterminated single quote' };
      current += segment.slice(position + 1, end);
      started = true;
      position = end;
      continue;
    }
    if (character === '"') {
      let scan = position + 1;
      let closed = false;
      for (; scan < segment.length; scan++) {
        const inner = segment[scan]!;
        if (inner === '\\' && scan + 1 < segment.length) {
          current += segment[++scan]!;
          started = true;
          continue;
        }
        if (inner === '`') return { ok: false, reason: 'command substitution' };
        if (inner === '$') return { ok: false, reason: 'expansion' };
        if (inner === '"') {
          closed = true;
          break;
        }
        current += inner;
        started = true;
      }
      if (!closed) return { ok: false, reason: 'unterminated double quote' };
      started = true;
      position = scan;
      continue;
    }
    current += character;
    started = true;
  }
  push();
  if (words.length === 0) return { ok: false, reason: 'no command words' };
  const head = words[0]!;
  if (ENVIRONMENT_ASSIGNMENT.test(head)) {
    return { ok: false, reason: 'environment assignment before the command' };
  }
  if (OPAQUE_COMMAND_WORDS.has(head)) return { ok: false, reason: `${head} runs text as a command` };
  if (SHELL_COMMAND_WORDS.has(head) && words.slice(1).includes('-c')) {
    return { ok: false, reason: `${head} -c runs text as a command` };
  }
  return { ok: true, words };
}

/**
 * Whitespace-and-metacharacter split used only for a segment the tokenizer
 * refused. It is never enough to allow anything; it exists so a deny rule can
 * still bite a command whose shape could not be established.
 */
export function bestEffortWords(segment: string): string[] {
  return segment.split(/[\s;|&()`'"$<>]+/).filter((word) => word.length > 0);
}

function canonicalPrefix(rule: Pick<CompiledApprovalRule, 'words' | 'parameters'>): string | undefined {
  if (rule.words) return rule.words.join(' ');
  if (rule.parameters) return rule.parameters.map((entry) => `${entry.parameter}=${entry.prefix}`).join(' ');
  return undefined;
}

/**
 * Parse the prefix text used by `--approval-rule` and `--grant`: a space
 * separated word prefix, or a single `parameter=prefix` pair for a tool whose
 * arguments are not a command line.
 */
export function parsePrefixText(text: string, path: string): Pick<CompiledApprovalRule, 'words' | 'parameters'> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new TypeError(`${path} must not be empty`);
  if (!/\s/.test(trimmed) && /^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(trimmed)) {
    const separator = trimmed.indexOf('=');
    return { parameters: [{ parameter: trimmed.slice(0, separator), prefix: trimmed.slice(separator + 1) }] };
  }
  const tokenized = tokenizeShellWords(trimmed);
  if (!tokenized.ok) throw new TypeError(`${path} is not a plain word prefix: ${tokenized.reason}`);
  return { words: tokenized.words };
}

/** Compile authored rules once, rejecting anything a dispatch-time match could not honor. */
export function compileApprovalRules(rules: readonly ApprovalRule[]): CompiledApprovalRule[] {
  return rules.map((rule, index) => {
    const path = `approvals.rules[${index}]`;
    if (typeof rule?.tool !== 'string' || rule.tool.length === 0) {
      throw new TypeError(`${path}.tool must be a non-empty tool name`);
    }
    if (rule.decision !== 'allow' && rule.decision !== 'prompt' && rule.decision !== 'deny') {
      throw new TypeError(`${path}.decision must be "allow", "prompt", or "deny"`);
    }
    let shape: Pick<CompiledApprovalRule, 'words' | 'parameters'> = {};
    if (typeof rule.prefix === 'string') {
      shape = parsePrefixText(rule.prefix, `${path}.prefix`);
    } else if (rule.prefix !== undefined) {
      const entries = Object.entries(rule.prefix);
      if (entries.length === 0) throw new TypeError(`${path}.prefix must name at least one parameter`);
      for (const [parameter, value] of entries) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new TypeError(`${path}.prefix.${parameter} must be a non-empty string`);
        }
      }
      shape = { parameters: entries.map(([parameter, prefix]) => ({ parameter, prefix: prefix as string })) };
    }
    const tests = (rule.tests ?? []).map((test, testIndex) => {
      const testPath = `${path}.tests[${testIndex}]`;
      if (typeof test?.command !== 'string' || test.command.length === 0) {
        throw new TypeError(`${testPath}.command must be a non-empty string`);
      }
      if (test.expect !== 'allow' && test.expect !== 'prompt' && test.expect !== 'deny') {
        throw new TypeError(`${testPath}.expect must be "allow", "prompt", or "deny"`);
      }
      return { command: test.command, expect: test.expect };
    });
    const prefix = canonicalPrefix(shape);
    return {
      index,
      tool: rule.tool,
      decision: rule.decision,
      ...shape,
      ...(prefix !== undefined ? { prefix } : {}),
      tests,
    };
  });
}

/** Compile a grant's prefix the same way a rule's is compiled. */
export function compileGrant(grant: ToolApprovalGrant): Pick<CompiledApprovalRule, 'words' | 'parameters'> {
  return parsePrefixText(grant.prefix, `grant ${grant.tool}`);
}

function matchesWords(prefixWords: readonly string[], segmentWords: readonly string[]): boolean {
  if (prefixWords.length > segmentWords.length) return false;
  return prefixWords.every((word, position) => segmentWords[position] === word);
}

function matchesParameters(parameters: readonly ParameterPrefix[], args: Record<string, unknown>): boolean {
  return parameters.every((entry) => {
    const value = args[entry.parameter];
    return typeof value === 'string' && value.startsWith(entry.prefix);
  });
}

interface SegmentOutcome {
  decision: ApprovalRuleDecision | 'unmatched';
  rule?: ApprovalRuleMatch;
  /** The grant that narrowed this segment from prompt to allow. */
  grant?: ToolApprovalGrant;
  /** The tokenizer could not establish this segment's words. */
  refused?: string;
}

function matchOf(rule: CompiledApprovalRule): ApprovalRuleMatch {
  return {
    index: rule.index,
    tool: rule.tool,
    decision: rule.decision,
    ...(rule.prefix !== undefined ? { prefix: rule.prefix } : {}),
  };
}

/** The first applicable rule that matches a tokenized segment, or nothing. */
function firstMatch(
  rules: readonly CompiledApprovalRule[],
  args: Record<string, unknown>,
  segmentWords: readonly string[] | undefined,
): CompiledApprovalRule | undefined {
  for (const rule of rules) {
    if (rule.words) {
      if (segmentWords && matchesWords(rule.words, segmentWords)) return rule;
      continue;
    }
    if (rule.parameters) {
      if (matchesParameters(rule.parameters, args)) return rule;
      continue;
    }
    return rule; // a rule with no prefix matches every call of its tool
  }
  return undefined;
}

export interface ApprovalEvaluation {
  /** `unmatched` means no rule spoke; the caller falls back to the tool-name policy. */
  readonly decision: ApprovalRuleDecision | 'unmatched';
  /** The rule that produced `decision`, when a rule produced it. */
  readonly rule?: ApprovalRuleMatch;
  /** A grant turned at least one prompting segment into an allow. */
  readonly grant?: ToolApprovalGrant;
  /** Why a segment could not be tokenized, when one could not be. */
  readonly refused?: string;
}

/**
 * Evaluate the rule set against one tool call. Bash commands are split into
 * segments; every other tool is one implicit segment matched by its arguments.
 * Within a segment the first matching rule wins; across segments deny beats
 * prompt beats an unmatched segment beats allow.
 */
export function evaluateApprovalRules(
  rules: readonly CompiledApprovalRule[],
  toolName: string,
  args: Record<string, unknown>,
  grants: readonly ToolApprovalGrant[] = [],
): ApprovalEvaluation {
  const applicable = rules.filter((rule) => rule.tool === toolName);
  const applicableGrants = grants.filter((grant) => grant.tool === toolName && !grant.revoked);
  const denyRules = applicable.filter((rule) => rule.decision === 'deny');
  const command = args['command'];
  const outcomes: SegmentOutcome[] = [];
  /** A grant is the last word only where the tokenizer was confident. */
  const narrowByGrant = (outcome: SegmentOutcome, segmentWords: readonly string[] | undefined): SegmentOutcome => {
    if (outcome.decision !== 'prompt' && outcome.decision !== 'unmatched') return outcome;
    for (const grant of applicableGrants) {
      const shape = compileGrant(grant);
      const matched = shape.words
        ? segmentWords !== undefined && matchesWords(shape.words, segmentWords)
        : matchesParameters(shape.parameters ?? [], args);
      if (matched) return { decision: 'allow', grant };
    }
    return outcome;
  };
  if (typeof command === 'string') {
    for (const segment of splitCommandSegments(command)) {
      const tokenized = tokenizeShellWords(segment);
      if (!tokenized.ok) {
        // A segment whose words are unknown is never allowed, and a deny rule
        // still bites when any of its words appears anywhere in the segment.
        const loose = new Set(bestEffortWords(segment));
        const denying = denyRules.find((rule) => (rule.words ?? []).some((word) => loose.has(word)));
        outcomes.push(
          denying
            ? { decision: 'deny', rule: matchOf(denying), refused: tokenized.reason }
            : { decision: 'prompt', refused: tokenized.reason },
        );
        continue;
      }
      const matched = firstMatch(applicable, args, tokenized.words);
      const outcome: SegmentOutcome = matched
        ? { decision: matched.decision, rule: matchOf(matched) }
        : { decision: 'unmatched' };
      outcomes.push(narrowByGrant(outcome, tokenized.words));
    }
  } else {
    const matched = firstMatch(applicable, args, undefined);
    const outcome: SegmentOutcome = matched
      ? { decision: matched.decision, rule: matchOf(matched) }
      : { decision: 'unmatched' };
    outcomes.push(narrowByGrant(outcome, undefined));
  }
  const refused = outcomes.find((outcome) => outcome.refused)?.refused;
  const winner =
    outcomes.find((outcome) => outcome.decision === 'deny') ??
    outcomes.find((outcome) => outcome.decision === 'prompt') ??
    outcomes.find((outcome) => outcome.decision === 'unmatched') ??
    outcomes[0];
  if (!winner || winner.decision === 'unmatched') return { decision: 'unmatched' };
  return {
    decision: winner.decision,
    ...(winner.rule ? { rule: winner.rule } : {}),
    ...(winner.grant ? { grant: winner.grant } : {}),
    ...(refused !== undefined ? { refused } : {}),
  };
}

export interface ApprovalAction {
  /** `deny` refuses the call outright; `prompt` gates it; `allow` dispatches it. */
  readonly action: ApprovalRuleDecision;
  readonly rule?: ApprovalRuleMatch;
  readonly grant?: ToolApprovalGrant;
}

export interface ApprovalActionRequest {
  /** The ADR 0011 v1 tool-name policy every unmatched segment falls back to. */
  readonly policy?: ToolExecutionPolicy;
  readonly rules?: readonly CompiledApprovalRule[];
  readonly grants?: readonly ToolApprovalGrant[];
  readonly toolName: string;
  /** The exact arguments the tool will receive, edits applied. */
  readonly arguments: Record<string, unknown>;
}

/**
 * The dispatch-time answer for one call: rules first, the tool-name policy for
 * anything no rule matched. With no rules and no grants this is exactly
 * `requiresApproval`, which is what keeps ADR 0011 v1 behavior unchanged.
 */
export function resolveApprovalAction(request: ApprovalActionRequest): ApprovalAction {
  const rules = request.rules ?? [];
  const grants = request.grants ?? [];
  const nameGate = requiresApproval(request.policy, request.toolName) ? 'prompt' : 'allow';
  if (rules.length === 0 && grants.length === 0) return { action: nameGate };
  const evaluation = evaluateApprovalRules(rules, request.toolName, request.arguments, grants);
  if (evaluation.decision === 'unmatched') return { action: nameGate };
  return {
    action: evaluation.decision,
    ...(evaluation.rule ? { rule: evaluation.rule } : {}),
    ...(evaluation.grant ? { grant: evaluation.grant } : {}),
  };
}

export interface ApprovalRuleTestFailure {
  readonly ruleIndex: number;
  readonly tool: string;
  readonly prefix?: string;
  readonly command: string;
  readonly expected: ApprovalRuleDecision;
  readonly actual: ApprovalRuleDecision;
}

function testArguments(test: ApprovalRuleTest, path: string): Record<string, unknown> {
  const text = test.command.trimStart();
  if (!text.startsWith('{')) return { command: test.command };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(`${path} must be a command or a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must be a command or a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Run every rule's inline examples against the whole rule set. A test evaluates
 * the rules alone: an example no rule matches is reported as `prompt`, which is
 * what the tool-name policy yields for any gated tool.
 */
export function runApprovalRuleTests(rules: readonly CompiledApprovalRule[]): ApprovalRuleTestFailure[] {
  const failures: ApprovalRuleTestFailure[] = [];
  for (const rule of rules) {
    for (const [testIndex, test] of rule.tests.entries()) {
      const args = testArguments(test, `approvals.rules[${rule.index}].tests[${testIndex}].command`);
      const evaluation = evaluateApprovalRules(rules, rule.tool, args);
      const actual: ApprovalRuleDecision = evaluation.decision === 'unmatched' ? 'prompt' : evaluation.decision;
      if (actual !== test.expect) {
        failures.push({
          ruleIndex: rule.index,
          tool: rule.tool,
          ...(rule.prefix !== undefined ? { prefix: rule.prefix } : {}),
          command: test.command,
          expected: test.expect,
          actual,
        });
      }
    }
  }
  return failures;
}

/** One line naming the rule and the example, for the startup refusal. */
export function describeRuleTestFailure(failure: ApprovalRuleTestFailure): string {
  const rule = `approvals.rules[${failure.ruleIndex}] ${failure.tool}${failure.prefix ? `:${failure.prefix}` : ''}`;
  return `${rule}: example ${JSON.stringify(failure.command)} expected ${failure.expected} but the rule set says ${failure.actual}`;
}

/** Compile and self-test a rule set; throws with the offending rule and example. */
export function loadApprovalRules(rules: readonly ApprovalRule[]): CompiledApprovalRule[] {
  const compiled = compileApprovalRules(rules);
  const failures = runApprovalRuleTests(compiled);
  if (failures.length > 0) {
    throw new Error(
      `approval rule tests failed:\n${failures.map((failure) => `  ${describeRuleTestFailure(failure)}`).join('\n')}`,
    );
  }
  return compiled;
}
