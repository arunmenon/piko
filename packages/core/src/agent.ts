import { mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  addUsage,
  emptyUsage,
  estimateTokens,
  type AssistantMessage,
  type CompletionRequest,
  type CredentialDescriptor,
  type Message,
  type StopReason,
  type StreamEvent,
  type ToolCallBlock,
  type ToolResultBlock,
  type Usage,
  type UserBlock,
} from '@pi/ai';
import {
  SESSION_ROTATE_BYTES,
  Session,
  costAcrossSessionLineageDetailed,
  releaseSessionLock,
  usageAcrossSessionLineageDetailed,
  type ApprovalDecision,
  type RunBudgetSnapshot,
  type ToolApprovalState,
  type ToolExecutionState,
} from './session.js';
import {
  addCostSummary,
  addRequestCost,
  costComplete,
  costForUsage,
  emptyCostSummary,
  reserveRequestSpend,
  spendExposure,
  validateModelPrice,
  type CostSummary,
  type ModelPrice,
  type RequestCost,
  type SpendReservation,
} from './pricing.js';
import {
  defaultToolExecutionPolicy,
  requiresApproval,
  type Tool,
  type ToolContext,
  type ToolExecutionPolicy,
  type ToolOutput,
  type ToolPolicyObservation,
} from './tools/types.js';
import { truncateMiddle } from './truncate.js';
import { atomicWriteTextFile, resolveWorkspacePath, resolveWorkspaceRoot } from './tools/filesystem.js';
import { validateToolArguments } from './tools/validation.js';
import {
  createRuntimeEvent,
  createSpanEnded,
  createSpanStarted,
  createTelemetryContext,
  createTelemetryId,
  type Observer,
  type RuntimeTelemetryEvent,
  type TelemetryContext,
} from './telemetry.js';

/** structural interface satisfied by LLMClient — lets tests drive the loop without a network */
export interface CompletionClient {
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void>;
}

const KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_WALL_TIME_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;
export const MIN_TOOL_OUTPUT_BYTES = 256;
export const MAX_USER_INPUT_BYTES = 1_048_576;
const COMPACTION_SUMMARY_INPUT_RESERVE_TOKENS = 1_024;
const COMPACTION_SUMMARY_MAX_TOKENS = 768;
const COMPACTION_SYSTEM_PROMPT =
  'You condense coding sessions into faithful handoff notes. Be terse, concrete, and never invent omitted details.';
const DEFAULT_REQUEST_MAX_TOKENS = 8_192;
const THINKING_RESPONSE_RESERVE_TOKENS = 1_024;
const OBSERVER_OPERATION_TIMEOUT_MS = 1_000;

export interface RunBudget {
  /** Maximum provider requests, including compaction requests, in one user turn. */
  maxModelRequests: number;
  /** Maximum tool calls that may begin in one user turn. */
  maxToolCalls: number;
  /** End-to-end deadline for one user turn. */
  maxWallTimeMs: number;
  /** Maximum serialized output retained from one tool call. */
  maxToolOutputBytes: number;
  /** Optional cumulative provider-reported input-token ceiling for one turn. */
  maxInputTokens?: number;
  /** Optional cumulative provider-reported output-token ceiling for one turn. */
  maxOutputTokens?: number;
  /** Optional cumulative provider-reported input + output ceiling for one turn. */
  maxTotalTokens?: number;
  /** Optional per-turn dollar ceiling, enforced using a conservative pre-dispatch reservation. */
  maxSpendUSD?: number;
}

export type TurnStatus = 'completed' | 'incomplete' | 'budget_exceeded' | 'canceled' | 'suspended';
export type TurnStopReason =
  | 'end_turn'
  | 'awaiting_approval'
  | 'max_tokens'
  | 'provider_stop'
  | 'empty_response'
  | 'context_window'
  | 'model_requests'
  | 'tool_calls'
  | 'wall_time'
  | 'input_tokens'
  | 'output_tokens'
  | 'total_tokens'
  | 'spend'
  | 'flail_stop'
  | 'persistence'
  | 'user_abort';

interface ToolCallExecution {
  result: ToolOutput;
  /** Dispatch began, but cancellation won before the executor reported a terminal result. */
  outcomeUnknown?: boolean;
}

/** One gated call presented to a human for approval. */
export interface PendingApproval {
  executionId: string;
  call: ToolCallBlock;
}

/** A human decision applied when a suspended session is resumed. */
export interface ApprovalDecisionInput {
  executionId: string;
  decision: ApprovalDecision;
  /** Required for `edited`; validated against the tool schema before anything is journaled. */
  editedArguments?: Record<string, unknown>;
  /** Human explanation, carried into the tool result the model sees. */
  reason?: string;
  /** When the human decided, if that predates this process. */
  decidedAt?: string;
}

/** One entry of the tool batch produced by a single assistant response. */
interface BatchCall {
  call: ToolCallBlock;
  executionId: string;
  journaled: boolean;
  /** Result already produced — executed before a suspension, or reconstructed on resume. */
  settled?: ToolResultBlock;
  approval?: ToolApprovalState;
}

/** The batch a suspended turn stopped inside, retained for an in-process resume. */
interface SuspendedBatch {
  requestId?: string;
  calls: BatchCall[];
}

type TurnStart =
  | { kind: 'input'; input: string }
  | { kind: 'resume'; batch: SuspendedBatch; decisions: ApprovalDecisionInput[] };

class CompactionPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompactionPersistenceError';
  }
}

class SpendBudgetExceededError extends Error {
  constructor(readonly reservationUSD: number, readonly remainingUSD: number) {
    super(
      `spend budget cannot reserve $${reservationUSD.toFixed(6)} for the next provider request; $${Math.max(0, remainingUSD).toFixed(6)} remains`,
    );
    this.name = 'SpendBudgetExceededError';
  }
}

function addUnknownRequestCost(total: CostSummary, reservation?: SpendReservation): void {
  total.unknownRequests++;
  if (reservation) total.reservedUSD += reservation.usd;
}

/**
 * Earliest message index whose tail fits the keep budget, constrained to clean
 * boundaries (a user message with no tool results — never splits a tool_use from
 * its results). Falls back to the most recent boundary when one turn is oversized.
 */
export function chooseKeepBoundary(messages: Message[], keepTokens = KEEP_RECENT_TOKENS): number {
  let suffixChars = 2; // JSON array brackets
  let latestBoundary: number | undefined;
  let earliestFittingBoundary: number | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    suffixChars += JSON.stringify(message).length + (index === messages.length - 1 ? 0 : 1);
    if (message.role === 'user' && !message.content.some((block) => block.type === 'toolResult')) {
      latestBoundary ??= index;
      if (Math.ceil(suffixChars / 4) <= keepTokens) earliestFittingBoundary = index;
    }
  }
  if (latestBoundary === undefined) return messages.length;
  return earliestFittingBoundary ?? latestBoundary;
}

function toolResultBlock(call: ToolCallBlock, text: string, isError = false): ToolResultBlock {
  return {
    type: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** What the model is told about a call whose result payload never reached the transcript. */
function interruptedResultText(state?: ToolExecutionState): string {
  if (state?.approval?.decision === 'rejected') {
    return `not run: a human reviewer rejected this tool call${state.approval.reason ? `: ${state.approval.reason}` : ''}`;
  }
  if (state?.status === 'planned' || state?.status === 'awaiting_approval' || state?.status === 'skipped') {
    return 'interrupted: this tool call was durably recorded as not started; it did not run';
  }
  if (state?.status === 'completed') {
    return 'interrupted: this tool call completed, but its result payload was not recorded; do not repeat it without reconciliation';
  }
  if (state?.status === 'failed') {
    return `interrupted: this tool call finished with an error before its result payload was recorded${state.error ? `: ${state.error}` : ''}`;
  }
  return 'interrupted: the prior process ended before recording this tool result; the outcome is unknown and the call must not be repeated without reconciliation';
}

/** If the transcript ends in an assistant message with tool calls but no results,
 *  produce a user message of synthesized error results (both APIs reject the gap). */
export function synthesizeInterruptedResults(
  messages: Message[],
  executions: readonly ToolExecutionState[] = [],
): Message | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return undefined;
  const calls = last.content.filter((block): block is ToolCallBlock => block.type === 'toolCall');
  if (calls.length === 0) return undefined;
  const stateByCallId = new Map(executions.map((state) => [state.call.id, state]));
  return {
    role: 'user',
    content: calls.map((call): ToolResultBlock => toolResultBlock(call, interruptedResultText(stateByCallId.get(call.id)), true)),
  };
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; call: ToolCallBlock }
  | { type: 'tool_end'; call: ToolCallBlock; result: ToolOutput }
  | { type: 'response_done'; message: AssistantMessage; stopReason: StopReason; usage: Usage; cost?: RequestCost }
  | { type: 'compacted'; dropped: number; sessionFile?: string }
  | { type: 'session_rotated'; sessionFile: string }
  | { type: 'flail_nudge'; consecutiveFailures: number }
  | { type: 'flail_stop'; consecutiveFailures: number }
  | { type: 'offloaded'; count: number; savedChars: number }
  | { type: 'steered'; text: string }
  | { type: 'approval_required'; executions: PendingApproval[] }
  | {
      type: 'approval_decided';
      executionId: string;
      call: ToolCallBlock;
      decision: ApprovalDecision;
      reason?: string;
    }
  | {
      type: 'budget_exceeded';
      reason: 'model_requests' | 'tool_calls' | 'wall_time' | 'input_tokens' | 'output_tokens' | 'total_tokens' | 'spend';
    }
  | {
      type: 'turn_done';
      iterations: number;
      toolCalls: number;
      usage: Usage;
      cost: CostSummary;
      status: TurnStatus;
      reason: TurnStopReason;
    };

export interface AgentOptions {
  client: CompletionClient;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  cwd: string;
  session?: Session;
  /** stable workspace and shell-environment policy applied to every built-in tool call */
  toolPolicy?: ToolExecutionPolicy;
  /** best-effort structured telemetry observer; never receives prompt/tool content from core */
  observer?: Observer;
  /** observer wedge-detection timeout; test-oriented override, default 1000ms */
  observerOperationTimeoutMs?: number;
  /**
   * Names-only description of the credential the client attaches to provider
   * requests (0016). Supplied by the trusted controller that resolved the
   * profile; the key itself never reaches the agent.
   */
  credential?: CredentialDescriptor;
  /** optional parent run correlation for embedded/subagent use */
  parentRunId?: string;
  /** cap on model calls per user input — the headless --max-turns guard */
  maxIterations?: number;
  /** hard per-turn budgets; individual values override the safe defaults */
  budget?: Partial<RunBudget>;
  /** deadline for each provider request, including streaming and retries (default 5 minutes) */
  requestTimeoutMs?: number;
  /** extended-thinking budget in tokens (Anthropic models) */
  thinkingBudget?: number;
  /** model context window in tokens — enables auto-compaction when set */
  contextWindow?: number;
  /** Exact-model USD pricing resolved once by the trusted controller at startup. */
  pricing?: ModelPrice;
  /** set false to disable auto-compaction (default on when contextWindow is known) */
  autoCompact?: boolean;
  /** doom-loop guard: nudge after N consecutive tool failures, stop the turn after M (default 5/10;
   *  identical failing calls escalate faster via repeatNudgeAfter/repeatStopAfter, default 2/4; false disables) */
  flailGuard?:
    | false
    | { nudgeAfter?: number; stopAfter?: number; repeatNudgeAfter?: number; repeatStopAfter?: number };
  /** microcompaction: offload old bulky tool outputs to disk, leaving a re-readable path stub (false disables) */
  offload?: false | { thresholdChars?: number; keepRecentMessages?: number };
}

const NUDGE_TEXT =
  '[harness] Several tool calls in a row have failed. Step back: re-read the errors, question the current approach, and try a different strategy instead of repeating the same command.';
const STOP_TEXT =
  '[harness] Stopping this turn: repeated tool failures with no progress. Do not call more tools. Summarize what you tried, the current state of the work, and what is blocking you.';
const OFFLOAD_BATCH_MIN_CHARS = 8_000; // offloading rewrites history (a cache break), so only do it in worthwhile batches

function inputTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function totalTokens(usage: Usage): number {
  return inputTokens(usage) + usage.outputTokens;
}

function usageBudgetReason(usage: Usage, budget: RunBudget): TurnStopReason | undefined {
  if (budget.maxInputTokens !== undefined && inputTokens(usage) >= budget.maxInputTokens) return 'input_tokens';
  if (budget.maxOutputTokens !== undefined && usage.outputTokens >= budget.maxOutputTokens) return 'output_tokens';
  if (budget.maxTotalTokens !== undefined && totalTokens(usage) >= budget.maxTotalTokens) return 'total_tokens';
  return undefined;
}

/** A completed response may consume exactly its ceiling; only an overshoot invalidates that completion. */
function exceededUsageBudgetReason(usage: Usage, budget: RunBudget): TurnStopReason | undefined {
  if (budget.maxInputTokens !== undefined && inputTokens(usage) > budget.maxInputTokens) return 'input_tokens';
  if (budget.maxOutputTokens !== undefined && usage.outputTokens > budget.maxOutputTokens) return 'output_tokens';
  if (budget.maxTotalTokens !== undefined && totalTokens(usage) > budget.maxTotalTokens) return 'total_tokens';
  return undefined;
}

function unexecutedToolResults(calls: ToolCallBlock[], explanation: string): Message | undefined {
  if (calls.length === 0) return undefined;
  return {
    role: 'user',
    content: calls.map(
      (call): ToolResultBlock => ({
        type: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: explanation }],
        isError: true,
      }),
    ),
  };
}

