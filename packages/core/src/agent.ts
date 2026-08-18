import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addUsage,
  emptyUsage,
  estimateTokens,
  type AssistantMessage,
  type CompletionRequest,
  type Message,
  type StopReason,
  type StreamEvent,
  type ToolCallBlock,
  type ToolResultBlock,
  type Usage,
  type UserBlock,
} from '@pi/ai';
import { Session, tryLockSession } from './session.js';
import type { Tool, ToolContext, ToolOutput } from './tools/types.js';

/** structural interface satisfied by LLMClient — lets tests drive the loop without a network */
export interface CompletionClient {
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, void>;
}

const KEEP_RECENT_TOKENS = 20_000;

/**
 * Earliest message index whose tail fits the keep budget, constrained to clean
 * boundaries (a user message with no tool results — never splits a tool_use from
 * its results). Falls back to the most recent boundary when one turn is oversized.
 */
export function chooseKeepBoundary(messages: Message[], keepTokens = KEEP_RECENT_TOKENS): number {
  const boundaries: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'user' && !message.content.some((block) => block.type === 'toolResult')) {
      boundaries.push(index);
    }
  }
  if (boundaries.length === 0) return messages.length;
  for (const index of boundaries) {
    if (estimateTokens(JSON.stringify(messages.slice(index))) <= keepTokens) return index;
  }
  return boundaries[boundaries.length - 1]!;
}

/** If the transcript ends in an assistant message with tool calls but no results,
 *  produce a user message of synthesized error results (both APIs reject the gap). */
export function synthesizeInterruptedResults(messages: Message[]): Message | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return undefined;
  const calls = last.content.filter((block): block is ToolCallBlock => block.type === 'toolCall');
  if (calls.length === 0) return undefined;
  return {
    role: 'user',
    content: calls.map(
      (call): ToolResultBlock => ({
        type: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'interrupted: this tool call never ran (session was resumed)' }],
        isError: true,
      }),
    ),
  };
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; call: ToolCallBlock }
  | { type: 'tool_end'; call: ToolCallBlock; result: ToolOutput }
  | { type: 'response_done'; message: AssistantMessage; stopReason: StopReason; usage: Usage }
  | { type: 'compacted'; dropped: number; sessionFile?: string }
  | { type: 'flail_nudge'; consecutiveFailures: number }
  | { type: 'flail_stop'; consecutiveFailures: number }
  | { type: 'offloaded'; count: number; savedChars: number }
  | { type: 'steered'; text: string }
  | { type: 'turn_done'; iterations: number; usage: Usage };

export interface AgentOptions {
  client: CompletionClient;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  cwd: string;
  session?: Session;
  /** cap on model calls per user input — the headless --max-turns guard */
  maxIterations?: number;
  /** extended-thinking budget in tokens (Anthropic models) */
  thinkingBudget?: number;
  /** model context window in tokens — enables auto-compaction when set */
  contextWindow?: number;
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

export class Agent {
  readonly messages: Message[];
  readonly usageTotal: Usage = emptyUsage();
  lastTurnUsage: Usage = emptyUsage();
  requestCount = 0;
  /** mutable so /model can switch mid-session */
  model: string;
  /** context tokens consumed by the most recent request (from real usage, not estimates) */
  private lastContextTokens = 0;
  private _session?: Session;
  private cwd: string;
  private readonly toolsByName: Map<string, Tool>;

  get session(): Session | undefined {
    return this._session;
  }

  constructor(private readonly options: AgentOptions) {
    this.messages = options.session ? [...options.session.messages] : [];
    if (options.session) addUsage(this.usageTotal, options.session.usage);
    this.model = options.model;
    if (options.session) this._session = options.session;
    this.cwd = options.cwd;
    this.toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
    // a session that died between persisting an assistant tool call and its results
    // (crash, kill, /branch at a tool-call message) would 400 on every provider —
    // synthesize error results so the transcript is always well-formed
    const repair = synthesizeInterruptedResults(this.messages);
    if (repair) {
      this.messages.push(repair);
      this.persist(repair);
    }
  }

  get workingDirectory(): string {
    return this.cwd;
  }

  private persistDisabled = false;

  /** Persistence failure (disk full, dir deleted) must never corrupt the live conversation. */
  private persistEntry(entry: Parameters<Session['append']>[0]): void {
    if (!this._session || this.persistDisabled) return;
    try {
      this._session.append(entry);
    } catch (error) {
      this.persistDisabled = true;
      process.stderr.write(`warning: session logging disabled — ${String(error)}\n`);
    }
  }

