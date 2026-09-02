import type { ApprovalRuleConfig } from '@pi/ai';

/** A decision supplied on the command line for one suspended execution. */
export interface ApprovalFlag {
  executionId: string;
  decision: 'approved' | 'edited' | 'rejected';
  editedArguments?: Record<string, unknown>;
  reason?: string;
}

/** A `--grant '<tool>:<word> <word>...'` grant written at startup (ADR 0011 addendum). */
export interface GrantFlag {
  tool: string;
  prefix: string;
}

export interface CliArgs {
  print: boolean;
  json: boolean;
  continue: boolean;
  session?: string;
  model?: string;
  profile?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxToolOutputBytes?: number;
  maxTimeMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxSpendUSD?: number;
  pricingPath?: string;
  offlinePricing: boolean;
  trustProject: boolean;
  allowHostBash: boolean;
  /** let write and edit modify the protected paths inside the workspace (ADR 0006) */
  allowProtectedPaths: boolean;
  /** parent run correlation for a child spawned by another piko (ADR 0004) */
  parentRunId?: string;
  /** deepest PI_DEPTH this process will still run at (ADR 0004) */
  maxDepth: number;
  /** tool names gated behind a human decision, or '*' for all (ADR 0011) */
  requireApproval?: readonly string[] | '*';
  /** argument-prefix rules from --approval-rule, evaluated before the config file's */
  approvalRules: ApprovalRuleConfig[];
  /** session-scoped grants written at startup by --grant */
  grants: GrantFlag[];
  /** decisions applied to a suspended session when it is reopened */
  approvals: ApprovalFlag[];
  /** --approve all: every pending approval in the reopened session */
  approveAll: boolean;
  thinking?: number;
  autoCompact: boolean;
  flailGuard: boolean;
  offload: boolean;
  audit?: string;
  telemetry?: string;
  extensions: string[];
  usage: boolean;
  help: boolean;
  prompt: string;
}

/** Deepest nesting a piko child may still start at when --max-depth is absent (ADR 0004). */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * Parse `--approval-rule '<tool>:<decision>:<word> <word>...'`, the headless
 * form of a config-file rule. The prefix keeps every character after the second
 * colon, so a path prefix containing a colon survives. A prefix that is a single
 * `parameter=value` pair addresses a tool whose arguments are not a command
 * line; anything else is a word prefix.
 */
export function parseApprovalRuleFlag(value: string): ApprovalRuleConfig {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = firstSeparator === -1 ? -1 : value.indexOf(':', firstSeparator + 1);
  if (firstSeparator === -1 || secondSeparator === -1) {
    throw new Error("--approval-rule requires '<tool>:<allow|prompt|deny>:<word> <word>...'");
  }
  const tool = value.slice(0, firstSeparator).trim();
  const decision = value.slice(firstSeparator + 1, secondSeparator).trim();
  const prefix = value.slice(secondSeparator + 1).trim();
  if (tool.length === 0) throw new Error('--approval-rule requires a tool name');
  if (decision !== 'allow' && decision !== 'prompt' && decision !== 'deny') {
    throw new Error('--approval-rule decision must be allow, prompt, or deny');
  }
  return { tool, decision, ...(prefix.length > 0 ? { prefix } : {}) };
}