function boundToolOutput(result: ToolOutput, maxBytes: number): ToolOutput {
  const bytes = Buffer.byteLength(JSON.stringify(result.content));
  if (bytes <= maxBytes) return result;
  const readable = result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.mimeType} image omitted by output budget]`))
    .join('\n');
  const marker = `[tool output capped: ${bytes} serialized bytes exceeded ${maxBytes}]`;
  const candidate = (chars: number): ToolOutput => ({
    content: [{ type: 'text', text: chars > 0 ? `${truncateMiddle(readable, chars)}\n${marker}` : marker }],
    ...(result.isError ? { isError: true } : {}),
  });
  let chars = Math.min(readable.length, maxBytes);
  for (let attempt = 0; attempt < 32; attempt++) {
    const bounded = candidate(chars);
    const candidateBytes = Buffer.byteLength(JSON.stringify(bounded.content));
    if (candidateBytes <= maxBytes) return bounded;
    if (chars === 0) break;
    chars = Math.max(0, Math.min(chars - 1, Math.floor((chars * maxBytes) / candidateBytes) - 1));
  }
  // The configured minimum guarantees this final diagnostic fits.
  return {
    content: [{ type: 'text', text: '[tool output capped]' }],
    ...(result.isError ? { isError: true } : {}),
  };
}

async function nextStreamEvent<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next();
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new Error('aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function releaseStream<T>(iterator: AsyncIterator<T>): void {
  try {
    const released = iterator.return?.();
    if (released) void Promise.resolve(released).catch(() => undefined);
  } catch {
    /* a hostile/custom iterator cannot block or fail run finalization */
  }
}

export class Agent {
  readonly messages: Message[];
  readonly usageTotal: Usage = emptyUsage();
  readonly costTotal: CostSummary = emptyCostSummary();
  /** Whether usageTotal includes every ancestor rather than a bounded legacy prefix. */
  readonly usageHistoryComplete: boolean;
  readonly costHistoryComplete: boolean;
  lastTurnUsage: Usage = emptyUsage();
  lastTurnCost: CostSummary = emptyCostSummary();
  requestCount = 0;
  /** Immutable with its provider client; model switches rebuild the Agent atomically. */
  readonly model: string;
  /** context tokens consumed by the most recent request (from real usage, not estimates) */
  private lastContextTokens = 0;
  /** estimate for the same request as lastContextTokens, used to project newly appended content */
  private lastEstimatedRequestTokens = 0;
  private _session?: Session;
  private cwd: string;
  private readonly toolPolicy: ToolExecutionPolicy;
  private readonly toolsByName: Map<string, Tool>;
  private running = false;
  /** Set when a turn stops at an approval gate; retains results already produced. */
  private suspendedBatch?: SuspendedBatch;
  private activeTelemetryContext?: TelemetryContext;
  private activeRunSignal?: AbortSignal;
  private observerDisabled = false;

  get session(): Session | undefined {
    return this._session;
  }

  constructor(private readonly options: AgentOptions) {
    this.messages = options.session ? [...options.session.messages] : [];
    if (options.session) {
      const history = usageAcrossSessionLineageDetailed(options.session);
      addUsage(this.usageTotal, history.usage);
      this.usageHistoryComplete = history.complete;
      const costHistory = costAcrossSessionLineageDetailed(options.session);
      Object.assign(this.costTotal, costHistory.cost);
      this.costHistoryComplete = costHistory.complete;
    } else {
      this.usageHistoryComplete = true;
      this.costHistoryComplete = true;
    }
    if (options.pricing && options.pricing.model !== options.model) {
      throw new Error(`pricing model ${options.pricing.model} does not match agent model ${options.model}`);
    }
    if (options.pricing) validateModelPrice(options.pricing);
    this.model = options.model;
    if (options.session) this._session = options.session;
    this.cwd = options.cwd;
    this.toolPolicy = { ...defaultToolExecutionPolicy(options.cwd), ...options.toolPolicy };
    this.toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
    // Resolve the write-ahead journal before repairing the provider transcript:
    // planned calls are known not to have run; started calls have unknown outcome.
    let recoveredExecutions: readonly ToolExecutionState[] = [];
    if (this._session) {
      try {
        this._session.markInterruptedModelRequestsOutcomeUnknown();
        this._session.markInterruptedCompactionsFailed();
        // A batch that stopped at an approval gate is not an interrupted batch:
        // its unstarted calls are waiting for a decision, not lost. Crash repair
        // must leave them for the resume flow (ADR 0011 decision 4).
        const suspended = this._session.suspendedToolExecutions;
        this.suspendedAtOpen = suspended.length > 0;
        const suspendedRequests = new Set(suspended.map((state) => state.requestId));
        for (const pending of this._session.pendingToolExecutions) {
          if (pending.status !== 'planned') continue;
          if (pending.approval || suspendedRequests.has(pending.requestId)) continue;
          this._session.skipTool(pending.executionId, 'prior process ended before tool execution started');
        }
        // A started call still has an unknown outcome whether or not the batch
        // later suspended — 0007 is unchanged by approvals.
        this._session.markInterruptedToolsOutcomeUnknown();
        const priorStatus = this._session.runStatus?.status;
        if (priorStatus === 'running' || (priorStatus === 'suspended' && !this.suspendedAtOpen)) {
          this._session.setRunStatus(
            this.suspendedAtOpen ? 'suspended' : 'incomplete',
            this.suspendedAtOpen
              ? 'prior process stopped while tool approvals were pending'
              : 'prior process stopped before recording a terminal run status',
          );
        }
        recoveredExecutions = this._session.toolExecutions;
      } catch (error) {
        this.persistDisabled = true;
        process.stderr.write(`warning: session lifecycle recovery disabled logging — ${String(error)}\n`);
      }
    }
    // A session that ended after an assistant tool call still needs synthetic
    // result blocks for provider validity, but never claims an uncertain call did not run.
    // Pending approvals are the exception: those calls get real results once the
    // decisions are applied, so the transcript stays open until then.
    const repair = this.suspendedAtOpen ? undefined : synthesizeInterruptedResults(this.messages, recoveredExecutions);
    if (repair) {
      this.messages.push(repair);
      this.persist(repair);
    }
  }

  /** True when this agent opened a session whose last batch stopped at an approval gate. */
  private suspendedAtOpen = false;

  get workingDirectory(): string {
    return this.cwd;
  }

  private persistDisabled = false;

  private journalFor<T>(session: Session | undefined, operation: (session: Session) => T): T | undefined {
    if (!session || this.persistDisabled) return undefined;
    try {
      return operation(session);
    } catch (error) {
      this.persistDisabled = true;
      process.stderr.write(`warning: session logging disabled — ${String(error)}\n`);
      return undefined;
    }
  }

  private journal<T>(operation: (session: Session) => T): T | undefined {
    return this.journalFor(this._session, operation);
  }

  /** Persistence failure (disk full, dir deleted) must never corrupt the live conversation. */
  private persistEntry(entry: Parameters<Session['append']>[0]): boolean {
    if (!this._session) return true;
    return (
      this.journal((session) => {
        session.append(entry);
        return true;
      }) === true
    );
  }

  private persist(message: Message): boolean {
    return this.persistEntry({ t: 'msg', message });
  }

  private toolContext(signal?: AbortSignal, telemetry?: TelemetryContext): ToolContext {
    const agent = this;
    return {
      get cwd() {
        return agent.cwd;
      },
      setCwd(dir: string) {
        agent.cwd = dir;
      },
      policy: agent.toolPolicy,
      ...(signal ? { signal } : {}),
      // Omitted rather than no-op'd when telemetry is off, so a tool can skip
      // assembling an observation it has nowhere to send.
      ...(telemetry && this.options.observer
        ? { observePolicy: (observation: ToolPolicyObservation) => agent.observeToolPolicy(telemetry, observation) }
        : {}),
    };
  }

  private async executeCall(
    call: ToolCallBlock,
    signal?: AbortSignal,
    telemetry?: TelemetryContext,
  ): Promise<ToolCallExecution> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return { result: { content: [{ type: 'text', text: `unknown tool "${call.name}"` }], isError: true } };
    }
    if (signal?.aborted) {
      return {
        result: { content: [{ type: 'text', text: 'not run: canceled before tool dispatch' }], isError: true },
      };
    }

    let execution: Promise<ToolOutput>;
    try {
      execution = Promise.resolve(tool.execute(call.arguments, this.toolContext(signal, telemetry)));
    } catch (error) {
      return { result: { content: [{ type: 'text', text: String(error) }], isError: true } };
    }
    if (!signal) {
      try {
        return { result: await execution };
      } catch (error) {
        return { result: { content: [{ type: 'text', text: String(error) }], isError: true } };
      }
    }

    const interrupted = Symbol('tool-interrupted');
    let onAbort: (() => void) | undefined;
    const abort = new Promise<typeof interrupted>((resolveAbort) => {
      onAbort = () => resolveAbort(interrupted);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const settled = await Promise.race([
        execution.then(
          (result) => ({ result }),
          (error: unknown) => ({ result: { content: [{ type: 'text' as const, text: String(error) }], isError: true } }),
        ),
        abort,
      ]);
      if (settled === interrupted) {
        return {
          result: {
            content: [
              {
                type: 'text',
                text: 'tool execution was interrupted before a terminal result; its side-effect outcome is unknown',
              },
            ],
            isError: true,
          },
          outcomeUnknown: true,
        };
      }
      return settled;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private journalSkippedTools(calls: ToolCallBlock[], reason: string, requestId?: string): void {
    for (const call of calls) {
      this.journal((session) => {
        const executionId = session.planTool(call, requestId ? { requestId } : {});
        session.skipTool(executionId, reason);
      });
    }
  }

  /** Undecided gated calls, in batch order, for a surface that will collect decisions. */
  get pendingApprovals(): PendingApproval[] {
    if (this.suspendedBatch) {
      return this.suspendedBatch.calls
        .filter((item) => item.approval !== undefined && item.approval.decision === undefined)
        .map((item) => ({ executionId: item.executionId, call: structuredClone(item.call) }));
    }
    return (this._session?.awaitingApprovalExecutions ?? []).map((state) => ({
      executionId: state.executionId,
      call: structuredClone(state.call),
    }));
  }

  /** True when the loaded session (or the last turn) stopped at an approval gate. */
  get suspended(): boolean {
    return this.suspendedBatch !== undefined || this.suspendedAtOpen;
  }

  /**
   * The batch a suspended turn stopped inside. Same-process suspension keeps the
   * results of the calls that already ran; a reopened session can only reconstruct
   * them from the journal, which records that they ran but not what they returned.
   */
  private pendingBatch(): SuspendedBatch {
    if (this.suspendedBatch) return this.suspendedBatch;
    const session = this._session;
    const last = this.messages[this.messages.length - 1];
    const calls =
      last?.role === 'assistant'
        ? last.content.filter((block): block is ToolCallBlock => block.type === 'toolCall')
        : [];
    if (!session || calls.length === 0 || session.suspendedToolExecutions.length === 0) {
      throw new Error('no suspended tool batch to resume');
    }
    const byCallId = new Map(session.toolExecutions.map((state) => [state.call.id, state]));
    const items = calls.map((call): BatchCall => {
      const state = byCallId.get(call.id);
      if (!state) {
        return {
          call,
          executionId: `unrecorded-${call.id}`,
          journaled: false,
          settled: toolResultBlock(
            call,
            'interrupted: this tool call has no lifecycle record; its outcome is unknown and it must not be repeated without reconciliation',
            true,
          ),
        };
      }
      const item: BatchCall = {
        call: state.call,
        executionId: state.executionId,
        journaled: true,
        ...(state.approval ? { approval: state.approval } : {}),
      };
      if (state.status !== 'planned' && state.status !== 'awaiting_approval') {
        item.settled = toolResultBlock(state.call, interruptedResultText(state), true);
      }
      return item;
    });
    const requestId = items.map((item) => byCallId.get(item.call.id)?.requestId).find((id) => id !== undefined);
    return { ...(requestId ? { requestId } : {}), calls: items };
  }

  /** Validate every decision before any of them is journaled: a bad edit must change nothing. */
  private prepareDecisions(
    batch: SuspendedBatch,
    decisions: readonly ApprovalDecisionInput[],
  ): ApprovalDecisionInput[] {
    const byExecutionId = new Map(batch.calls.map((item) => [item.executionId, item]));
    const seen = new Set<string>();
    for (const decision of decisions) {
      const item = byExecutionId.get(decision.executionId);
      if (!item?.approval || item.approval.decision !== undefined) {
        throw new Error(`no undecided approval for execution ${decision.executionId}`);
      }
      if (seen.has(decision.executionId)) throw new Error(`duplicate decision for execution ${decision.executionId}`);
      seen.add(decision.executionId);
      if (decision.decision === 'edited') {
        const edited = decision.editedArguments;
        if (edited === undefined || typeof edited !== 'object' || Array.isArray(edited)) {
          throw new Error(`an edited decision for execution ${decision.executionId} requires replacement arguments`);
        }
        const tool = this.toolsByName.get(item.call.name);
        if (!tool) throw new Error(`cannot edit arguments for unknown tool "${item.call.name}"`);
        validateToolArguments(tool, edited);
      } else if (decision.editedArguments !== undefined) {
        throw new Error('editedArguments is only valid for an edited decision');
      }
    }
    return [...decisions];
  }

  /**
   * Apply human decisions to a suspended batch and continue the turn: approved
   * calls dispatch, edited calls dispatch with the replacement arguments and
   * visible provenance, rejected calls become an error result carrying the human
   * reason. Undecided gated calls suspend the turn again, in batch order.
   */
  async *resume(
    decisions: readonly ApprovalDecisionInput[] = [],
    signal?: AbortSignal,
    steering?: () => string[],
  ): AsyncGenerator<AgentEvent, void, void> {
    if (this.running) throw new Error('agent is already running');
    const batch = this.pendingBatch();
    const prepared = this.prepareDecisions(batch, decisions);
    yield* this.turn({ kind: 'resume', batch, decisions: prepared }, signal, steering);
  }

  private async runObserverOperation(action: () => void | Promise<void>): Promise<void> {
    if (this.observerDisabled) return;
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(action());
    } catch {
      // Observability is deliberately fail-open; SafeObserver also isolates sink failures.
      return;
    }
    const timedOut = Symbol('observer-timeout');
    const aborted = Symbol('observer-aborted');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), this.options.observerOperationTimeoutMs ?? OBSERVER_OPERATION_TIMEOUT_MS);
    });
    const signal = this.activeRunSignal;
    const interrupted = new Promise<typeof aborted>((resolve) => {
      if (!signal) return;
      onAbort = () => resolve(aborted);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const outcome = await Promise.race([
      pending.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
      interrupted,
    ]);
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (outcome === timedOut) {
      // Disabled while wedged, not forever: a timeout under a starved event loop
      // is not a wedged sink. The slow operation itself was not lost (its promise
      // continues); if it ever settles, later events may flow again. A genuinely
      // hung sink never settles and stays disabled.
      this.observerDisabled = true;
      void pending.then(
        () => {
          this.observerDisabled = false;
        },
        () => {
          this.observerDisabled = false; // sink failures are SafeObserver's job; settled != wedged
        },
      );
    }
  }

  private async observe(event: RuntimeTelemetryEvent): Promise<void> {
    const observer = this.options.observer;
    if (!observer) return;
    await this.runObserverOperation(() => observer.emit(event));
  }

  private async flushObserver(): Promise<void> {
    const observer = this.options.observer;
    if (!observer) return;
    await this.runObserverOperation(() => observer.flush());
  }

  private async observeBudget(context: TelemetryContext, reason: string): Promise<void> {
    await this.observe(
      createRuntimeEvent(context, { name: 'budget.exceeded', level: 'warn', attributes: { reason } }),
    );
  }

  /**
   * Records that the request about to be dispatched will carry an auth credential.
   * Both guards precede event construction so a disabled observer costs nothing,
   * and only the descriptor's names are read — the key is not in scope here.
   */
  private async observeCredentialAttach(context: TelemetryContext): Promise<void> {
    const credential = this.options.credential;
    if (!credential || !this.options.observer) return;
    await this.observe(
      createRuntimeEvent(context, {
        name: 'credential.attach',
        attributes: {
          provider: credential.provider,
          profile: credential.profile,
          source: credential.source,
        },
      }),
    );
  }

  private async observeToolPolicy(
    context: TelemetryContext,
    observation: ToolPolicyObservation,
  ): Promise<void> {
    await this.observe(
      createRuntimeEvent(context, {
        name: 'policy.env_sanitized',
        attributes: {
          strippedCount: observation.strippedCount,
          strippedNames: observation.strippedNames,
          allowlist: observation.allowlist,
          allowlistSource: observation.allowlistSource,
        },
      }),
    );
  }

  private toolDefinitions(): CompletionRequest['tools'] {
    return this.options.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** Conservative estimate of the complete fixed + dynamic request sent on the next model call. */
  private estimateCurrentRequestTokens(messages = this.messages): number {
    return estimateTokens(
      JSON.stringify({
        system: this.options.systemPrompt,
        tools: this.toolDefinitions(),
        messages,
      }),
    );
  }

  /**
   * Project the next request from the last provider-reported context plus the
   * estimated growth since that request. This preserves real tokenizer evidence
   * while still catching a newly appended huge user message or tool result.
   */
  private projectedContextTokens(): number {
    const currentEstimate = this.estimateCurrentRequestTokens();
    if (this.lastContextTokens <= 0 || this.lastEstimatedRequestTokens <= 0) return currentEstimate;
    const growth = Math.max(0, currentEstimate - this.lastEstimatedRequestTokens);
    return Math.max(currentEstimate, this.lastContextTokens + growth);
  }

  /**
   * Processes one user input to completion: stream -> execute tool calls -> repeat
   * until the model stops calling tools (or maxIterations model calls, or the flail
   * guard ends a turn that is failing without progress). `steering` is drained
   * between model calls so the user can correct course mid-turn.
   */
  async *run(
    input: string,
    signal?: AbortSignal,
    steering?: () => string[],
  ): AsyncGenerator<AgentEvent, void, void> {
    if (this.running) throw new Error('agent is already running');
    // The transcript ends at an assistant tool_use whose results are still
    // pending: new input here would ask the provider to accept a gap, and would
    // strand a durable decision nobody is waiting on.
    if (this.suspended) {
      throw new Error('tool approvals are pending; apply decisions with resume() before sending new input');
    }
    const inputBytes = Buffer.byteLength(input);
    if (inputBytes > MAX_USER_INPUT_BYTES) {
      throw new RangeError(`user input exceeds ${MAX_USER_INPUT_BYTES} UTF-8 bytes`);
    }
    yield* this.turn({ kind: 'input', input }, signal, steering);
  }

  private async *turn(
    start: TurnStart,
    signal?: AbortSignal,
    steering?: () => string[],
  ): AsyncGenerator<AgentEvent, void, void> {
    if (this.running) throw new Error('agent is already running');
    if (
      this.options.contextWindow !== undefined &&
      (!Number.isSafeInteger(this.options.contextWindow) || this.options.contextWindow <= 0)
    ) {
      throw new RangeError('contextWindow must be a safe integer > 0');
    }
    if (
      this.options.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.options.requestTimeoutMs) ||
        this.options.requestTimeoutMs <= 0 ||
        this.options.requestTimeoutMs > MAX_TIMER_MS)
    ) {
      throw new RangeError(`requestTimeoutMs must be a safe integer in 1..${MAX_TIMER_MS}`);
    }
    if (
      this.options.thinkingBudget !== undefined &&
      (!Number.isSafeInteger(this.options.thinkingBudget) ||
        this.options.thinkingBudget < 0 ||
        this.options.thinkingBudget > Number.MAX_SAFE_INTEGER - THINKING_RESPONSE_RESERVE_TOKENS)
    ) {
      throw new RangeError('thinkingBudget must be a safe nonnegative integer');
    }
    this.running = true;

    // A resumed turn continues the suspended run's accounting and ceilings, so a
    // suspension cannot be used to buy a second full budget (ADR 0011 decision 5).
    const openRun = start.kind === 'resume' ? this._session?.openRun : undefined;
    const budget: RunBudget = {
      maxModelRequests: this.options.maxIterations ?? 40,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      maxWallTimeMs: DEFAULT_MAX_WALL_TIME_MS,
      maxToolOutputBytes: Math.min(
        50_000,
        Math.max(1_024, Math.floor((this.options.contextWindow ?? 128_000) * 0.4)),
      ),
    };
    for (const [name, value] of Object.entries(openRun?.budget ?? {})) {
      if (value !== undefined) (budget as unknown as Record<string, number>)[name] = value;
    }
    // Optional config objects are commonly assembled with spreads that retain
    // `undefined` values. Never let those erase mandatory safety defaults.
    const raised: string[] = [];
    for (const [name, value] of Object.entries(this.options.budget ?? {})) {
      if (value === undefined) continue;
      const prior = (openRun?.budget as Record<string, number | undefined> | undefined)?.[name];
      // Only an explicitly passed ceiling may exceed the suspended run's; the
      // raise is journaled rather than applied silently.
      if (prior !== undefined && value > prior) raised.push(`${name} ${prior}->${value}`);
      (budget as unknown as Record<string, number>)[name] = value;
    }
    for (const [name, value] of Object.entries(budget)) {
      if (name === 'maxSpendUSD') {
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
          this.running = false;
          throw new Error('invalid run budget maxSpendUSD: expected a finite number > 0');
        }
        continue;
      }
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        this.running = false;
        throw new Error(`invalid run budget ${name}: expected a safe integer > 0`);
      }
    }
    if (budget.maxWallTimeMs > MAX_TIMER_MS) {
      this.running = false;
      throw new Error(`invalid run budget maxWallTimeMs: maximum supported value is ${MAX_TIMER_MS}`);
    }
    if (budget.maxToolOutputBytes < MIN_TOOL_OUTPUT_BYTES) {
      this.running = false;
      throw new Error(
        `invalid run budget maxToolOutputBytes: minimum supported value is ${MIN_TOOL_OUTPUT_BYTES}`,
      );
    }
    if (budget.maxSpendUSD !== undefined && !this.options.pricing) {
      this.running = false;
      throw new Error(
        `maxSpendUSD requires an exact price for model ${this.model}; provide a pricing table containing that model`,
      );
    }
    if (budget.maxSpendUSD !== undefined && openRun && !costComplete(openRun.cost)) {
      this.running = false;
      throw new Error('cannot resume a spend-capped run whose prior request cost is unpriced or outcome-unknown');
    }

    const runController = new AbortController();
    this.activeRunSignal = runController.signal;
    let deadlineExceeded = false;
    const forwardAbort = () => runController.abort(signal?.reason ?? new Error('aborted'));
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const deadline = setTimeout(() => {
      deadlineExceeded = true;
      runController.abort(new Error(`run exceeded ${budget.maxWallTimeMs}ms wall-time budget`));
    }, budget.maxWallTimeMs);

    const turnUsage = emptyUsage();
    if (openRun) addUsage(turnUsage, openRun.usage);
    const turnCost = emptyCostSummary();
    if (openRun) addCostSummary(turnCost, openRun.cost);
    let iterations = openRun?.modelRequests ?? 0;
    let toolCalls = openRun?.toolCalls ?? 0;
    let status: TurnStatus = 'incomplete';
    let reason: TurnStopReason = 'empty_response';
    let failed = false;
    let failedError: unknown;
    let runBodyCompleted = false;
    let terminal = false;
    const runSessions: Session[] = this._session ? [this._session] : [];
    const runTelemetryContext = createTelemetryContext(this._session?.id, {
      ...(this.options.parentRunId ? { parentRunId: this.options.parentRunId } : {}),
    });
    let telemetryContext = runTelemetryContext;
    this.activeTelemetryContext = telemetryContext;
    const runSpan = createSpanStarted(telemetryContext, {
      name: 'agent.run',
      attributes: { model: this.model },
    });
    const runStartedAt = Date.now();
    await this.observe(runSpan);

    try {
      if (this._session) {
        try {
          if (statSync(this._session.file).size >= SESSION_ROTATE_BYTES) {
            await this.rotateSessionForStorage();
            telemetryContext = this.activeTelemetryContext ?? telemetryContext;
            if (this._session && !runSessions.some((session) => session.id === this._session!.id)) {
              runSessions.push(this._session);
              yield { type: 'session_rotated', sessionFile: this._session.file };
            }
          }
        } catch (error) {
          process.stderr.write(`warning: session rotation failed — ${String(error)}\n`);
          status = 'incomplete';
          reason = 'persistence';
          terminal = true;
        }
      }
      const raiseNote = raised.length > 0 ? `budget raised at resume: ${raised.join(', ')}` : undefined;
      for (const session of runSessions) {
        if (session.runStatus?.status !== 'running' || raiseNote) {
          this.journalFor(session, (target) => target.setRunStatus('running', raiseNote));
        }
      }

      const guardOption = this.options.flailGuard;
      const guard =
        guardOption === false
          ? undefined
          : {
              nudgeAfter: 5,
              stopAfter: 10,
              repeatNudgeAfter: 2,
              repeatStopAfter: 4,
              ...(typeof guardOption === 'object' ? guardOption : {}),
            };
      let consecutiveFailures = 0;
      const failCounts = new Map<string, number>();
      let nudged = false;
      let stopping = false;
      // A resume re-enters the loop at the suspended batch: no new user input,
      // and no model request until the batch has been settled in order.
      let resumeBatch = start.kind === 'resume' ? start.batch : undefined;
      const resumeDecisions = start.kind === 'resume' ? start.decisions : [];
      if (start.kind === 'input') {
        const userMessage: Message = { role: 'user', content: [{ type: 'text', text: start.input }] };
        const inputThreshold = this.compactThreshold();
        const inputOnlyProjection = this.estimateCurrentRequestTokens([userMessage]);
        if (!terminal && inputThreshold !== undefined && inputOnlyProjection > inputThreshold) {
          status = 'incomplete';
          reason = 'context_window';
          terminal = true;
          await this.observe(
            createRuntimeEvent(telemetryContext, {
              name: 'context.preflight_failed',
              level: 'warn',
              attributes: { projectedTokens: inputOnlyProjection, threshold: inputThreshold, currentTurnOnly: true },
            }),
          );
        } else if (!terminal) {
          this.messages.push(userMessage);
          if (!this.persist(userMessage)) {
            status = 'incomplete';
            reason = 'persistence';
            terminal = true;
          }
        }
      }

      while (!terminal) {
        let batchCalls: BatchCall[];
        let batchRequestId: string | undefined;
        if (resumeBatch) {
          // Apply the recorded decisions, then settle the batch in its original
          // order. Nothing new is requested from the model until it is settled.
          batchCalls = resumeBatch.calls;
          batchRequestId = resumeBatch.requestId;
          resumeBatch = undefined;
          const decisionsById = new Map(resumeDecisions.map((decision) => [decision.executionId, decision]));
          let decisionsPersisted = true;
          for (const item of batchCalls) {
            const decision = decisionsById.get(item.executionId);
            if (!decision || !item.approval) continue;
            const written = this.journalFor(this._session, (session) => {
              session.decideToolApproval(item.executionId, decision.decision, {
                ...(decision.decidedAt ? { decidedAt: decision.decidedAt } : {}),
                ...(decision.editedArguments !== undefined ? { editedArguments: decision.editedArguments } : {}),
                ...(decision.reason ? { reason: decision.reason } : {}),
              });
              return true;
            });
            if (this._session && written !== true) {
              decisionsPersisted = false;
              break;
            }
            item.approval = {
              ...item.approval,
              decision: decision.decision,
              decidedAt: decision.decidedAt ?? new Date().toISOString(),
              ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
              ...(decision.editedArguments !== undefined ? { editedArguments: decision.editedArguments } : {}),
            };
            yield {
              type: 'approval_decided',
              executionId: item.executionId,
              call: item.call,
              decision: decision.decision,
              ...(decision.reason ? { reason: decision.reason } : {}),
            };
          }
          if (!decisionsPersisted) {
            status = 'incomplete';
            reason = 'persistence';
            break;
          }
        } else {
          if (runController.signal.aborted) {
            status = deadlineExceeded ? 'budget_exceeded' : 'canceled';
            reason = deadlineExceeded ? 'wall_time' : 'user_abort';
            if (deadlineExceeded) {
              await this.observeBudget(telemetryContext, 'wall_time');
              yield { type: 'budget_exceeded', reason: 'wall_time' };
            }
            break;
          }

          for (const note of steering?.() ?? []) {
            if (Buffer.byteLength(note) > MAX_USER_INPUT_BYTES) {
              throw new RangeError(`steering input exceeds ${MAX_USER_INPUT_BYTES} UTF-8 bytes`);
            }
            const steerMessage: Message = { role: 'user', content: [{ type: 'text', text: `[steering] ${note}` }] };
            this.messages.push(steerMessage);
            if (!this.persist(steerMessage)) {
              status = 'incomplete';
              reason = 'persistence';
              terminal = true;
              break;
            }
            yield { type: 'steered', text: note };
          }
          if (terminal) break;

          const offloaded = this.offloadOldToolResults();
          if (offloaded) {
            // The provider-based projection describes the pre-offload request. Once
            // history shrinks, rebase to the serialized request instead of pinning
            // context pressure to a stale high-water mark.
            this.lastContextTokens = 0;
            this.lastEstimatedRequestTokens = 0;
            await this.observe(
              createRuntimeEvent(telemetryContext, {
                name: 'context.offloaded',
                attributes: { count: offloaded.count, savedChars: offloaded.savedChars },
              }),
            );
            yield { type: 'offloaded', ...offloaded };
          }

          if (this._session) {
            let rotateForStorage = false;
            try {
              rotateForStorage = statSync(this._session.file).size >= SESSION_ROTATE_BYTES;
            } catch (error) {
              this.persistDisabled = true;
              process.stderr.write(`warning: cannot inspect session for rotation — ${String(error)}\n`);
              status = 'incomplete';
              reason = 'persistence';
              break;
            }
            if (rotateForStorage) {
              try {
                await this.rotateSessionForStorage();
              } catch (error) {
                process.stderr.write(`warning: session rotation failed — ${String(error)}\n`);
                status = 'incomplete';
                reason = 'persistence';
                break;
              }
              telemetryContext = this.activeTelemetryContext ?? telemetryContext;
              if (this._session && !runSessions.some((session) => session.id === this._session!.id)) {
                runSessions.push(this._session);
                yield { type: 'session_rotated', sessionFile: this._session.file };
              }
            }
          }

          const threshold = this.compactThreshold();
          if (threshold !== undefined && this.projectedContextTokens() > threshold) {
            if (this.options.autoCompact === false) {
              status = 'incomplete';
              reason = 'context_window';
              await this.observe(
                createRuntimeEvent(telemetryContext, {
                  name: 'context.preflight_failed',
                  level: 'warn',
                  attributes: { projectedTokens: this.projectedContextTokens(), threshold, autoCompact: false },
                }),
              );
              break;
            }
            const keepFrom = chooseKeepBoundary(this.messages, this.compactionKeepTokens());
            const retainedProjection =
              keepFrom < this.messages.length
                ? this.estimateCurrentRequestTokens(this.messages.slice(keepFrom))
                : Number.POSITIVE_INFINITY;
            if (
              this.messages.length <= 1 ||
              keepFrom <= 0 ||
              retainedProjection + COMPACTION_SUMMARY_INPUT_RESERVE_TOKENS > threshold
            ) {
              status = 'incomplete';
              reason = 'context_window';
              await this.observe(
                createRuntimeEvent(telemetryContext, {
                  name: 'context.preflight_failed',
                  level: 'warn',
                  attributes: {
                    projectedTokens: this.projectedContextTokens(),
                    retainedTokens: retainedProjection,
                    threshold,
                  },
                }),
              );
              break;
            }
            // A compaction request without room for the real request is not useful.
            if (iterations + 1 >= budget.maxModelRequests) {
              status = 'budget_exceeded';
              reason = 'model_requests';
              await this.observeBudget(telemetryContext, 'model_requests');
              yield { type: 'budget_exceeded', reason: 'model_requests' };
              break;
            }
            let dropped: number;
            try {
              dropped = await this.compact(runController.signal, turnUsage, turnCost, budget, () => iterations++);
            } catch (error) {
              if (error instanceof SpendBudgetExceededError) {
                status = 'budget_exceeded';
                reason = 'spend';
                await this.observeBudget(telemetryContext, 'spend');
                yield { type: 'budget_exceeded', reason: 'spend' };
                break;
              }
              if (!runController.signal.aborted && error instanceof CompactionPersistenceError) {
                status = 'incomplete';
                reason = 'persistence';
                break;
              }
              if (!runController.signal.aborted) throw error;
              status = deadlineExceeded ? 'budget_exceeded' : 'canceled';
              reason = deadlineExceeded ? 'wall_time' : 'user_abort';
              if (deadlineExceeded) {
                await this.observeBudget(telemetryContext, 'wall_time');
                yield { type: 'budget_exceeded', reason: 'wall_time' };
              }
              break;
            }
            telemetryContext = this.activeTelemetryContext ?? telemetryContext;
            if (this._session && !runSessions.some((session) => session.id === this._session!.id)) {
              runSessions.push(this._session);
            }
            yield { type: 'compacted', dropped, ...(this._session ? { sessionFile: this._session.file } : {}) };
            if (runController.signal.aborted) {
              status = deadlineExceeded ? 'budget_exceeded' : 'canceled';
              reason = deadlineExceeded ? 'wall_time' : 'user_abort';
              if (deadlineExceeded) {
                await this.observeBudget(telemetryContext, 'wall_time');
                yield { type: 'budget_exceeded', reason: 'wall_time' };
              }
              break;
            }
            // The retained current turn can itself be too large. Never pay for a
            // request that preflight already knows lacks the configured reserve.
            const rebuiltProjection = this.projectedContextTokens();
            if (rebuiltProjection > threshold) {
              status = 'incomplete';
              reason = 'context_window';
              await this.observe(
                createRuntimeEvent(telemetryContext, {
                  name: 'context.preflight_failed',
                  level: 'warn',
                  attributes: { projectedTokens: rebuiltProjection, threshold, afterCompaction: true },
                }),
              );
              break;
            }
          }

          const priorUsageLimit = usageBudgetReason(turnUsage, budget);
          if (priorUsageLimit) {
            status = 'budget_exceeded';
            reason = priorUsageLimit;
            await this.observeBudget(telemetryContext, priorUsageLimit);
            yield {
              type: 'budget_exceeded',
              reason: priorUsageLimit as 'input_tokens' | 'output_tokens' | 'total_tokens',
            };
            break;
          }
          if (iterations >= budget.maxModelRequests) {
            status = 'budget_exceeded';
            reason = 'model_requests';
            await this.observeBudget(telemetryContext, 'model_requests');
            yield { type: 'budget_exceeded', reason: 'model_requests' };
            break;
          }

          const requestEstimate = this.estimateCurrentRequestTokens();
          const outputLimits = [
            Math.max(
              DEFAULT_REQUEST_MAX_TOKENS,
              this.options.thinkingBudget !== undefined
                ? this.options.thinkingBudget + THINKING_RESPONSE_RESERVE_TOKENS
                : 0,
            ),
          ];
          if (budget.maxOutputTokens !== undefined) {
            outputLimits.push(Math.max(1, budget.maxOutputTokens - turnUsage.outputTokens));
          }
          if (budget.maxTotalTokens !== undefined) {
            outputLimits.push(Math.max(1, budget.maxTotalTokens - totalTokens(turnUsage)));
          }
          if (this.options.contextWindow !== undefined) {
            outputLimits.push(
              Math.max(1, this.options.contextWindow - Math.ceil(this.projectedContextTokens())),
            );
          }
          const requestMaxTokens = Math.min(...outputLimits);
          const requestThinkingBudget =
            this.options.thinkingBudget !== undefined && this.options.thinkingBudget < requestMaxTokens
              ? this.options.thinkingBudget
              : undefined;
          const completionRequest: CompletionRequest = {
            model: this.model,
            system: this.options.systemPrompt,
            messages: this.messages,
            tools: this.toolDefinitions(),
            // RunBudget counts actual provider attempts. Retries are modeled as
            // separate harness decisions rather than hidden inside one request.
            maxAttempts: 1,
            timeoutMs: Math.min(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, budget.maxWallTimeMs),
            maxTokens: requestMaxTokens,
            ...(requestThinkingBudget !== undefined ? { thinkingBudget: requestThinkingBudget } : {}),
          };
          const spendReservation =
            budget.maxSpendUSD !== undefined
              ? reserveRequestSpend(completionRequest, this.options.pricing!)
              : undefined;
          if (
            budget.maxSpendUSD !== undefined &&
            spendExposure(turnCost) + (spendReservation?.usd ?? 0) > budget.maxSpendUSD
          ) {
            status = 'budget_exceeded';
            reason = 'spend';
            await this.observeBudget(telemetryContext, 'spend');
            yield { type: 'budget_exceeded', reason: 'spend' };
            break;
          }
          let done: { message: AssistantMessage; stopReason: StopReason; usage: Usage } | undefined;
          const requestId = createTelemetryId('request');
          const requestJournaled =
            !this._session ||
            this.journal((session) => {
              session.beginModelRequest(this.model, {
                requestId,
                messageCount: this.messages.length,
                ...(spendReservation ? { spendReservation } : {}),
              });
              return true;
            }) === true;
          if (!requestJournaled) {
            status = 'incomplete';
            reason = 'persistence';
            break;
          }
          iterations++;
          this.requestCount++;
          const requestContext: TelemetryContext = { ...telemetryContext, requestId };
          const requestSpan = createSpanStarted(requestContext, {
            name: 'model.request',
            parentSpanId: runSpan.spanId,
            attributes: { model: this.model, messageCount: this.messages.length },
          });
          const requestStartedAt = Date.now();
          await this.observe(requestSpan);
          await this.observeCredentialAttach(requestContext);
          const stream = this.options.client.stream(completionRequest, runController.signal);
          const streamIterator = stream[Symbol.asyncIterator]();
          let streamEnded = false;
          let requestLifecycleTerminal = false;
          let requestCostTerminal = false;
          const recordUnknownCost = () => {
            if (requestCostTerminal) return;
            addUnknownRequestCost(turnCost, spendReservation);
            addUnknownRequestCost(this.costTotal, spendReservation);
            requestCostTerminal = true;
          };
          try {
            while (true) {
              const next = await nextStreamEvent(streamIterator, runController.signal);
              if (next.done) {
                streamEnded = true;
                break;
              }
              const event = next.value;
              if (event.type === 'text_delta') yield { type: 'text', text: event.text };
              else if (event.type === 'thinking_delta') yield { type: 'thinking', text: event.text };
              else if (event.type === 'done') done = event;
            }
          } catch (error) {
            releaseStream(streamIterator);
            if (runController.signal.aborted) {
              this.journal((session) =>
                session.markModelRequestOutcomeUnknown(
                  requestId,
                  'request was canceled after dispatch before a terminal response was recorded',
                ),
              );
            } else {
              this.journal((session) => session.failModelRequest(requestId, String(error)));
            }
            requestLifecycleTerminal = true;
            recordUnknownCost();
            await this.observe(
              createSpanEnded(requestContext, {
                name: 'model.request',
                spanId: requestSpan.spanId,
                parentSpanId: runSpan.spanId,
                status: runController.signal.aborted ? 'canceled' : 'error',
                durationMs: Date.now() - requestStartedAt,
                error: {
                  type: error instanceof Error ? error.name : 'Error',
                  message: String(error),
                  ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
                },
              }),
            );
            if (runController.signal.aborted) {
              status = deadlineExceeded ? 'budget_exceeded' : 'canceled';
              reason = deadlineExceeded ? 'wall_time' : 'user_abort';
              if (deadlineExceeded) {
                await this.observeBudget(telemetryContext, 'wall_time');
                yield { type: 'budget_exceeded', reason: 'wall_time' };
              }
              break;
            }
            throw error;
          } finally {
            if (!streamEnded && !requestLifecycleTerminal) {
              if (!runController.signal.aborted) {
                runController.abort(new Error('agent run consumer stopped during provider streaming'));
              }
              releaseStream(streamIterator);
              this.journal((session) =>
                session.markModelRequestOutcomeUnknown(
                  requestId,
                  'request iteration stopped before the provider stream reached a terminal boundary',
                ),
              );
              recordUnknownCost();
            }
          }
          if (!done) {
            this.journal((session) => session.failModelRequest(requestId, 'provider stream produced no complete message'));
            recordUnknownCost();
            await this.observe(
              createSpanEnded(requestContext, {
                name: 'model.request',
                spanId: requestSpan.spanId,
                parentSpanId: runSpan.spanId,
                status: 'incomplete',
                durationMs: Date.now() - requestStartedAt,
              }),
            );
            status = 'incomplete';
            reason = 'empty_response';
            break;
          }
          const responseCalls = done.message.content.filter(
            (block): block is ToolCallBlock => block.type === 'toolCall',
          );
          const hasAnswerText = done.message.content.some(
            (block) => block.type === 'text' && block.text.trim().length > 0,
          );
          const requestCost = this.options.pricing ? costForUsage(done.usage, this.options.pricing) : undefined;
          const responseJournaled =
            !this._session ||
            this.journal((session) => {
              session.completeModelRequest(requestId, {
                stopReason: done!.stopReason,
                usage: done!.usage,
                ...(requestCost ? { cost: requestCost } : {}),
              });
              return true;
            }) === true;
          await this.observe(
            createSpanEnded(requestContext, {
              name: 'model.request',
              spanId: requestSpan.spanId,
              parentSpanId: runSpan.spanId,
              status:
                (done.stopReason === 'end_turn' && hasAnswerText) ||
                (done.stopReason === 'tool_use' && responseCalls.length > 0)
                  ? 'ok'
                  : 'incomplete',
              durationMs: Date.now() - requestStartedAt,
              attributes: {
                stopReason: done.stopReason,
                inputTokens: inputTokens(done.usage),
                outputTokens: done.usage.outputTokens,
              },
            }),
          );
          await this.observe(
            createRuntimeEvent(requestContext, {
              name: 'model.response',
              attributes: { stopReason: done.stopReason, outputTokens: done.usage.outputTokens },
            }),
          );

          addUsage(turnUsage, done.usage);
          addUsage(this.usageTotal, done.usage);
          addRequestCost(turnCost, requestCost);
          addRequestCost(this.costTotal, requestCost);
          requestCostTerminal = true;
          this.lastContextTokens = totalTokens(done.usage);
          if (!responseJournaled) {
            status = 'incomplete';
            reason = 'persistence';
            break;
          }
          if (done.message.content.length === 0) {
            this.lastEstimatedRequestTokens = requestEstimate;
            status = 'incomplete';
            reason = 'empty_response';
            break;
          }
          this.messages.push(done.message);
          const responsePersisted = this.persist(done.message);
          this.lastEstimatedRequestTokens = this.estimateCurrentRequestTokens();
          yield {
            type: 'response_done',
            message: done.message,
            stopReason: done.stopReason,
            usage: done.usage,
            ...(requestCost ? { cost: requestCost } : {}),
          };
          if (!responsePersisted) {
            status = 'incomplete';
            reason = 'persistence';
            break;
          }

          const calls = responseCalls;
          if (done.stopReason === 'max_tokens') {
            const explanation = 'not run: the model response was truncated at its token limit';
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'incomplete';
            reason = 'max_tokens';
            break;
          }
          if (done.stopReason === 'other') {
            const explanation = 'not run: the provider returned an unknown terminal status';
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'incomplete';
            reason = 'provider_stop';
            break;
          }
          if (budget.maxSpendUSD !== undefined && spendExposure(turnCost) > budget.maxSpendUSD) {
            const explanation = 'not run: the completed provider response exceeded the dollar spend ceiling';
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'budget_exceeded';
            reason = 'spend';
            await this.observeBudget(telemetryContext, 'spend');
            yield { type: 'budget_exceeded', reason: 'spend' };
            break;
          }
          const responseUsageExceeded = exceededUsageBudgetReason(turnUsage, budget);
          if (responseUsageExceeded) {
            const explanation = `not run: ${responseUsageExceeded} budget was exceeded by the completed response`;
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'budget_exceeded';
            reason = responseUsageExceeded;
            await this.observeBudget(telemetryContext, responseUsageExceeded);
            yield {
              type: 'budget_exceeded',
              reason: responseUsageExceeded as 'input_tokens' | 'output_tokens' | 'total_tokens',
            };
            break;
          }
          if (stopping) {
            const explanation = 'not run: the flail guard already stopped tool execution';
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'incomplete';
            reason = 'flail_stop';
            break;
          }
          if (calls.length === 0) {
            if (done.stopReason === 'end_turn' && hasAnswerText) {
              status = 'completed';
              reason = 'end_turn';
            } else {
              status = 'incomplete';
              reason = done.stopReason === 'tool_use' ? 'provider_stop' : 'empty_response';
            }
            break;
          }
          if (done.stopReason !== 'tool_use') {
            const explanation = 'not run: tool calls arrived without a tool-use finish reason';
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'incomplete';
            reason = 'provider_stop';
            break;
          }

          const responseUsageLimit = usageBudgetReason(turnUsage, budget);
          if (responseUsageLimit) {
            const explanation = `not run: ${responseUsageLimit} budget was exhausted`;
            this.journalSkippedTools(calls, explanation, requestId);
            const skipped = unexecutedToolResults(calls, explanation);
            if (skipped) {
              this.messages.push(skipped);
              this.persist(skipped);
            }
            status = 'budget_exceeded';
            reason = responseUsageLimit;
            await this.observeBudget(telemetryContext, responseUsageLimit);
            yield {
              type: 'budget_exceeded',
              reason: responseUsageLimit as 'input_tokens' | 'output_tokens' | 'total_tokens',
            };
            break;
          }
          const planned: BatchCall[] = [];
          for (const call of calls) {
            const executionId = createTelemetryId('tool');
            const journaled = this._session
              ? this.journal((session) => {
                  session.planTool(call, { executionId, requestId });
                  return true;
                }) === true
              : true;
            planned.push({ call, executionId, journaled });
            await this.observe(
              createRuntimeEvent({ ...telemetryContext, requestId, toolCallId: call.id, toolExecutionId: executionId }, {
                name: 'tool.planned',
                attributes: { toolName: call.name },
              }),
            );
          }
          batchCalls = planned;
          batchRequestId = requestId;
        }

        const results: ToolResultBlock[] = [];
        let repeatMax = 0;
        let toolBudgetHit = false;
        let guardStoppedThisBatch = false;
        let guardNudgedThisBatch = false;
        const evaluateFlail = (): 'stop' | 'nudge' | undefined => {
          if (!guard) return undefined;
          if (consecutiveFailures >= guard.stopAfter || repeatMax >= guard.repeatStopAfter) {
            stopping = true;
            return 'stop';
          }
          if (!nudged && (consecutiveFailures >= guard.nudgeAfter || repeatMax >= guard.repeatNudgeAfter)) {
            nudged = true;
            return 'nudge';
          }
          return undefined;
        };
        let suspendedThisBatch = false;
        for (let batchIndex = 0; batchIndex < batchCalls.length; batchIndex++) {
          const item = batchCalls[batchIndex]!;
          const { call, executionId, journaled } = item;
          // Produced before a suspension, or reconstructed from the journal on
          // resume. Never dispatch twice for one planned call.
          if (item.settled) {
            results.push(item.settled);
            continue;
          }
          if (guardStoppedThisBatch) {
            const explanation = 'not run: the flail guard stopped the remaining tool batch';
            if (journaled && this._session) {
              this.journal((session) => session.skipTool(executionId, explanation));
            }
            results.push({
              type: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: explanation }],
              isError: true,
            });
            continue;
          }
          if (toolCalls >= budget.maxToolCalls) {
            toolBudgetHit = true;
            if (journaled && this._session) {
              this.journal((session) => session.skipTool(executionId, 'per-turn tool-call budget exhausted'));
            }
            results.push({
              type: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: 'not run: per-turn tool-call budget exhausted' }],
              isError: true,
            });
            continue;
          }
          if (runController.signal.aborted) {
            if (journaled && this._session) {
              this.journal((session) => session.skipTool(executionId, 'run was canceled before execution'));
            }
            results.push({
              type: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: 'not run: canceled before execution' }],
              isError: true,
            });
            continue;
          }
          if (!journaled) {
            results.push({
              type: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: 'not run: durable lifecycle journal is unavailable' }],
              isError: true,
            });
            continue;
          }
          if (item.approval?.decision === 'rejected') {
            const explanation = `not run: a human reviewer rejected this tool call${item.approval.reason ? `: ${item.approval.reason}` : ''}`;
            await this.observe(
              createRuntimeEvent(
                { ...telemetryContext, ...(batchRequestId ? { requestId: batchRequestId } : {}), toolCallId: call.id, toolExecutionId: executionId },
                {
                  name: 'policy.decision',
                  level: 'warn',
                  attributes: { toolName: call.name, decision: 'deny', reason: 'approval_rejected' },
                },
              ),
            );
            results.push(toolResultBlock(call, explanation, true));
            continue;
          }
          const tool = this.toolsByName.get(call.name);
          // An edit replaces the arguments for dispatch only: the planned row
          // keeps the model's originals, and the decision row keeps the edit.
          const edited = item.approval?.decision === 'edited' ? item.approval.editedArguments : undefined;
          const effectiveArguments = edited ?? call.arguments;
          let rejectedBeforeDispatch: string | undefined;
          if (!tool) {
            rejectedBeforeDispatch = `unknown tool "${call.name}"`;
          } else {
            try {
              validateToolArguments(tool, effectiveArguments);
            } catch (error) {
              rejectedBeforeDispatch = error instanceof Error ? error.message : String(error);
            }
          }
          if (rejectedBeforeDispatch) {
            const explanation = `not run: ${rejectedBeforeDispatch}`;
            if (this._session) {
              this.journal((session) => session.skipTool(executionId, explanation));
            }
            await this.observe(
              createRuntimeEvent(
                {
                  ...telemetryContext,
                  ...(batchRequestId ? { requestId: batchRequestId } : {}),
                  toolCallId: call.id,
                  toolExecutionId: executionId,
                },
                {
                  name: 'policy.decision',
                  level: 'warn',
                  attributes: {
                    toolName: call.name,
                    decision: 'deny',
                    reason: tool ? 'invalid_arguments' : 'unknown_tool',
                  },
                },
              ),
            );
            results.push({
              type: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: explanation }],
              isError: true,
            });
            consecutiveFailures++;
            // Validation may reject non-JSON/circular input from an embedded
            // provider. Do not stringify that hostile value for flail tracking.
            const key = `${call.name}:rejected:${rejectedBeforeDispatch.slice(0, 256)}`;
            const repeats = (failCounts.get(key) ?? 0) + 1;
            failCounts.set(key, repeats);
            if (repeats > repeatMax) repeatMax = repeats;
            const decision = evaluateFlail();
            if (decision === 'stop') {
              guardStoppedThisBatch = true;
              yield { type: 'flail_stop', consecutiveFailures };
            } else if (decision === 'nudge') {
              guardNudgedThisBatch = true;
              yield { type: 'flail_nudge', consecutiveFailures };
            }
            continue;
          }
          // The batch runs in order until the first gated call with no recorded
          // decision. That call and every later gated one are journaled as
          // awaiting approval; later ungated calls stay planned, so side-effect
          // order is preserved exactly across the suspension (ADR 0011).
          if (item.approval?.decision === undefined && requiresApproval(this.toolPolicy, call.name)) {
            const pendingApprovals: PendingApproval[] = [];
            let approvalPersisted = true;
            for (const rest of batchCalls.slice(batchIndex)) {
              if (rest.settled || !rest.journaled) continue;
              if (rest.approval?.decision !== undefined) continue;
              if (!requiresApproval(this.toolPolicy, rest.call.name)) continue;
              if (!rest.approval) {
                const requestedAt = new Date().toISOString();
                const written = this.journalFor(this._session, (session) => {
                  session.requestToolApproval(rest.executionId);
                  return true;
                });
                if (this._session && written !== true) {
                  approvalPersisted = false;
                  break;
                }
                rest.approval = { requestedAt };
              }
              pendingApprovals.push({ executionId: rest.executionId, call: rest.call });
              await this.observe(
                createRuntimeEvent(
                  {
                    ...telemetryContext,
                    ...(batchRequestId ? { requestId: batchRequestId } : {}),
                    toolCallId: rest.call.id,
                    toolExecutionId: rest.executionId,
                  },
                  {
                    name: 'policy.decision',
                    level: 'warn',
                    attributes: { toolName: rest.call.name, decision: 'defer', reason: 'approval_required' },
                  },
                ),
              );
            }
            // An approval that cannot be durably recorded must not suspend: a
            // resume would never see it. Fail closed instead, leaving the
            // remaining calls unstarted.
            if (!approvalPersisted) {
              status = 'incomplete';
              reason = 'persistence';
              break;
            }
            suspendedThisBatch = true;
            yield { type: 'approval_required', executions: pendingApprovals };
            break;
          }
          if (this._session) {
            const started = this.journal((session) => {
              session.startTool(executionId);
              return true;
            });
            if (!started) {
              results.push({
                type: 'toolResult',
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: 'text', text: 'not run: tool start could not be durably recorded' }],
                isError: true,
              });
              continue;
            }
          }
          toolCalls++;
          const dispatchCall: ToolCallBlock = edited ? { ...call, arguments: edited } : call;
          const toolContext: TelemetryContext = {
            ...telemetryContext,
            ...(batchRequestId ? { requestId: batchRequestId } : {}),
            toolCallId: call.id,
            toolExecutionId: executionId,
          };
          const toolSpan = createSpanStarted(toolContext, {
            name: 'tool.execute',
            parentSpanId: runSpan.spanId,
            attributes: { toolName: call.name },
          });
          const toolStartedAt = Date.now();
          await this.observe(toolSpan);
          // Dispatch before yielding the public start event. If the consumer
          // returns from the async iterator at that yield, the durable `started`
          // row truthfully means a side effect may already be in flight.
          const executionPromise = this.executeCall(dispatchCall, runController.signal, toolContext);
          let resumedAfterToolStart = false;
          try {
            yield { type: 'tool_start', call: dispatchCall };
            resumedAfterToolStart = true;
          } finally {
            if (!resumedAfterToolStart) {
              if (!runController.signal.aborted) {
                runController.abort(new Error('agent run consumer stopped after tool dispatch'));
              }
              if (this._session) {
                this.journal((session) =>
                  session.markToolOutcomeUnknown(
                    executionId,
                    'run consumer stopped after dispatch but before the executor result was recorded',
                  ),
                );
              }
            }
          }
          const execution = await executionPromise;
          const result = boundToolOutput(execution.result, budget.maxToolOutputBytes);
          if (this._session) {
            this.journal((session) => {
              if (execution.outcomeUnknown) {
                session.markToolOutcomeUnknown(
                  executionId,
                  'cancellation occurred after dispatch but before the executor reported a terminal result',
                );
              } else if (result.isError) {
                const first = result.content.find((block) => block.type === 'text');
                session.failTool(executionId, first?.type === 'text' ? first.text : 'tool returned an error');
              } else {
                session.completeTool(executionId);
              }
            });
          }
          await this.observe(
            createSpanEnded(toolContext, {
              name: 'tool.execute',
              spanId: toolSpan.spanId,
              parentSpanId: runSpan.spanId,
              status: runController.signal.aborted ? 'canceled' : result.isError ? 'error' : 'ok',
              durationMs: Date.now() - toolStartedAt,
              attributes: { toolName: call.name, isError: result.isError === true },
            }),
          );
          yield { type: 'tool_end', call: dispatchCall, result };
          if (result.isError && !runController.signal.aborted) {
            consecutiveFailures++;
            const key = `${call.name}:${JSON.stringify(dispatchCall.arguments)}`;
            const repeats = (failCounts.get(key) ?? 0) + 1;
            failCounts.set(key, repeats);
            if (repeats > repeatMax) repeatMax = repeats;
          } else if (!result.isError) {
            consecutiveFailures = 0;
            failCounts.clear();
            nudged = false;
          }
          // The model must not be told its own arguments ran when a human
          // changed them. The note sits beside the tool's own output rather
          // than inside it, so the output budget still applies to the tool.
          const editNote = edited
            ? `[approval] a human reviewer edited these arguments before execution; it ran with: ${truncateMiddle(JSON.stringify(edited), 1_024)}`
            : undefined;
          results.push({
            type: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: editNote ? [{ type: 'text', text: editNote }, ...result.content] : result.content,
            ...(result.isError ? { isError: true } : {}),
          });
          const decision = evaluateFlail();
          if (decision === 'stop') {
            guardStoppedThisBatch = true;
            yield { type: 'flail_stop', consecutiveFailures };
          } else if (decision === 'nudge') {
            guardNudgedThisBatch = true;
            yield { type: 'flail_nudge', consecutiveFailures };
          }
        }
        if (suspendedThisBatch) {
          // The transcript deliberately still ends at the assistant tool_use
          // message: writing partial results would either fabricate outcomes for
          // undecided calls or leave a message the provider rejects. Results
          // produced so far are retained for an in-process resume.
          for (let index = 0; index < results.length; index++) {
            const item = batchCalls[index];
            if (item) item.settled = results[index];
          }
          this.suspendedBatch = { ...(batchRequestId ? { requestId: batchRequestId } : {}), calls: batchCalls };
          status = 'suspended';
          reason = 'awaiting_approval';
          terminal = true;
          break;
        }
        this.suspendedBatch = undefined;
        this.suspendedAtOpen = false;
        const content: UserBlock[] = [...results];
        if (toolBudgetHit) {
          status = 'budget_exceeded';
          reason = 'tool_calls';
          await this.observeBudget(telemetryContext, 'tool_calls');
          yield { type: 'budget_exceeded', reason: 'tool_calls' };
          terminal = true;
        } else if (runController.signal.aborted) {
          status = deadlineExceeded ? 'budget_exceeded' : 'canceled';
          reason = deadlineExceeded ? 'wall_time' : 'user_abort';
          if (deadlineExceeded) {
            await this.observeBudget(telemetryContext, 'wall_time');
            yield { type: 'budget_exceeded', reason: 'wall_time' };
          }
          terminal = true;
        } else if (guardStoppedThisBatch) {
          content.push({ type: 'text', text: STOP_TEXT });
        } else if (guardNudgedThisBatch) {
          content.push({ type: 'text', text: NUDGE_TEXT });
        }
        const resultMessage: Message = { role: 'user', content };
        this.messages.push(resultMessage);
        if (!this.persist(resultMessage)) {
          status = 'incomplete';
          reason = 'persistence';
          terminal = true;
        }
      }
      runBodyCompleted = true;
    } catch (error) {
      failed = true;
      failedError = error;
      for (const session of runSessions) {
        this.journalFor(session, (target) => target.setRunStatus('failed', String(error)));
      }
      await this.observe(
        createRuntimeEvent(telemetryContext, {
          name: 'runtime.error',
          level: 'error',
          attributes: { errorType: error instanceof Error ? error.name : 'Error', message: String(error) },
        }),
      );
      throw error;
    } finally {
      if (!runBodyCompleted && !failed) {
        status = 'canceled';
        reason = 'user_abort';
        if (!runController.signal.aborted) {
          runController.abort(new Error('agent run consumer stopped iteration'));
        }
      }
      if (!failed) {
        let terminalPersisted = true;
        // A suspended run records its ceilings so the resume continues under them
        // instead of silently inheriting whatever defaults the next process has.
        const terminalBudget: RunBudgetSnapshot | undefined = status === 'suspended' ? { ...budget } : undefined;
        for (const session of runSessions) {
          const written = this.journalFor(session, (target) => {
            target.setRunStatus(status, reason, terminalBudget ? { budget: terminalBudget } : {});
            return true;
          });
          if (written !== true) terminalPersisted = false;
        }
        // Every externally visible terminal requires a durable row whenever this
        // run owns a session. The failing append itself may make a corrective row
        // impossible, but CLI/telemetry must still identify persistence as the
        // controlling failure and force the journal to be reopened.
        if (!terminalPersisted) {
          status = 'incomplete';
          reason = 'persistence';
        }
        // Once every segment of a continued run has a durable terminal row, the
        // newest session is the sole append target. Do not retain ancestor locks
        // (or one process exit listener per historical segment) indefinitely.
        if (terminalPersisted) {
          for (const session of runSessions) {
            if (session.id !== this._session?.id) releaseSessionLock(session.file);
          }
        }
      }
      const spanStatus = failed
        ? 'error'
        : status === 'completed'
          ? 'ok'
          : status === 'canceled'
            ? 'canceled'
            : status;
      await this.observe(
        createRuntimeEvent(telemetryContext, {
          name: 'run.status',
          level: failed || status !== 'completed' ? 'warn' : 'info',
          attributes: { status: failed ? 'failed' : status, reason, modelRequests: iterations, toolCalls },
        }),
      );
      await this.observe(
        createSpanEnded(runTelemetryContext, {
          name: 'agent.run',
          spanId: runSpan.spanId,
          status: spanStatus,
          durationMs: Date.now() - runStartedAt,
          ...(failedError instanceof Error
            ? { error: { type: failedError.name, message: failedError.message, ...(failedError.stack ? { stack: failedError.stack } : {}) } }
            : {}),
          attributes: { reason, modelRequests: iterations, toolCalls },
        }),
      );
      await this.flushObserver();
      clearTimeout(deadline);
      signal?.removeEventListener('abort', forwardAbort);
      this.running = false;
      this.activeTelemetryContext = undefined;
      this.activeRunSignal = undefined;
      this.lastTurnUsage = turnUsage;
      this.lastTurnCost = turnCost;
    }

    yield { type: 'turn_done', iterations, toolCalls, usage: turnUsage, cost: turnCost, status, reason };
  }

  private offloadCounter = 0;
  private offloadDirPath?: string;
  private offloadDirReference?: string;

  private offloadDir(): { path: string; reference: string } {
    if (!this.offloadDirPath) {
      const context = this.toolContext();
      const root = resolveWorkspaceRoot(context);
      // A fresh unpredictable directory avoids overwriting an earlier run's
      // offloads after resume. Its local ignore file keeps raw tool output (which
      // may contain credentials or proprietary source) out of `git add -A`.
      const reference = join('.pi', 'artifacts', createTelemetryId('event'));
      let base = resolveWorkspacePath(context, join(root, reference), { allowAbsolute: true, mustExist: false });
      mkdirSync(base, { recursive: true, mode: 0o700 });
      // Re-resolve after creation to catch a symlink introduced in the path.
      base = resolveWorkspacePath(context, join(root, reference), { allowAbsolute: true });
      atomicWriteTextFile(join(base, '.gitignore'), '*\n!.gitignore\n', { mode: 0o600 });
      this.offloadDirPath = base;
      this.offloadDirReference = relative(root, base);
    }
    return { path: this.offloadDirPath!, reference: this.offloadDirReference! };
  }

  /**
   * Microcompaction: old bulky tool outputs are moved to disk and replaced with a
   * path stub the model can re-read. Nothing is summarized away, no model call is
   * paid, and the session JSONL keeps the original content. Rewriting history is a
   * prompt-cache break, so this runs in batches (>= OFFLOAD_BATCH_MIN_CHARS).
   */
  private offloadOldToolResults(): { count: number; savedChars: number } | undefined {
    const option = this.options.offload;
    if (option === false) return undefined;
    const cfg = { thresholdChars: 4_000, keepRecentMessages: 6, ...(typeof option === 'object' ? option : {}) };
    const cutoff = this.messages.length - cfg.keepRecentMessages;
    const eligible: { block: ToolResultBlock; chars: number }[] = [];
    for (let index = 0; index < cutoff; index++) {
      const message = this.messages[index]!;
      if (message.role !== 'user') continue;
      for (const block of message.content) {
        if (block.type !== 'toolResult') continue;
        if (block.content.some((inner) => inner.type === 'image')) continue; // keep images intact (v1)
        const first = block.content[0];
        if (first?.type === 'text' && first.text.startsWith('[offloaded:')) continue;
        const chars = block.content.reduce(
          (sum, inner) => sum + (inner.type === 'text' ? inner.text.length : 0),
          0,
        );
        if (chars >= cfg.thresholdChars) eligible.push({ block, chars });
      }
    }
    const total = eligible.reduce((sum, entry) => sum + entry.chars, 0);
    if (eligible.length === 0 || total < OFFLOAD_BATCH_MIN_CHARS) return undefined;
    let count = 0;
    let savedChars = 0;
    for (const { block, chars } of eligible) {
      const text = block.content
        .filter((inner): inner is Extract<typeof inner, { type: 'text' }> => inner.type === 'text')
        .map((inner) => inner.text)
        .join('\n');
      try {
        const directory = this.offloadDir();
        const name = `offload-${++this.offloadCounter}.txt`;
        const path = join(directory.path, name);
        atomicWriteTextFile(path, text, { mode: 0o600 });
        block.content = [
          {
            type: 'text',
            text: `[offloaded: ${chars}-char ${block.toolName} output saved to ${join(directory.reference, name)}; read that workspace-relative file again if needed]`,
          },
        ];
      } catch {
        continue; // disk trouble: leave the block inline rather than lose it
      }
      count++;
      savedChars += chars;
    }
    return count > 0 ? { count, savedChars } : undefined;
  }

  /** Compaction fires before the projected next request crosses window - reserve. */
  private compactThreshold(): number | undefined {
    const window = this.options.contextWindow;
    if (!window) return undefined;
    return window - Math.min(16_384, Math.floor(window / 4));
  }

  private compactionKeepTokens(): number {
    const window = this.options.contextWindow ?? 128_000;
    return Math.min(KEEP_RECENT_TOKENS, Math.max(1_000, Math.floor(window / 5)));
  }

  /** Compaction cannot migrate the open tool-use batch in approval v1. */
  private assertCompactionAllowed(): void {
    const blocked = this._session?.suspendedToolExecutions ?? [];
    if (!this.suspended && blocked.length === 0) return;
    const executionIds = blocked.length > 0
      ? blocked.map((state) => state.executionId)
      : this.pendingApprovals.map((item) => item.executionId);
    throw new Error(
      `cannot compact while tool approvals are pending; decide and resume execution(s): ${executionIds.join(', ') || 'pending batch'}`,
    );
  }

  /**
   * Checkpoint the live (possibly micro-offloaded) transcript into a fresh,
   * self-contained session before the append-only journal reaches its recovery
   * ceiling. `session_ready` is the atomic publication marker; an interrupted
   * copy remains discoverable for audit but is never selected by `--continue`.
   */
  private async rotateSessionForStorage(): Promise<void> {
    const source = this._session;
    if (!source) return;
    const locked = Session.createLocked(this.cwd, this.model, dirname(source.file), {
      lineage: {
        parentSessionId: source.id,
        parentFile: source.file,
        relation: 'continuation',
        priorUsage: structuredClone(this.usageTotal),
        priorUsageComplete: this.usageHistoryComplete,
        priorCost: structuredClone(this.costTotal),
      },
    });
    const fresh = locked.session;
    try {
      fresh.appendMany(this.messages.map((message) => ({ t: 'msg' as const, message })));
      // Rotating a snapshot that is already at the threshold would loop forever
      // and cannot create recovery headroom. Require explicit compaction instead.
      if (statSync(fresh.file).size >= SESSION_ROTATE_BYTES - 1_024) {
        throw new RangeError('live transcript is too large for lossless session rotation; compact it first');
      }
      fresh.setRunStatus('running', `continued from ${source.id}`);
      fresh.markReady();
    } catch (error) {
      locked.release();
      try {
        unlinkSync(fresh.file);
      } catch {
        /* preserve the original rotation error */
      }
      throw new CompactionPersistenceError(`session rotation failed; original session retained: ${String(error)}`, {
        cause: error,
      });
    }
    this._session = fresh;
    const telemetryContext: TelemetryContext = {
      ...(this.activeTelemetryContext ?? createTelemetryContext(source.id)),
      sessionId: fresh.id,
    };
    this.activeTelemetryContext = telemetryContext;
    await this.observe(
      createRuntimeEvent(telemetryContext, {
        name: 'session.lineage',
        attributes: { relation: 'continuation', trigger: 'journal_rotation', parentSessionId: source.id },
      }),
    );
  }

  /**
   * Replaces everything before the keep-boundary with a one-message summary. The
   * compacted state goes to a NEW session file — the full transcript stays on disk.
   */
  private async compact(
    signal: AbortSignal | undefined,
    turnUsage: Usage,
    turnCost: CostSummary,
    budget: RunBudget,
    onRequestStart: () => void,
  ): Promise<number> {
    this.assertCompactionAllowed();
    const keepFrom = chooseKeepBoundary(this.messages, this.compactionKeepTokens());
    if (keepFrom <= 0) {
      throw new Error(
        'context preflight failed: the current turn alone does not fit the configured context window; shorten or offload the input',
      );
    }
    const telemetryContext = this.activeTelemetryContext ?? createTelemetryContext(this._session?.id);
    const compactSpan = createSpanStarted(telemetryContext, { name: 'context.compact' });
    const compactStartedAt = Date.now();
    await this.observe(compactSpan);
    const sourceSession = this._session;
    const compactionId = this.journalFor(sourceSession, (session) =>
      session.beginCompaction('auto', { keepFromMessage: keepFrom }),
    );
    if (sourceSession && !compactionId) {
      throw new CompactionPersistenceError('compaction did not start because its source journal is unavailable');
    }
    const droppedMessages = this.messages.slice(0, keepFrom);
    let summarized: { text: string; usage: Usage };
    try {
      summarized = await this.summarizeMessages(
        droppedMessages,
        signal,
        turnUsage,
        turnCost,
        budget,
        onRequestStart,
      );
    } catch (error) {
      if (compactionId) {
        this.journalFor(sourceSession, (session) => session.failCompaction(compactionId, String(error)));
      }
      await this.observe(
        createSpanEnded(telemetryContext, {
          name: 'context.compact',
          spanId: compactSpan.spanId,
          status: 'error',
          durationMs: Date.now() - compactStartedAt,
          error: { type: error instanceof Error ? error.name : 'Error', message: String(error) },
        }),
      );
      throw error;
    }
    const kept = this.messages.slice(keepFrom);
    const dropped = this.messages.length - kept.length;
    const rebuilt: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Summary of the earlier part of this session (auto-compacted):\n\n${summarized.text}`,
          },
        ],
      },
      ...kept,
    ];
    if (sourceSession && this.persistDisabled) {
      throw new CompactionPersistenceError(
        'compaction persistence failed; the billed summary could not be durably linked to its source session',
      );
    }
    if (sourceSession && !this.persistDisabled) {
      try {
        const locked = Session.createLocked(this.cwd, this.model, dirname(sourceSession.file), {
          lineage: {
            parentSessionId: sourceSession.id,
            parentFile: sourceSession.file,
            relation: 'compaction',
            priorUsage: structuredClone(this.usageTotal),
            priorUsageComplete: this.usageHistoryComplete,
            priorCost: structuredClone(this.costTotal),
          },
        });
        const fresh = locked.session;
        let commitAttempted = false;
        try {
          fresh.appendMany(rebuilt.map((message) => ({ t: 'msg' as const, message })));
          // The child must identify the interrupted run before the source commit
          // makes it the resumable head. A crash in the publication window can
          // then be recovered as incomplete instead of silently abandoning work.
          fresh.setRunStatus('running', `continued from ${sourceSession.id}`);
          commitAttempted = true;
          const committed =
            compactionId !== undefined &&
            this.journalFor(sourceSession, (session) => {
              session.completeCompaction(compactionId, dropped, {
                targetSessionId: fresh.id,
                usage: summarized.usage,
              });
              return true;
            }) === true;
          if (!committed) throw new Error('source compaction commit was not durably recorded');
        } catch (error) {
          locked.release();
          if (!commitAttempted) {
            try {
              unlinkSync(fresh.file);
            } catch {
              /* retain the original persistence error */
            }
          }
          throw error;
        }
        this._session = fresh;
        const childTelemetryContext: TelemetryContext = {
          ...telemetryContext,
          sessionId: fresh.id,
        };
        this.activeTelemetryContext = childTelemetryContext;
        await this.observe(
          createRuntimeEvent(childTelemetryContext, {
            name: 'session.lineage',
            attributes: { relation: 'compaction', parentSessionId: sourceSession.id },
          }),
        );
      } catch (error) {
        if (compactionId) {
          this.journalFor(sourceSession, (session) => session.failCompaction(compactionId, String(error)));
        }
        await this.observe(
          createSpanEnded(telemetryContext, {
            name: 'context.compact',
            spanId: compactSpan.spanId,
            status: 'error',
            durationMs: Date.now() - compactStartedAt,
            error: { type: error instanceof Error ? error.name : 'Error', message: String(error) },
          }),
        );
        throw new CompactionPersistenceError(
          `compaction persistence failed; original session retained: ${String(error)}`,
          { cause: error },
        );
      }
    }
    this.messages.splice(0, this.messages.length, ...rebuilt);
    this.lastContextTokens = 0;
    this.lastEstimatedRequestTokens = 0;
    await this.observe(
      createSpanEnded(telemetryContext, {
        name: 'context.compact',
        spanId: compactSpan.spanId,
        status: 'ok',
        durationMs: Date.now() - compactStartedAt,
        attributes: { droppedMessages: dropped },
      }),
    );
    return dropped;
  }

  /**
   * Build a bounded summary request. If old history alone exceeds the context
   * window, serialize it and retain its beginning and end rather than submitting
   * another request that is guaranteed to overflow.
   */
  private summaryRequestMessages(messages: Message[]): Message[] {
    const instructionText =
      'Summarize this earlier session prefix for continuation: goal, completed work, files touched, key decisions, unresolved risks, and immediate next steps. Markdown, under 300 words.';
    const instruction: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: instructionText,
        },
      ],
    };
    // The summary output cap must fit in the same model window as its input.
    // Normal compaction has a larger reserve, but tiny/custom windows need this
    // explicit bound as well.
    const threshold = Math.min(
      this.compactThreshold() ?? 96_000,
      this.options.contextWindow
        ? Math.max(0, this.options.contextWindow - COMPACTION_SUMMARY_MAX_TOKENS)
        : Number.POSITIVE_INFINITY,
    );
    const estimate = (candidate: Message[]): number =>
      estimateTokens(JSON.stringify({ system: COMPACTION_SYSTEM_PROMPT, messages: candidate, tools: [] }));
    const direct = [...messages, instruction];
    if (estimate(direct) <= threshold) return direct;

    const serialized = JSON.stringify(messages);
    const bounded = (maxChars: number): Message[] => {
      const transcript =
        maxChars === 0
          ? '[serialized transcript omitted because even its bounded envelope was too large]'
          : truncateMiddle(serialized, maxChars);
      return [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `The following serialized earlier transcript was bounded for safety; a marker identifies omitted middle content. Summarize only what is present.\n\n${transcript}\n\n${instructionText}`,
          },
        ],
      }];
    };

    // Truncation markers and JSON escaping add their own bytes. Binary-search
    // against the final request envelope rather than assuming four chars/token;
    // code-heavy transcripts full of quotes/backslashes can otherwise double.
    let low = 0;
    let high = serialized.length;
    let best: Message[] | undefined;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const candidate = bounded(midpoint);
      if (estimate(candidate) <= threshold) {
        best = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (!best) {
      throw new RangeError(
        `context preflight failed: compaction summary envelope exceeds the ${threshold}-token input limit`,
      );
    }
    return best;
  }

  private async summarizeMessages(
    messages: Message[],
    signal?: AbortSignal,
    turnUsage?: Usage,
    turnCost?: CostSummary,
    budget?: Pick<RunBudget, 'maxSpendUSD'>,
    onRequestStart?: () => void,
  ): Promise<{ text: string; usage: Usage }> {
    let text = '';
    let done: { message: AssistantMessage; stopReason: StopReason; usage: Usage } | undefined;
    const summaryMessages = this.summaryRequestMessages(messages);
    const summaryThreshold = Math.min(
      this.compactThreshold() ?? 96_000,
      this.options.contextWindow
        ? Math.max(0, this.options.contextWindow - COMPACTION_SUMMARY_MAX_TOKENS)
        : Number.POSITIVE_INFINITY,
    );
    const summaryEstimate = estimateTokens(
      JSON.stringify({ system: COMPACTION_SYSTEM_PROMPT, messages: summaryMessages, tools: [] }),
    );
    if (summaryEstimate > summaryThreshold) {
      throw new RangeError(
        `context preflight failed: compaction summary request projects ${summaryEstimate} tokens against a ${summaryThreshold}-token input limit`,
      );
    }
    const summaryRequest: CompletionRequest = {
      model: this.model,
      system: COMPACTION_SYSTEM_PROMPT,
      messages: summaryMessages,
      tools: [],
      maxAttempts: 1,
      maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
    if (budget?.maxSpendUSD !== undefined && !this.options.pricing) {
      throw new Error(
        `maxSpendUSD requires an exact price for model ${this.model}; provide a pricing table containing that model`,
      );
    }
    const spendReservation =
      budget?.maxSpendUSD !== undefined ? reserveRequestSpend(summaryRequest, this.options.pricing!) : undefined;
    const activeCost = turnCost ?? emptyCostSummary();
    if (
      budget?.maxSpendUSD !== undefined &&
      spendExposure(activeCost) + (spendReservation?.usd ?? 0) > budget.maxSpendUSD
    ) {
      throw new SpendBudgetExceededError(
        spendReservation?.usd ?? 0,
        budget.maxSpendUSD - spendExposure(activeCost),
      );
    }
    const requestId = createTelemetryId('request');
    const requestJournaled =
      !this._session ||
      this.journal((session) => {
        session.beginModelRequest(this.model, {
          requestId,
          messageCount: summaryMessages.length,
          ...(spendReservation ? { spendReservation } : {}),
        });
        return true;
      }) === true;
    if (!requestJournaled) {
      throw new CompactionPersistenceError('summary request did not start because its session journal is unavailable');
    }
    this.requestCount++;
    onRequestStart?.();
    const telemetryContext = {
      ...(this.activeTelemetryContext ?? createTelemetryContext(this._session?.id)),
      requestId,
    };
    const requestSpan = createSpanStarted(telemetryContext, {
      name: 'model.request',
      attributes: { model: this.model, purpose: 'compaction', messageCount: summaryMessages.length },
    });
    const requestStartedAt = Date.now();
    await this.observe(requestSpan);
    await this.observeCredentialAttach(telemetryContext);
    const stream = this.options.client.stream(summaryRequest, signal);
    const streamIterator = stream[Symbol.asyncIterator]();
    let requestCostTerminal = false;
    const recordUnknownCost = () => {
      if (requestCostTerminal) return;
      addUnknownRequestCost(activeCost, spendReservation);
      addUnknownRequestCost(this.costTotal, spendReservation);
      requestCostTerminal = true;
    };
    try {
      while (true) {
        const next = await nextStreamEvent(streamIterator, signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'text_delta') text += event.text;
        else if (event.type === 'done') done = event;
      }
    } catch (error) {
      releaseStream(streamIterator);
      if (signal?.aborted) {
        this.journal((session) =>
          session.markModelRequestOutcomeUnknown(
            requestId,
            'summary request was canceled after dispatch before a terminal response was recorded',
          ),
        );
      } else {
        this.journal((session) => session.failModelRequest(requestId, String(error)));
      }
      recordUnknownCost();
      await this.observe(
        createSpanEnded(telemetryContext, {
          name: 'model.request',
          spanId: requestSpan.spanId,
          status: 'error',
          durationMs: Date.now() - requestStartedAt,
          error: { type: error instanceof Error ? error.name : 'Error', message: String(error) },
          attributes: { purpose: 'compaction' },
        }),
      );
      throw error;
    }
    if (!done) {
      this.journal((session) => session.failModelRequest(requestId, 'summarizer had no terminal result'));
      recordUnknownCost();
      await this.observe(
        createSpanEnded(telemetryContext, {
          name: 'model.request',
          spanId: requestSpan.spanId,
          status: 'incomplete',
          durationMs: Date.now() - requestStartedAt,
          attributes: { purpose: 'compaction' },
        }),
      );
      throw new Error('compaction failed: summarizer stream ended without a terminal result');
    }
    const requestCost = this.options.pricing ? costForUsage(done.usage, this.options.pricing) : undefined;
    const completionJournaled =
      !this._session ||
      this.journal((session) => {
        session.completeModelRequest(requestId, {
          stopReason: done!.stopReason,
          usage: done!.usage,
          ...(requestCost ? { cost: requestCost } : {}),
        });
        return true;
      }) === true;
    // Usage is billable once the provider has completed, even if the summary is
    // semantically unusable (truncated/empty) or its later persistence fails.
    addUsage(this.usageTotal, done.usage);
    if (turnUsage) addUsage(turnUsage, done.usage);
    addRequestCost(this.costTotal, requestCost);
    addRequestCost(activeCost, requestCost);
    requestCostTerminal = true;
    const actualSpendExceeded =
      budget?.maxSpendUSD !== undefined && spendExposure(activeCost) > budget.maxSpendUSD;
    await this.observe(
      createSpanEnded(telemetryContext, {
        name: 'model.request',
        spanId: requestSpan.spanId,
        status: done.stopReason === 'end_turn' ? 'ok' : 'incomplete',
        durationMs: Date.now() - requestStartedAt,
        attributes: { purpose: 'compaction', stopReason: done.stopReason, outputTokens: done.usage.outputTokens },
      }),
    );
    if (actualSpendExceeded) {
      throw new SpendBudgetExceededError(0, budget!.maxSpendUSD! - spendExposure(activeCost));
    }
    if (!completionJournaled) {
      throw new CompactionPersistenceError(
        'compaction failed: the billed summary completion could not be durably recorded',
      );
    }
    if (done.stopReason !== 'end_turn') {
      throw new Error(`compaction failed: summarizer stopped with ${done.stopReason}`);
    }
    if (!text.trim()) {
      text = done.message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }
    if (!text.trim()) throw new Error('compaction failed: summarizer returned an empty summary');
    return { text: text.trim(), usage: done.usage };
  }

  /** Manual handoff summary; unlike old behavior, its request and usage are accounted. */
  async summarize(signal?: AbortSignal): Promise<string> {
    this.assertCompactionAllowed();
    const summaryCost = emptyCostSummary();
    const maxSpendUSD = this.options.budget?.maxSpendUSD;
    const summarized = await this.summarizeMessages(
      this.messages,
      signal,
      undefined,
      summaryCost,
      maxSpendUSD !== undefined ? { maxSpendUSD } : undefined,
    );
    return summarized.text;
  }
}