  private persist(message: Message): void {
    this.persistEntry({ t: 'msg', message });
  }

  private toolContext(signal?: AbortSignal): ToolContext {
    const agent = this;
    return {
      get cwd() {
        return agent.cwd;
      },
      setCwd(dir: string) {
        agent.cwd = dir;
      },
      ...(signal ? { signal } : {}),
    };
  }

  private async executeCall(call: ToolCallBlock, signal?: AbortSignal): Promise<ToolOutput> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) return { content: [{ type: 'text', text: `unknown tool "${call.name}"` }], isError: true };
    try {
      return await tool.execute(call.arguments, this.toolContext(signal));
    } catch (error) {
      return { content: [{ type: 'text', text: String(error) }], isError: true };
    }
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
    const maxIterations = this.options.maxIterations ?? 40;
    const turnUsage = emptyUsage();
    const userMessage: Message = { role: 'user', content: [{ type: 'text', text: input }] };
    this.messages.push(userMessage);
    this.persist(userMessage);

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

    let iterations = 0;
    while (iterations < maxIterations) {
      if (signal?.aborted) break;
      for (const note of steering?.() ?? []) {
        const steerMessage: Message = { role: 'user', content: [{ type: 'text', text: `[steering] ${note}` }] };
        this.messages.push(steerMessage);
        this.persist(steerMessage);
        yield { type: 'steered', text: note };
      }
      // compaction first: offloading messages compaction is about to drop wastes
      // disk writes and hands summarize() stubs instead of real outputs
      const threshold = this.compactThreshold();
      if (threshold !== undefined && this.lastContextTokens > threshold && this.messages.length > 1) {
        const dropped = await this.compact(signal);
        yield { type: 'compacted', dropped, ...(this._session ? { sessionFile: this._session.file } : {}) };
      }
      const offloaded = this.offloadOldToolResults();
      if (offloaded) yield { type: 'offloaded', ...offloaded };
      iterations++;
      this.requestCount++;

      let done: { message: AssistantMessage; stopReason: StopReason; usage: Usage } | undefined;
      const stream = this.options.client.stream(
        {
          model: this.model,
          system: this.options.systemPrompt,
          messages: this.messages,
          tools: this.options.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          ...(this.options.thinkingBudget !== undefined ? { thinkingBudget: this.options.thinkingBudget } : {}),
        },
        signal,
      );
      try {
        for await (const event of stream) {
          if (event.type === 'text_delta') yield { type: 'text', text: event.text };
          else if (event.type === 'thinking_delta') yield { type: 'thinking', text: event.text };
          else if (event.type === 'done') done = event;
        }
      } catch (error) {
        if (signal?.aborted) break; // user interrupt: keep state as-is, stay usable
        throw error;
      }
      if (!done || done.message.content.length === 0) break;

      this.messages.push(done.message);
      this.persist(done.message);
      addUsage(turnUsage, done.usage);
      addUsage(this.usageTotal, done.usage);
      this.lastContextTokens =
        done.usage.inputTokens + done.usage.cacheReadTokens + done.usage.cacheWriteTokens + done.usage.outputTokens;
      this.persistEntry({ t: 'usage', usage: done.usage });
      yield { type: 'response_done', message: done.message, stopReason: done.stopReason, usage: done.usage };

      const calls = done.message.content.filter((block): block is ToolCallBlock => block.type === 'toolCall');
      if (stopping) {
        // final-report round after a flail stop: never execute more tools; if the
        // model tried anyway, synthesize results so the transcript stays API-valid
        const repair = synthesizeInterruptedResults(this.messages);
        if (repair) {
          this.messages.push(repair);
          this.persist(repair);
        }
        break;
      }
      if (calls.length === 0) break;

      const results: ToolResultBlock[] = [];
      let repeatMax = 0;
      for (const call of calls) {
        yield { type: 'tool_start', call };
        const result = signal?.aborted
          ? { content: [{ type: 'text' as const, text: 'interrupted by user' }], isError: true }
          : await this.executeCall(call, signal);
        yield { type: 'tool_end', call, result };
        if (result.isError && !signal?.aborted) {
          // aborted calls are the user's doing, not the model flailing
          consecutiveFailures++;
          const key = `${call.name}:${JSON.stringify(call.arguments).slice(0, 200)}`;
          const repeats = (failCounts.get(key) ?? 0) + 1;
          failCounts.set(key, repeats);
          if (repeats > repeatMax) repeatMax = repeats;
        } else if (!result.isError) {
          consecutiveFailures = 0;
        }
        results.push({
          type: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
      }
      const content: UserBlock[] = [...results];
      if (guard) {
        // an identical call failing repeatedly is a stronger stall signal than mixed failures
        const shouldStop = consecutiveFailures >= guard.stopAfter || repeatMax >= guard.repeatStopAfter;
        if (shouldStop) {
          stopping = true;
          content.push({ type: 'text', text: STOP_TEXT });
          yield { type: 'flail_stop', consecutiveFailures };
        } else if (!nudged && (consecutiveFailures >= guard.nudgeAfter || repeatMax >= guard.repeatNudgeAfter)) {
          nudged = true;
          content.push({ type: 'text', text: NUDGE_TEXT });
          yield { type: 'flail_nudge', consecutiveFailures };
        }
      }
      const resultMessage: Message = { role: 'user', content };
      this.messages.push(resultMessage);
      this.persist(resultMessage);
    }

    this.lastTurnUsage = turnUsage;
    yield { type: 'turn_done', iterations, usage: turnUsage };
  }

  private offloadCounter = 0;
  private offloadDirPath?: string;

  private offloadDir(): string {
    if (!this.offloadDirPath) {
      const base = this._session
        ? this._session.file.replace(/\.jsonl$/, '.artifacts')
        : join(tmpdir(), `pi-offload-${process.pid}`);
      mkdirSync(base, { recursive: true });
      this.offloadDirPath = base;
    }
    return this.offloadDirPath;
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
      const path = join(this.offloadDir(), `offload-${++this.offloadCounter}.txt`);
      const text = block.content
        .filter((inner): inner is Extract<typeof inner, { type: 'text' }> => inner.type === 'text')
        .map((inner) => inner.text)
        .join('\n');
      try {
        writeFileSync(path, text, 'utf8');
      } catch {
        continue; // disk trouble: leave the block inline rather than lose it
      }
      block.content = [
        {
          type: 'text',
          text: `[offloaded: ${chars}-char ${block.toolName} output saved to ${path}; read that file again if needed]`,
        },
      ];
      count++;
      savedChars += chars;
    }
    return count > 0 ? { count, savedChars } : undefined;
  }