/** Parse `--grant '<tool>:<word> <word>...'`: the headless form of the REPL's grant. */
export function parseGrantFlag(value: string): GrantFlag {
  const separator = value.indexOf(':');
  if (separator === -1) throw new Error("--grant requires '<tool>:<word> <word>...'");
  const tool = value.slice(0, separator).trim();
  const prefix = value.slice(separator + 1).trim();
  if (tool.length === 0) throw new Error('--grant requires a tool name');
  if (prefix.length === 0) throw new Error('--grant requires a prefix; a grant never covers a whole tool');
  return { tool, prefix };
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    print: false,
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
    continue: false,
    autoCompact: true,
    flailGuard: true,
    offload: true,
    offlinePricing: false,
    trustProject: false,
    allowHostBash: false,
    allowProtectedPaths: false,
    approvals: [],
    approvalRules: [],
    grants: [],
    approveAll: false,
    extensions: [],
    usage: false,
    help: false,
    prompt: '',
  };
  const positional: string[] = [];
  const gatedTools = new Set<string>();
  let gateEveryTool = false;
  let sawApprovalGate = false;
  const lastDecision = (flag: string): ApprovalFlag => {
    const decision = args.approvals[args.approvals.length - 1];
    if (!decision) throw new Error(`${flag} must follow --reject or --edit`);
    return decision;
  };
  const positiveInteger = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} requires an integer >= 1`);
    return value;
  };
  const integerAtLeast = (flag: string, raw: string, minimum: number): number => {
    const value = positiveInteger(flag, raw);
    if (value < minimum) throw new Error(`${flag} requires an integer >= ${minimum}`);
    return value;
  };
  const nonNegativeInteger = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} requires an integer >= 0`);
    return value;
  };
  const positiveDecimal = (flag: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} requires a finite number > 0`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '-p':
      case '--print':
        args.print = true;
        break;
      case '--json':
        args.json = true;
        args.print = true;
        break;
      case '-c':
      case '--continue':
        args.continue = true;
        break;
      case '--session':
        args.session = next();
        break;
      case '--model':
        args.model = next();
        break;
      case '--profile':
        args.profile = next();
        break;
      case '--max-turns': {
        args.maxTurns = positiveInteger('--max-turns', next());
        break;
      }
      case '--max-tool-calls': {
        args.maxToolCalls = positiveInteger('--max-tool-calls', next());
        break;
      }
      case '--max-tool-output-bytes': {
        args.maxToolOutputBytes = integerAtLeast('--max-tool-output-bytes', next(), 256);
        break;
      }
      case '--max-time': {
        const seconds = positiveInteger('--max-time', next());
        if (seconds > 2_147_483) throw new Error('--max-time is too large for the runtime timer');
        args.maxTimeMs = seconds * 1_000;
        break;
      }
      case '--max-input-tokens': {
        args.maxInputTokens = positiveInteger('--max-input-tokens', next());
        break;
      }
      case '--max-output-tokens': {
        args.maxOutputTokens = positiveInteger('--max-output-tokens', next());
        break;
      }
      case '--max-total-tokens': {
        args.maxTotalTokens = positiveInteger('--max-total-tokens', next());
        break;
      }
      case '--max-spend-usd':
        args.maxSpendUSD = positiveDecimal('--max-spend-usd', next());
        break;
      case '--pricing':
        args.pricingPath = next();
        break;
      case '--offline-pricing':
        args.offlinePricing = true;
        break;
      case '--thinking': {
        const value = Number(next());
        if (!Number.isSafeInteger(value) || value < 1) throw new Error('--thinking requires a token budget >= 1');
        args.thinking = value;
        break;
      }
      case '--ext':
        args.extensions.push(next());
        break;
      case '--parent-run': {
        // Telemetry accepts any non-empty string for parentRunId (telemetry.ts
        // requireString); the flag applies exactly that rule and nothing more,
        // so an id minted by any parent tooling round-trips unchanged.
        const parentRunId = next();
        if (parentRunId.length === 0) throw new Error('--parent-run requires a non-empty run id');
        args.parentRunId = parentRunId;
        break;
      }
      case '--max-depth':
        args.maxDepth = nonNegativeInteger('--max-depth', next());
        break;
      case '--no-auto-compact':
        args.autoCompact = false;
        break;
      case '--no-flail-guard':
        args.flailGuard = false;
        break;
      case '--no-offload':
        args.offload = false;
        break;
      case '--trust-project':
        args.trustProject = true;
        break;
      case '--allow-host-bash':
        args.allowHostBash = true;
        break;
      case '--allow-protected-paths':
        args.allowProtectedPaths = true;
        break;
      case '--require-approval': {
        // Repeatable and comma-separated; "*" anywhere gates every tool.
        sawApprovalGate = true;
        for (const name of next().split(',')) {
          const trimmed = name.trim();
          if (trimmed.length === 0) throw new Error('--require-approval requires tool names or "*"');
          if (trimmed === '*') gateEveryTool = true;
          else gatedTools.add(trimmed);
        }
        break;
      }
      case '--approval-rule': {
        args.approvalRules.push(parseApprovalRuleFlag(next()));
        break;
      }
      case '--grant': {
        args.grants.push(parseGrantFlag(next()));
        break;
      }
      case '--approve': {
        const value = next();
        if (value === 'all') args.approveAll = true;
        else args.approvals.push({ executionId: value, decision: 'approved' });
        break;
      }
      case '--reject':
        args.approvals.push({ executionId: next(), decision: 'rejected' });
        break;
      case '--edit':
        args.approvals.push({ executionId: next(), decision: 'edited' });
        break;
      case '--args': {
        const decision = lastDecision('--args');
        if (decision.decision !== 'edited') throw new Error('--args must follow --edit');
        let parsed: unknown;
        try {
          parsed = JSON.parse(next()) as unknown;
        } catch (error) {
          throw new Error(`--args requires a JSON object: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('--args requires a JSON object');
        }
        decision.editedArguments = parsed as Record<string, unknown>;
        break;
      }
      case '--reason':
        lastDecision('--reason').reason = next();
        break;
      case '--audit': {
        const peek = argv[i + 1];
        args.audit = peek !== undefined && !peek.startsWith('-') ? argv[++i]! : 'latest';
        break;
      }
      case '--telemetry':
        args.telemetry = next();
        break;
      case '--usage':
        args.usage = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        // an unknown flag must not silently become prompt text
        if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown flag ${arg} — see pi --help`);
        positional.push(arg);
    }
  }
  if (sawApprovalGate) args.requireApproval = gateEveryTool ? '*' : [...gatedTools];
  for (const decision of args.approvals) {
    if (decision.decision === 'edited' && decision.editedArguments === undefined) {
      throw new Error(`--edit ${decision.executionId} requires --args '<json>'`);
    }
  }
  if (args.approveAll && args.approvals.length > 0) {
    throw new Error('--approve all cannot be combined with per-execution decisions');
  }
  const decided = new Set<string>();
  for (const decision of args.approvals) {
    if (decided.has(decision.executionId)) {
      throw new Error(`more than one decision for execution ${decision.executionId}`);
    }
    decided.add(decision.executionId);
  }
  args.prompt = positional.join(' ');
  return args;
}

export const HELP = `pi — minimal coding agent

