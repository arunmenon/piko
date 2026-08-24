#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  LLMClient,
  addUsage,
  contextWindowFor,
  configPath,
  credentialDescriptor,
  emptyUsage,
  loadConfig,
  resolveProfile,
  type PiConfig,
  type Profile,
} from '@pi/ai';
import {
  Agent,
  JsonlEventSink,
  MAX_USER_INPUT_BYTES,
  SafeObserver,
  Session,
  addCostSummary,
  buildSystemPrompt,
  costComplete,
  defaultTools,
  discoverSkills,
  emptyCostSummary,
  latestSessionFile,
  loadPricingTable,
  loadAgentsMd,
  releaseSessionLock,
  resolveModelPrice,
  sessionsDirFor,
  tryLockSession,
  validateToolSet,
  type AgentEvent,
  type ApprovalDecisionInput,
  type Observer,
  type PendingApproval,
  type PricingTable,
  type RunBudget,
  type Tool,
} from '@pi/core';
import {
  APPROVAL_PROMPT,
  describePendingApproval,
  parseApprovalReply,
  parseEditedArguments,
  resolveDecisionFlags,
} from './approvals.js';
import { HELP, parseArgs, type CliArgs } from './args.js';
import { loadConfiguredExtensions } from './extensions.js';
import { interpolate, loadTemplates, type PromptTemplate } from './templates.js';
import {
  bold,
  cacheHitRate,
  cyan,
  dim,
  formatCost,
  formatUsage,
  oneLine,
  red,
  sanitizeTerminalText,
  summarizeArgs,
} from './render.js';

interface Setup {
  agent: Agent;
  profile: Profile;
  config: PiConfig;
  session: Session;
  tools: Tool[];
  maxIterations?: number;
  budget: Partial<RunBudget>;
  systemPrompt: string;
  allowHostBash: boolean;
  /** gated tool names; only CLI flags and user config can reach this */
  approval?: readonly string[] | '*';
  observer?: Observer;
  thinkingBudget?: number;
  contextWindow: number;
  autoCompact: boolean;
  flailGuard: boolean;
  offload: boolean;
  pricingTable: PricingTable;
}

class JsonRunFailure extends Error {
  readonly sessionId?: string;
  readonly body?: string;

  constructor(error: unknown, sessionId?: string) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'JsonRunFailure';
    this.sessionId = sessionId;
    const body = (error as { body?: unknown })?.body;
    if (typeof body === 'string') this.body = body;
  }
}

function openSession(args: CliArgs, cwd: string, model: string): Session {
  let file: string | undefined;
  if (args.session) {
    const inDir = join(sessionsDirFor(cwd), `${args.session}.jsonl`);
    file = existsSync(args.session) ? args.session : inDir;
    if (!existsSync(file)) throw new Error(`session not found: ${args.session}`);
  } else if (args.continue) {
    file = latestSessionFile(sessionsDirFor(cwd), { excludeActivelyLocked: true });
    if (!file) process.stderr.write(dim('no previous session here; starting a new one\n'));
  }
  if (file) {
    if (tryLockSession(file)) return Session.open(file);
    if (args.session) throw new Error(`requested session is already in use: ${file}`);
    process.stderr.write(dim('that session is in use by another pi process; starting a new one\n'));
  }
  return Session.createLocked(cwd, model).session;
}

function buildAgent(setup: Omit<Setup, 'agent'>, cwd: string, model: string): Agent {
  const pricing = resolveModelPrice(setup.pricingTable, model);
  if (setup.budget.maxSpendUSD !== undefined && !pricing) {
    throw new Error(`maxSpendUSD requires an exact price for model ${model}`);
  }
  return new Agent({
    client: new LLMClient(setup.profile),
    credential: credentialDescriptor(setup.profile),
    model,
    systemPrompt: setup.systemPrompt,
    tools: setup.tools,
    cwd,
    session: setup.session,
    toolPolicy: {
      workspaceRoot: cwd,
      bash: { allowHostExecution: setup.allowHostBash },
      ...(setup.approval !== undefined ? { approval: setup.approval } : {}),
    },
    ...(setup.observer ? { observer: setup.observer } : {}),
    contextWindow: setup.contextWindow,
    autoCompact: setup.autoCompact,
    ...(setup.flailGuard === false ? { flailGuard: false as const } : {}),
    ...(setup.offload === false ? { offload: false as const } : {}),
    ...(setup.maxIterations !== undefined ? { maxIterations: setup.maxIterations } : {}),
    ...(Object.keys(setup.budget).length > 0 ? { budget: setup.budget } : {}),
    ...(setup.thinkingBudget !== undefined ? { thinkingBudget: setup.thinkingBudget } : {}),
    ...(pricing ? { pricing } : {}),
  });
}