  /** Compaction fires when the last request's real context use crosses window - reserve. */
  private compactThreshold(): number | undefined {
    const window = this.options.contextWindow;
    if (!window || this.options.autoCompact === false) return undefined;
    return window - Math.min(16_384, Math.floor(window / 4));
  }

  /**
   * Replaces everything before the keep-boundary with a one-message summary. The
   * compacted state goes to a NEW session file — the full transcript stays on disk.
   */
  private async compact(signal?: AbortSignal): Promise<number> {
    const summary = await this.summarize(signal);
    const keepFrom = chooseKeepBoundary(this.messages);
    const kept = this.messages.slice(keepFrom);
    const dropped = this.messages.length - kept.length;
    const rebuilt: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: `Summary of the earlier part of this session (auto-compacted):\n\n${summary}` }],
      },
      ...kept,
    ];
    if (this._session && !this.persistDisabled) {
      try {
        const fresh = Session.create(this.cwd, this.model, dirname(this._session.file));
        tryLockSession(fresh.file);
        for (const message of rebuilt) fresh.append({ t: 'msg', message });
        this._session = fresh;
      } catch (error) {
        this.persistDisabled = true;
        process.stderr.write(`warning: session logging disabled — ${String(error)}\n`);
      }
    }
    this.messages.splice(0, this.messages.length, ...rebuilt);
    this.lastContextTokens = 0; // next real usage report re-establishes the level
    return dropped;
  }

  /**
   * One non-persisted model call that condenses the conversation into a handoff
   * summary — the caller seeds a fresh session with it (/compact and auto-compaction).
   */
  async summarize(signal?: AbortSignal): Promise<string> {
    let text = '';
    const stream = this.options.client.stream(
      {
        model: this.model,
        system: 'You condense coding sessions into handoff notes. Be terse and concrete.',
        messages: [
          ...this.messages,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Summarize this session for a fresh continuation: goal, current state, files touched, key decisions, and immediate next steps. Markdown, under 300 words.',
              },
            ],
          },
        ],
        tools: [],
      },
      signal,
    );
    for await (const event of stream) {
      if (event.type === 'text_delta') text += event.text;
    }
    return text.trim();
  }
}