usage: pi [options] [prompt]

options:
  -p, --print          headless: run the prompt, print the final reply to stdout, exit
  --json               headless JSONL event stream on stdout (implies --print)
  -c, --continue       continue the most recent session in this directory
  --session <id|path>  open a specific session
  --model <name>       override the model
  --profile <name>     provider profile (anthropic | openai | from ~/.config/pi/config.json)
  every --max-* below is a turn budget: per turn (one turn per input in -p)
  --max-turns <n>      cap model calls per turn (default 40)
  --max-tool-calls <n> cap tool executions per turn (default 100)
  --max-tool-output-bytes <n> cap retained output from each tool call
  --max-time <seconds> cap wall time per turn (default 1800)
  --max-input-tokens <n>  stop after the provider-reported input-token budget
  --max-output-tokens <n> stop after the provider-reported output-token budget
  --max-total-tokens <n>  stop after the combined provider-reported token budget
  --max-spend-usd <usd>   hard dollar ceiling; requires an exact price for the model
  --pricing <path>     use an explicit LiteLLM-compatible pricing table (disables fetch)
  --offline-pricing    use only the 24h/stale local pricing cache; never fetch
  --thinking <tokens>  enable extended thinking with this token budget (Anthropic models)
  --no-auto-compact    never summarize automatically when the context window fills
  --no-flail-guard     disable the doom-loop guard (nudge/stop on failing, repeating, or
                       alternating tool calls)
  --no-offload         keep old bulky tool outputs inline instead of offloading to disk
  --trust-project      load repository AGENTS.md, skill index, and prompt templates
  --allow-host-bash    expose unsandboxed host bash (dangerous; environment is sanitized)
  --allow-protected-paths  let write and edit modify .git/, .pi/, .agent/, .claude/, AGENTS.md,
                       .mcp.json, and workspace-root shell rc files (dangerous; reads are
                       always allowed and git changes belong in bash)
  --require-approval <names|*>  gate these tools behind a human decision; repeatable and
                       comma-separated. The turn suspends at the first gated call (exit 4)
                       and survives process loss; only this flag and ~/.config/pi/config.json
                       can set it. Tool-name gating is the fallback for any call no
                       approval rule matched.
  --approval-rule '<tool>:<allow|prompt|deny>:<word> <word>...'  argument-prefix rule,
                       repeatable and evaluated before the config file's approvals.rules.
                       Bash commands are split on && || | ; & and newlines; the first
                       matching rule wins per segment and deny beats prompt beats allow.
                       A prefix of the form <parameter>=<value> matches a tool whose
                       arguments are not a command line.
  --grant '<tool>:<word> <word>...'  write a session-scoped "always allow this prefix"
                       grant at startup (repeatable). A grant only narrows prompting;
                       it can never override a deny rule or an untokenizable command.
  --approve <id|all>   approve a suspended execution when reopening the session (with -c/--session)
  --reject <id>        reject one, with an optional following --reason "<text>"
  --edit <id> --args '<json>'  run one with replacement arguments (validated, and noted to the model)
  --audit [id|path]    print a per-request token-usage audit (default: latest here)
  doctor sessions      list sessions and lock state (read-only; --json per 0010;
                       --remove <file> --yes removes one verifiably dead local lock)
  --telemetry <path>   append redacted versioned runtime spans/events as owner-only JSONL
  --parent-run <id>    record this run as a child of <id>: the id reaches telemetry as
                       parentRunId and is echoed on every --json row
  --max-depth <n>      refuse to start when the inherited PI_DEPTH is deeper than <n>
                       (default 2). Each bash child is given PI_DEPTH + 1, so a piko
                       spawned from a tool call sees its own nesting depth. Depth is the
                       only tree bound today; concurrency and tree-wide spend caps arrive
                       with ADR 0026.
  --ext <path>[@sha256:<hex>]  load a compiled JavaScript extension module (repeatable);
                       with a pin the file's SHA-256 must match or pi refuses to start
  --usage              print a JSON usage summary to stderr when done
  -h, --help           show this help

interactive slash commands: /help /tokens /model /session /branch /compact /approvals /exit
  /approvals            list the session's approval grants and rules
  /approvals revoke <n> revoke grant <n> for the rest of the session
prompt templates: ~/.agent/commands/*.md always; project .agent/commands/*.md requires --trust-project`;