async function setup(args: CliArgs): Promise<Setup> {
  const cwd = process.cwd();
  const config = loadConfig();
  const profile = resolveProfile(config, args.profile, args.model);
  const pricingTable = await loadPricingTable({
    ...(args.pricingPath ? { explicitPath: args.pricingPath } : {}),
    cachePath: join(dirname(configPath()), 'model-prices-cache.json'),
    offline:
      args.offlinePricing ||
      process.env['PI_PRICING_OFFLINE'] === '1' ||
      profile.baseUrl !== undefined,
  });
  for (const warning of pricingTable.warnings) process.stderr.write(dim(`pricing warning: ${warning}\n`));
  if (args.maxSpendUSD !== undefined && !resolveModelPrice(pricingTable, profile.model)) {
    throw new Error(
      `--max-spend-usd requires an exact price for model ${profile.model}; add it to --pricing <path>`,
    );
  }
  const hasAgentsMd = existsSync(join(cwd, 'AGENTS.md'));
  const hasProjectTemplates = existsSync(join(cwd, '.agent', 'commands'));
  const agentsMd = args.trustProject ? loadAgentsMd(cwd) : undefined;
  const skills = args.trustProject ? discoverSkills(cwd) : [];
  if (!args.trustProject && (hasAgentsMd || existsSync(join(cwd, '.agent', 'skills')) || hasProjectTemplates)) {
    process.stderr.write(
      dim('project instructions and templates ignored by default; pass --trust-project to load them\n'),
    );
  }
  if (agentsMd?.oversized) {
    process.stderr.write(
      dim(
        `warning: AGENTS.md is ${agentsMd.lines} loaded lines${agentsMd.truncated ? ' and was truncated' : ''} — large guides hurt context quality\n`,
      ),
    );
  }
  const builtins = defaultTools().filter((tool) => tool.name !== 'bash' || args.allowHostBash);
  if (args.allowHostBash) {
    process.stderr.write(dim('warning: host bash enabled without OS isolation; use only in a trusted environment\n'));
  }
  const tools = validateToolSet(
    [
      ...builtins,
      ...(await loadConfiguredExtensions({
        configPaths: config.extensions ?? [],
        configFile: configPath(),
        cliPaths: args.extensions,
        cwd,
      })),
    ],
    { source: 'configured tools' },
  );
  const session = openSession(args, cwd, profile.model);
  const approval = args.requireApproval ?? profile.approval;
  const envWindow = Number(process.env['PI_CONTEXT_WINDOW']);
  const partial: Omit<Setup, 'agent'> = {
    config,
    profile,
    pricingTable,
    session,
    tools,
    contextWindow:
      Number.isFinite(envWindow) && envWindow > 0
        ? envWindow
        : (profile.contextWindow ?? contextWindowFor(profile.model)),
    autoCompact: args.autoCompact,
    flailGuard: args.flailGuard,
    offload: args.offload,
    systemPrompt: buildSystemPrompt({ cwd, agentsMd, skills, bashAvailable: args.allowHostBash }),
    allowHostBash: args.allowHostBash,
    // Provenance is restricted to the flag and the user config file. Project
    // content loaded by --trust-project and extensions never reach this field.
    ...(approval !== undefined ? { approval } : {}),
    ...(args.telemetry
      ? {
          observer: new SafeObserver({
            sink: new JsonlEventSink(args.telemetry),
            onError: (error) => process.stderr.write(dim(`telemetry warning: ${String(error)}\n`)),
          }),
        }
      : {}),
    budget: {
      ...(args.maxToolCalls !== undefined ? { maxToolCalls: args.maxToolCalls } : {}),
      ...(args.maxToolOutputBytes !== undefined ? { maxToolOutputBytes: args.maxToolOutputBytes } : {}),
      ...(args.maxTimeMs !== undefined ? { maxWallTimeMs: args.maxTimeMs } : {}),
      ...(args.maxInputTokens !== undefined ? { maxInputTokens: args.maxInputTokens } : {}),
      ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
      ...(args.maxTotalTokens !== undefined ? { maxTotalTokens: args.maxTotalTokens } : {}),
      ...(args.maxSpendUSD !== undefined ? { maxSpendUSD: args.maxSpendUSD } : {}),
    },
    ...(args.maxTurns !== undefined ? { maxIterations: args.maxTurns } : {}),
    ...(args.thinking !== undefined && args.thinking > 0 ? { thinkingBudget: args.thinking } : {}),
  };
  return { ...partial, agent: buildAgent(partial, cwd, profile.model) };
}

function printUsageSummary(
  agent: Agent,
  session: Session,
  terminal?: Extract<AgentEvent, { type: 'turn_done' }>,
): void {
  const totalCostComplete = agent.costHistoryComplete && costComplete(agent.costTotal);
  const lastTurnCostComplete = costComplete(agent.lastTurnCost);
  process.stderr.write(
    `${JSON.stringify({
      v: 1,
      type: 'usage_summary',
      usage: agent.usageTotal,
      lastTurn: agent.lastTurnUsage,
      cost: {
        ...agent.costTotal,
        ...(totalCostComplete ? { usd: agent.costTotal.actualUSD } : {}),
        complete: totalCostComplete,
      },
      lastTurnCost: {
        ...agent.lastTurnCost,
        ...(lastTurnCostComplete ? { usd: agent.lastTurnCost.actualUSD } : {}),
        complete: lastTurnCostComplete,
      },
      requests: agent.requestCount,
      usageHistoryComplete: agent.usageHistoryComplete,
      unknownPriorRequests: agent.session?.modelRequests.filter((request) => request.status === 'outcome_unknown').length ?? 0,
      session: session.file,
      ...(terminal ? { status: terminal.status, reason: terminal.reason } : {}),
    })}\n`,
  );
}

/**
 * Headless mode is the sub-agent story: progress goes to stderr, only the final
 * reply goes to stdout, so `pi -p "..."` composes cleanly inside bash tool calls.
 */
/** Pending approvals are the actionable part of a suspended run: always show them. */
function reportPendingApprovals(agent: Agent): void {
  const pending = agent.pendingApprovals;
  if (pending.length === 0) return;
  process.stderr.write(
    `${pending.length} tool call${pending.length === 1 ? '' : 's'} awaiting approval; decide with --approve/--reject/--edit on a resume:\n`,
  );
  for (const item of pending) process.stderr.write(`  ${describePendingApproval(item)}\n`);
}

async function headless(args: CliArgs): Promise<number> {
  const decisionFlags = args.approveAll || args.approvals.length > 0;
  let prompt = args.prompt;
  if (!prompt && !decisionFlags && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > MAX_USER_INPUT_BYTES) {
        throw new JsonRunFailure(`stdin prompt exceeds ${MAX_USER_INPUT_BYTES} UTF-8 bytes`);
      }
      chunks.push(buffer);
    }
    prompt = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!prompt && !decisionFlags) {
    if (args.json) throw new JsonRunFailure('no prompt: pass one as an argument or on stdin');
    process.stderr.write('no prompt: pass one as an argument or on stdin\n');
    return 1;
  }
  const { agent, session } = await setup(args);
  // A session with undecided approvals cannot accept new input: its transcript
  // still ends at the assistant tool_use whose results are pending.
  if (agent.suspended && !decisionFlags) {
    if (args.json) {
      throw new JsonRunFailure(
        'session is suspended awaiting tool approval; resume with --approve/--reject/--edit',
        (agent.session ?? session).id,
      );
    }
    reportPendingApprovals(agent);
    return 4;
  }
  if (!agent.suspended && decisionFlags) {
    const message = 'no suspended tool approvals in this session';
    if (args.json) throw new JsonRunFailure(message, (agent.session ?? session).id);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  // first Ctrl+C interrupts the turn (state stays well-formed), second force-quits
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    process.stderr.write('interrupting — Ctrl+C again to force quit\n');
  });
  process.once('SIGTERM', () => controller.abort(new Error('terminated')));

  let finalText = '';
  let terminal: Extract<AgentEvent, { type: 'turn_done' }> | undefined;
  const turn = decisionFlags
    ? agent.resume(
        resolveDecisionFlags(args.approvals, args.approveAll, agent.pendingApprovals),
        controller.signal,
      )
    : agent.run(prompt, controller.signal);
  try {
    for await (const event of turn) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ v: 1, sessionId: (agent.session ?? session).id, event })}\n`);
      }
      if (event.type === 'response_done') {
        const text = event.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text.trim()) finalText = text;
      } else if (event.type === 'turn_done') {
        terminal = event;
      }
      if (args.json) continue;

      if (event.type === 'tool_start') {
        process.stderr.write(dim(`⚙ ${oneLine(event.call.name, 64)} ${summarizeArgs(event.call.arguments)}\n`));
      } else if (event.type === 'compacted') {
        process.stderr.write(dim(`auto-compacted ${event.dropped} messages\n`));
      } else if (event.type === 'session_rotated') {
        process.stderr.write(dim(`rotated session journal to ${oneLine(event.sessionFile, 4096)}\n`));
      } else if (event.type === 'flail_nudge') {
        process.stderr.write(dim(`flail guard: nudged after ${event.consecutiveFailures} consecutive failures\n`));
      } else if (event.type === 'flail_stop') {
        process.stderr.write(`flail guard: stopped the turn after repeated failures\n`);
      } else if (event.type === 'offloaded') {
        process.stderr.write(dim(`offloaded ${event.count} old tool outputs\n`));
      } else if (event.type === 'budget_exceeded') {
        process.stderr.write(`budget exceeded: ${event.reason}\n`);
      } else if (event.type === 'approval_decided') {
        process.stderr.write(dim(`approval ${event.decision}: ${oneLine(event.call.name, 64)}\n`));
      }
    }
  } catch (error) {
    if (args.json) throw new JsonRunFailure(error, (agent.session ?? session).id);
    throw error;
  }
  // always emit what we have — a parent process needs the partial answer even on truncation
  if (!args.json) process.stdout.write(`${finalText}\n`);
  let exitCode: number;
  if (!terminal) {
    exitCode = controller.signal.aborted ? 130 : 1;
  } else if (terminal.status === 'completed') {
    exitCode = 0;
  } else {
    process.stderr.write(
      `run ${terminal.status}: ${terminal.reason} after ${terminal.iterations} model request(s) and ${terminal.toolCalls} tool call(s)\n`,
    );
    if (terminal.status === 'suspended') reportPendingApprovals(agent);
    exitCode =
      terminal.status === 'canceled'
        ? 130
        : terminal.status === 'budget_exceeded'
          ? 2
          : terminal.status === 'suspended'
            ? 4
            : 3;
  }
  // Keep this typed record last on stderr. Legacy benchmark panes may combine
  // stdout/stderr, so emitting it after model text prevents echoed JSON from
  // being mistaken for the authoritative terminal usage row.
  if (args.usage) printUsageSummary(agent, agent.session ?? session, terminal);
  return exitCode;
}

interface ReplState {
  running: AbortController | undefined;
  atNewline: boolean;
  steering: string[];
}

function handleEvent(event: AgentEvent, state: ReplState): void {
  const ensureNewline = () => {
    if (!state.atNewline) {
      process.stdout.write('\n');
      state.atNewline = true;
    }
  };
  switch (event.type) {
    case 'text': {
      const safeText = sanitizeTerminalText(event.text);
      process.stdout.write(safeText);
      state.atNewline = safeText.endsWith('\n');
      break;
    }
    case 'thinking':
      break; // reasoning is not rendered; it is still visible in the session file if the provider stores it
    case 'tool_start':
      ensureNewline();
      process.stdout.write(
        `${cyan('⚙')} ${bold(oneLine(event.call.name, 64))} ${dim(summarizeArgs(event.call.arguments))}\n`,
      );
      break;
    case 'tool_end': {
      const first = event.result.content[0];
      const summary = first?.type === 'text' ? oneLine(first.text, 100) : '[image]';
      process.stdout.write(`  ${event.result.isError ? red(summary) : dim(summary)}\n`);
      break;
    }
    case 'compacted':
      ensureNewline();
      process.stdout.write(
        dim(`[auto-compacted: summarized ${event.dropped} earlier messages into a fresh session]\n`),
      );
      break;
    case 'session_rotated':
      ensureNewline();
      process.stdout.write(dim(`[session journal rotated to ${oneLine(event.sessionFile, 4096)}]\n`));
      break;
    case 'flail_nudge':
      ensureNewline();
      process.stdout.write(dim(`[⚠ ${event.consecutiveFailures} failed tool calls in a row: nudging a change of approach]\n`));
      break;
    case 'flail_stop':
      ensureNewline();
      process.stdout.write(red(`[✋ stopping turn: repeated tool failures without progress; asking for a final report]\n`));
      break;
    case 'offloaded':
      ensureNewline();
      process.stdout.write(dim(`[offloaded ${event.count} old tool output${event.count === 1 ? '' : 's'} to disk (~${event.savedChars.toLocaleString()} chars)]\n`));
      break;
    case 'steered':
      ensureNewline();
      process.stdout.write(dim(`[↪ steering applied: ${oneLine(event.text, 80)}]\n`));
      break;
    case 'budget_exceeded':
      ensureNewline();
      process.stdout.write(red(`[budget exceeded: ${event.reason}]\n`));
      break;
    case 'turn_done':
      ensureNewline();
      process.stdout.write(
        dim(
          `[${event.status}:${event.reason} | ${event.iterations} model call${event.iterations === 1 ? '' : 's'} | ${event.toolCalls} tool call${event.toolCalls === 1 ? '' : 's'} | ${formatUsage(event.usage)} | ${formatCost(event.cost)}]\n`,
        ),
      );
      break;
    case 'approval_required':
      ensureNewline();
      process.stdout.write(
        red(`[✋ ${event.executions.length} tool call${event.executions.length === 1 ? '' : 's'} need approval]\n`),
      );
      break;
    case 'approval_decided':
      ensureNewline();
      process.stdout.write(dim(`[approval ${event.decision}: ${oneLine(event.call.name, 64)}]\n`));
      break;
    case 'response_done':
      ensureNewline();
      break;
  }
}

/**
 * Collect one decision per pending approval from a live terminal. Anything other
 * than an explicit answer re-asks; the caller stops the turn if the human quits.
 */
/** Promise-shaped readline question that resolves undefined if stdin closes first. */
function ask(rl: ReturnType<typeof createInterface>, query: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    };
    rl.once('close', onClose);
    rl.question(query, (answer) => {
      settled = true;
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

async function promptForDecisions(
  rl: ReturnType<typeof createInterface>,
  pending: readonly PendingApproval[],
): Promise<ApprovalDecisionInput[] | undefined> {
  const decisions: ApprovalDecisionInput[] = [];
  for (const item of pending) {
    process.stdout.write(`\n${bold('approval required')} ${dim(oneLine(item.executionId, 128))}\n`);
    process.stdout.write(`  ${bold(oneLine(item.call.name, 64))} ${dim(summarizeArgs(item.call.arguments))}\n`);
    process.stdout.write(`  ${dim(oneLine(JSON.stringify(item.call.arguments), 2_000))}\n`);
    for (;;) {
      const answer = await ask(rl, `${cyan(APPROVAL_PROMPT)} `);
      if (answer === undefined) return undefined; // stdin closed mid-question
      const reply = parseApprovalReply(answer);
      if (reply.kind === 'invalid') {
        process.stdout.write(red(`${reply.message}\n`));
        continue;
      }
      if (reply.kind === 'approve') {
        decisions.push({ executionId: item.executionId, decision: 'approved' });
        break;
      }
      if (reply.kind === 'reject') {
        decisions.push({
          executionId: item.executionId,
          decision: 'rejected',
          ...(reply.reason ? { reason: reply.reason } : {}),
        });
        break;
      }
      const raw = await ask(rl, `${cyan('replacement arguments (JSON):')} `);
      if (raw === undefined) return undefined;
      try {
        decisions.push({
          executionId: item.executionId,
          decision: 'edited',
          editedArguments: parseEditedArguments(raw),
        });
      } catch (error) {
        process.stdout.write(red(`${String(error instanceof Error ? error.message : error)}\n`));
        continue;
      }
      break;
    }
  }
  return decisions;
}

interface ReplTurnResult {
  exitCode: number;
  persistenceFailure: boolean;
  suspended: boolean;
}

type TurnRequest = { input: string } | { decisions: ApprovalDecisionInput[] };

/**
 * Run one turn, then keep going while approvals can be collected: the process
 * never has to exit for a decision, but each suspension is still a real durable
 * stop that a crash here would preserve.
 */
async function runInput(
  agent: Agent,
  request: TurnRequest,
  state: ReplState,
  collectDecisions?: (pending: readonly PendingApproval[]) => Promise<ApprovalDecisionInput[] | undefined>,
): Promise<ReplTurnResult> {
  let next: TurnRequest | undefined = request;
  let result: ReplTurnResult = { exitCode: 1, persistenceFailure: false, suspended: false };
  while (next) {
    const current: TurnRequest = next;
    next = undefined;
    state.running = new AbortController();
    let exitCode = 1;
    let persistenceFailure = false;
    let suspended = false;
    try {
      const drainSteering = () => state.steering.splice(0);
      const turn =
        'input' in current
          ? agent.run(current.input, state.running.signal, drainSteering)
          : agent.resume(current.decisions, state.running.signal, drainSteering);
      for await (const event of turn) {
        handleEvent(event, state);
        if (event.type === 'turn_done') {
          persistenceFailure = event.reason === 'persistence';
          suspended = event.status === 'suspended';
          exitCode =
            event.status === 'completed'
              ? 0
              : event.status === 'canceled'
                ? 130
                : event.status === 'budget_exceeded'
                  ? 2
                  : event.status === 'suspended'
                    ? 4
                    : 3;
        }
      }
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error);
      process.stdout.write(`\n${red(text)}\n`);
      if (/context|too long|maximum.*length/i.test(text)) {
        process.stdout.write(dim('the conversation may have outgrown the model context, try /compact\n'));
      }
    } finally {
      state.running = undefined;
      // a note typed during the final response would otherwise leak into the next turn
      state.steering.length = 0;
    }
    result = { exitCode, persistenceFailure, suspended };
    if (suspended && collectDecisions) {
      const decisions = await collectDecisions(agent.pendingApprovals);
      if (decisions) next = { decisions };
    }
  }
  return result;
}

interface SlashResult {
  input?: string;
  exit?: boolean;
  newSession?: Session;
  compact?: boolean;
  switchModel?: string;
}

function handleSlash(
  line: string,
  agent: Agent,
  session: Session,
  templates: Map<string, PromptTemplate>,
): SlashResult {
  const [command = '', ...rest] = line.slice(1).split(/\s+/);
  const argText = rest.join(' ');
  switch (command) {
    case 'help':
      process.stdout.write(`${HELP}\n`);
      if (templates.size > 0) {
        process.stdout.write(`templates: ${[...templates.keys()].map((n) => `/${oneLine(n, 128)}`).join(' ')}\n`);
      }
      return {};
    case 'exit':
    case 'quit':
      return { exit: true };
    case 'tokens':
      process.stdout.write(`total:     ${formatUsage(agent.usageTotal)}\n`);
      process.stdout.write(`last turn: ${formatUsage(agent.lastTurnUsage)}\n`);
      process.stdout.write(`cost:      ${formatCost(agent.costTotal)}\n`);
      process.stdout.write(`requests:  ${agent.requestCount}\n`);
      return {};
    case 'model':
      if (!argText) {
        process.stdout.write(`model: ${oneLine(agent.model, 256)}\n`);
        return {};
      }
      return { switchModel: argText };
    case 'session':
      process.stdout.write(`${oneLine(session.file, 4096)}\n${agent.messages.length} messages\n`);
      return {};
    case 'compact':
      return { compact: true };
    case 'branch': {
      const at = Number(argText);
      if (!Number.isInteger(at) || at < 0 || at >= agent.messages.length) {
        process.stdout.write(red(`usage: /branch <message-index 0..${agent.messages.length - 1}>\n`));
        return {};
      }
      const branched = session.branchLocked(at, agent.workingDirectory, agent.model).session;
      releaseSessionLock(session.file);
      process.stdout.write(`branched to ${oneLine(branched.file, 4096)}\n`);
      return { newSession: branched };
    }
    default: {
      const template = templates.get(command);
      if (template) return { input: interpolate(template, argText) };
      process.stdout.write(red(`unknown command /${command} — try /help\n`));
      return {};
    }
  }
}

async function repl(args: CliArgs): Promise<number> {
  const initial = await setup(args);
  let runtimeSetup = initial;
  let { agent, session } = initial;
  const templates = loadTemplates(process.cwd(), { trustProject: args.trustProject });
  const state: ReplState = { running: undefined, atNewline: true, steering: [] };

  process.stdout.write(
    `${bold('pi')} ${dim(`| ${oneLine(initial.profile.name, 128)}:${oneLine(agent.model, 256)} | session ${oneLine(session.id, 128)} | /help`)}\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${cyan('pi>')} ` });
  // Inline decisions need a live human at the other end. Scripted stdin is a
  // batch: it reports the suspension and exits 4 rather than inventing answers.
  const collectDecisions = process.stdin.isTTY
    ? (pending: readonly PendingApproval[]) => promptForDecisions(rl, pending)
    : undefined;
  const reportSuspension = (suspendedAgent: Agent): void => {
    process.stdout.write(red('[suspended: tool approvals are pending]\n'));
    for (const item of suspendedAgent.pendingApprovals) {
      process.stdout.write(dim(`  ${describePendingApproval(item)}\n`));
    }
    process.stdout.write(
      dim('resume with: pi -c --approve <id|all> | --reject <id> --reason "…" | --edit <id> --args \'<json>\'\n'),
    );
  };
  let sigintArmed = false;
  rl.on('SIGINT', () => {
    if (state.running) {
      if (state.running.signal.aborted) {
        process.stdout.write(`\n${dim('force quit')}\n`);
        process.exit(130); // second Ctrl+C during a stuck turn must always work
      }
      state.running.abort();
      process.stdout.write(`\n${dim('interrupted — Ctrl+C again to force quit')}\n`);
    } else if (!sigintArmed) {
      sigintArmed = true;
      process.stdout.write(`\n${dim('press Ctrl+C again to exit')}\n`);
      rl.prompt();
    } else {
      rl.close();
    }
  });

  return new Promise<number>((resolveRepl) => {
    let finished = false;
    let processing = false;
    let eof = false;
    let exitCode = 0;
    const scripted = !process.stdin.isTTY;
    const pending: string[] = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      if (args.usage) printUsageSummary(agent, session);
      resolveRepl(exitCode);
    };
    // stdin EOF (piped input) closes readline immediately — queued lines must still run
    rl.on('close', () => {
      eof = true;
      if (!processing && pending.length === 0) finish();
    });

    /** returns true when the REPL should stop (explicit /exit) */
    const handleLine = async (rawLine: string): Promise<boolean> => {
      sigintArmed = false;
      const line = rawLine.trim();
      if (line.length === 0) {
        if (!eof) rl.prompt();
        return false;
      }
      let input: string | undefined;
      if (line.startsWith('/')) {
        const result = handleSlash(line, agent, session, templates);
        if (result.exit) {
          pending.length = 0;
          rl.close();
          return true;
        }
        if (result.switchModel) {
          const parts = result.switchModel.split(/\s+/).filter(Boolean);
          const profileName = parts.length > 1 ? parts[0] : runtimeSetup.profile.name;
          const model = parts.length > 1 ? parts.slice(1).join(' ') : parts[0]!;
          try {
            const profile = resolveProfile(runtimeSetup.config, profileName, model);
            const envWindow = Number(process.env['PI_CONTEXT_WINDOW']);
            const contextWindow =
              Number.isFinite(envWindow) && envWindow > 0
                ? envWindow
                : (profile.contextWindow ?? contextWindowFor(profile.model));
            const nextSetup = { ...runtimeSetup, profile, contextWindow, session };
            agent = buildAgent(nextSetup, agent.workingDirectory, profile.model);
            runtimeSetup = { ...nextSetup, agent };
            process.stdout.write(
              `model: ${oneLine(profile.name, 128)}:${oneLine(profile.model, 256)} (${contextWindow.toLocaleString()} context)\n`,
            );
          } catch (error) {
            process.stdout.write(red(`model switch failed: ${String(error)}\n`));
          }
        }
        if (result.compact) {
          if (agent.messages.length === 0) {
            process.stdout.write(dim('nothing to compact\n'));
          } else {
            process.stdout.write(dim('compacting…\n'));
            const source = session;
            let compactionId: string | undefined;
            let lockedChild: ReturnType<typeof Session.createLocked> | undefined;
            let commitAttempted = false;
            state.running = new AbortController();
            try {
              compactionId = source.beginCompaction('manual', { keepFromMessage: agent.messages.length });
              const summary = await agent.summarize(state.running.signal);
              lockedChild = Session.createLocked(agent.workingDirectory, agent.model, dirname(source.file), {
                lineage: {
                  parentSessionId: source.id,
                  parentFile: source.file,
                  relation: 'compaction',
                  priorUsage: structuredClone(agent.usageTotal),
                  priorUsageComplete: agent.usageHistoryComplete,
                  priorCost: structuredClone(agent.costTotal),
                },
              });
              const fresh = lockedChild.session;
              fresh.append({
                t: 'msg',
                message: { role: 'user', content: [{ type: 'text', text: `Summary of the previous session:\n\n${summary}` }] },
              });
              const nextAgent = buildAgent(
                {
                  ...runtimeSetup,
                  session: fresh,
                  maxIterations: runtimeSetup.maxIterations,
                  thinkingBudget: runtimeSetup.thinkingBudget,
                },
                agent.workingDirectory,
                agent.model,
              );
              commitAttempted = true;
              source.completeCompaction(compactionId, agent.messages.length, { targetSessionId: fresh.id });
              releaseSessionLock(source.file);
              session = fresh;
              agent = nextAgent;
              runtimeSetup = { ...runtimeSetup, session, agent };
              process.stdout.write(`compacted into session ${oneLine(session.id, 128)}\n`);
            } catch (error) {
              if (lockedChild && !commitAttempted) {
                lockedChild.release();
                try {
                  unlinkSync(lockedChild.session.file);
                } catch {
                  /* preserve the original compaction error */
                }
              }
              if (compactionId && !commitAttempted) {
                try {
                  source.failCompaction(compactionId, String(error));
                } catch {
                  /* preserve the original compaction error */
                }
              }
              process.stdout.write(
                red(
                  `${commitAttempted ? 'compaction commit outcome is unknown; exit and resume before continuing' : 'compaction failed'}: ${String(error)}\n`,
                ),
              );
              if (commitAttempted) {
                exitCode = 3;
                pending.length = 0;
                rl.close();
                return true;
              }
            } finally {
              state.running = undefined;
            }
          }
        }
        if (result.newSession) {
          session = result.newSession;
          // rebuild on the branched session, keeping tools/extensions, caps, and model
          agent = buildAgent(
            {
              ...runtimeSetup,
              session,
              maxIterations: runtimeSetup.maxIterations,
              thinkingBudget: runtimeSetup.thinkingBudget,
            },
            agent.workingDirectory,
            agent.model,
          );
          runtimeSetup = { ...runtimeSetup, session, agent };
        }
        input = result.input;
      } else {
        input = line;
      }
      if (input) {
        const turn = await runInput(agent, { input }, state, collectDecisions);
        if (turn.suspended) reportSuspension(agent);
        if (scripted && turn.exitCode !== 0 && exitCode === 0) exitCode = turn.exitCode;
        // auto-compaction may have moved the agent to a fresh session file
        if (agent.session && agent.session !== session) session = agent.session;
        if (turn.persistenceFailure) {
          exitCode = turn.exitCode || 3;
          pending.length = 0;
          process.stdout.write(red('session persistence failed; exiting so the journal can be reopened and reconciled\n'));
          rl.close();
          return true;
        }
      }
      if (!eof) rl.prompt();
      return false;
    };

    const onTurnFailure = (error: unknown): void => {
      exitCode = 1;
      pending.length = 0;
      process.stdout.write(`\n${red(String(error instanceof Error ? error.message : error))}\n`);
      rl.close();
    };

    const drainQueue = async (first: string): Promise<void> => {
      processing = true;
      let completed = false;
      try {
        let line: string | undefined = first;
        while (line !== undefined) {
          if (await handleLine(line)) break;
          line = pending.shift();
        }
        completed = true;
      } finally {
        processing = false;
        // On rejection the outer handler must set the nonzero code before close
        // resolves the REPL promise.
        if (completed && eof) finish();
      }
    };

    rl.on('line', (rawLine) => {
      if (processing) {
        if (process.stdin.isTTY) {
          if (state.running) {
            // typed input mid-turn becomes steering, injected before the next model call
            const note = rawLine.trim();
            if (note.length > 0) {
              state.steering.push(note);
              process.stdout.write(dim('\n(↪ queued as steering for the next step)\n'));
            }
          } else {
            // busy but no turn running (e.g. /compact): dropping beats a buffered line
            // silently firing a full agent turn later
            process.stdout.write(dim('\n(busy: input ignored, resend when idle)\n'));
          }
        } else {
          pending.push(rawLine); // piped stdin is a script: preserve order, run sequentially
        }
        return;
      }
      void drainQueue(rawLine).catch(onTurnFailure);
    });

    // A session opened with pending approvals must settle them before it can take
    // new input: its transcript still ends at the assistant tool_use.
    processing = true;
    const startupDecisions = args.approveAll || args.approvals.length > 0;
    const start = async (): Promise<void> => {
      try {
        if (agent.suspended) {
          const decisions = startupDecisions
            ? resolveDecisionFlags(args.approvals, args.approveAll, agent.pendingApprovals)
            : await collectDecisions?.(agent.pendingApprovals);
          if (decisions) {
            const turn = await runInput(agent, { decisions }, state, collectDecisions);
            if (turn.suspended) reportSuspension(agent);
            if (agent.session && agent.session !== session) session = agent.session;
            if (scripted && turn.exitCode !== 0 && exitCode === 0) exitCode = turn.exitCode;
          } else {
            reportSuspension(agent);
            if (exitCode === 0) exitCode = 4;
          }
        } else if (startupDecisions) {
          process.stdout.write(red('no suspended tool approvals in this session\n'));
          if (exitCode === 0) exitCode = 1;
        }
      } finally {
        processing = false;
      }
      const queued = pending.shift();
      if (queued !== undefined) {
        void drainQueue(queued).catch(onTurnFailure);
        return;
      }
      if (eof) finish();
      else rl.prompt();
    };
    void start().catch(onTurnFailure);
  });
}

/**
 * Reconstructs a session's per-request economics from its JSONL — the local answer
 * to "what token usage did this run report": every number here is what the provider
 * reported at request time. Dollar rows retain the exact table provenance used
 * at execution time; audit never re-prices history with today's table.
 */
function auditSession(target: string, cwd: string): number {
  let file: string | undefined;
  if (target === 'latest') file = latestSessionFile(sessionsDirFor(cwd));
  else if (existsSync(target)) file = target;
  else {
    const inDir = join(sessionsDirFor(cwd), `${target}.jsonl`);
    if (existsSync(inDir)) file = inDir;
  }
  if (!file) {
    process.stderr.write(`no session found for "${oneLine(target, 4096)}"\n`);
    return 1;
  }
  const chain: Session[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = file;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const current = Session.open(cursor);
    chain.unshift(current);
    const lineage = current.lineage;
    cursor =
      (lineage?.relation === 'compaction' || lineage?.relation === 'continuation') &&
      lineage.parentFile &&
      existsSync(lineage.parentFile)
        ? lineage.parentFile
        : undefined;
  }
  const latest = chain.at(-1)!;
  const rows = chain.flatMap((item) => [...item.usageLedgerEntries]);
  const requests = chain.flatMap((item) => [...item.modelRequests]);
  const unknownRequests = requests.filter((request) => request.status === 'outcome_unknown');
  const reservedRequests = requests.filter(
    (request) => request.status !== 'completed' && request.spendReservation !== undefined,
  );
  const failedCompactions = chain.flatMap((item) =>
    item.lifecycleEntries.filter((entry) => entry.t === 'compaction_failed'),
  );
  const messages = latest.messages.length;
  const models = new Set<string>();
  for (const item of chain) {
    if (item.meta?.model) models.add(item.meta.model);
    for (const entry of item.lifecycleEntries) {
      if (entry.t === 'model_request_started') models.add(entry.model);
    }
  }
  const safeModels = [...models].map((model) => oneLine(model, 256));
  process.stdout.write(
    `${oneLine(file, 4096)}\nmodel${models.size === 1 ? '' : 's'} ${safeModels.join(', ') || '?'} | ${messages} live messages | ${requests.length} provider attempts | ${rows.length} with reported usage | ${unknownRequests.length} outcome unknown | ${chain.length} linked session${chain.length === 1 ? '' : 's'}\n`,
  );
  if (latest.lineage) {
    process.stdout.write(
      `lineage ${latest.lineage.relation} from ${oneLine(latest.lineage.parentSessionId, 256)}\n`,
    );
  }
  if (latest.runStatus) {
    process.stdout.write(
      `terminal ${latest.runStatus.status}${latest.runStatus.reason ? `:${oneLine(latest.runStatus.reason, 512)}` : ''}\n`,
    );
  }
  for (const request of unknownRequests.slice(0, 10)) {
    process.stdout.write(
      `unknown request ${oneLine(request.requestId, 256)} (${oneLine(request.model, 256)}): ${oneLine(request.reason ?? 'no terminal record', 512)}\n`,
    );
  }
  if (unknownRequests.length > 10) process.stdout.write(`... ${unknownRequests.length - 10} more unknown requests\n`);
  for (const request of reservedRequests.slice(0, 10)) {
    const reservation = request.spendReservation!;
    process.stdout.write(
      `reserved exposure ${oneLine(request.requestId, 256)}: $${reservation.usd.toFixed(6)} model=${oneLine(reservation.model, 256)} source=${reservation.pricing.source} revision=${oneLine(reservation.pricing.revision, 128)} currency=${reservation.pricing.currency} effective=${reservation.pricing.effectiveAt}\n`,
    );
  }
  for (const compaction of failedCompactions.slice(-10)) {
    process.stdout.write(
      `failed compaction ${oneLine(compaction.compactionId, 256)}: ${oneLine(compaction.error, 512)}\n`,
    );
  }
  process.stdout.write('\n');
  process.stdout.write('req      input  cache-read  cache-write  output  hit%          USD\n');
  const total = emptyUsage();
  const costTotal = emptyCostSummary();
  for (const item of chain) addCostSummary(costTotal, item.costSummary);
  rows.forEach((row, index) => {
    const hit = cacheHitRate(row.usage);
    process.stdout.write(
      `${String(index + 1).padStart(3)}  ${String(row.usage.inputTokens).padStart(9)}  ${String(row.usage.cacheReadTokens).padStart(10)}  ${String(row.usage.cacheWriteTokens).padStart(11)}  ${String(row.usage.outputTokens).padStart(6)}  ${hit !== undefined ? String(hit).padStart(3) + '%' : '    '}  ${row.cost ? `$${row.cost.usd.toFixed(6)}`.padStart(11) : '  unpriced'}\n`,
    );
    addUsage(total, row.usage);
  });
  process.stdout.write(`\ntotal: ${formatUsage(total)} | ${formatCost(costTotal)}\n`);
  rows.forEach((row, index) => {
    if (!row.cost) return;
    const pricing = row.cost.pricing;
    process.stdout.write(
      `pricing req ${index + 1}: model=${oneLine(row.cost.model, 256)} source=${pricing.source} revision=${oneLine(pricing.revision, 128)} currency=${pricing.currency} effective=${pricing.effectiveAt}\n`,
    );
  });
  const hit = cacheHitRate(total);
  if (hit === undefined && rows.length > 1) {
    process.stdout.write(
      "note: zero cache reads across the session; the fixed prefix may sit below the provider's minimum cacheable size\n",
    );
  }
  return 0;
}

async function main(): Promise<void> {
  const jsonRequested = process.argv.slice(2).includes('--json');
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    if (args.audit !== undefined) {
      if (args.json) throw new Error('--json cannot be combined with --audit');
      process.exitCode = auditSession(args.audit, process.cwd());
      return;
    }
    process.exitCode = args.print ? await headless(args) : await repl(args);
  } catch (error) {
    let text = String(error instanceof Error ? error.message : error);
    // surface the API's own explanation (model not found, quota, …), not just the status
    const body = (error as { body?: string }).body;
    if (body) {
      const flattenedBody = body.replace(/\s+/g, ' ').trim();
      const boundedBody =
        flattenedBody.length > 300 ? `${flattenedBody.slice(0, 300)}…` : flattenedBody;
      // JSON remains an encoded lossless transport for the bounded provider
      // diagnostic. Human-facing output is sanitized by red() below.
      text += ` — ${jsonRequested ? boundedBody : oneLine(boundedBody, 301)}`;
    }
    if (jsonRequested) {
      const failure = error instanceof JsonRunFailure ? error : new JsonRunFailure(error);
      process.stdout.write(
        `${JSON.stringify({
          v: 1,
          ...(failure.sessionId ? { sessionId: failure.sessionId } : {}),
          event: { type: 'run_error', error: text },
        })}\n`,
      );
    } else {
      process.stderr.write(`${red(text)}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
