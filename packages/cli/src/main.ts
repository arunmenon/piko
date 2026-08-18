#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LLMClient, contextWindowFor, loadConfig, resolveProfile, type Profile } from '@pi/ai';
import {
  Agent,
  Session,
  buildSystemPrompt,
  defaultTools,
  discoverSkills,
  latestSessionFile,
  loadAgentsMd,
  sessionsDirFor,
  tryLockSession,
  type AgentEvent,
  type Tool,
} from '@pi/core';
import { HELP, parseArgs, type CliArgs } from './args.js';
import { loadExtensions } from './extensions.js';
import { interpolate, loadTemplates, type PromptTemplate } from './templates.js';
import { bold, cyan, dim, formatUsage, oneLine, red, summarizeArgs } from './render.js';

interface Setup {
  agent: Agent;
  profile: Profile;
  session: Session;
  tools: Tool[];
  maxIterations?: number;
  thinkingBudget?: number;
  contextWindow: number;
  autoCompact: boolean;
}

function openSession(args: CliArgs, cwd: string, model: string): Session {
  let file: string | undefined;
  if (args.session) {
    const inDir = join(sessionsDirFor(cwd), `${args.session}.jsonl`);
    file = existsSync(args.session) ? args.session : inDir;
    if (!existsSync(file)) throw new Error(`session not found: ${args.session}`);
  } else if (args.continue) {
    file = latestSessionFile(sessionsDirFor(cwd));
    if (!file) process.stderr.write(dim('no previous session here; starting a new one\n'));
  }
  if (file) {
    if (tryLockSession(file)) return Session.open(file);
    process.stderr.write(dim('that session is in use by another pi process; starting a new one\n'));
  }
  const session = Session.create(cwd, model);
  tryLockSession(session.file);
  return session;
}

function buildAgent(setup: Omit<Setup, 'agent'>, cwd: string, model: string): Agent {
  return new Agent({
    client: new LLMClient(setup.profile),
    model,
    systemPrompt: buildSystemPrompt({ cwd, agentsMd: loadAgentsMd(cwd), skills: discoverSkills(cwd) }),
    tools: setup.tools,
    cwd,
    session: setup.session,
    contextWindow: setup.contextWindow,
    autoCompact: setup.autoCompact,
    ...(setup.maxIterations !== undefined ? { maxIterations: setup.maxIterations } : {}),
    ...(setup.thinkingBudget !== undefined ? { thinkingBudget: setup.thinkingBudget } : {}),
  });
}

async function setup(args: CliArgs): Promise<Setup> {
  const cwd = process.cwd();
  const config = loadConfig();
  const profile = resolveProfile(config, args.profile, args.model);
  const agentsMd = loadAgentsMd(cwd);
  if (agentsMd?.oversized) {
    process.stderr.write(
      dim(`warning: AGENTS.md is ${agentsMd.lines} lines — guides over ~60 lines measurably hurt agent performance\n`),
    );
  }
  const tools = [...defaultTools(), ...(await loadExtensions([...(config.extensions ?? []), ...args.extensions], cwd))];
  const session = openSession(args, cwd, profile.model);
  const envWindow = Number(process.env['PI_CONTEXT_WINDOW']);
  const partial: Omit<Setup, 'agent'> = {
    profile,
    session,
    tools,
    contextWindow:
      Number.isFinite(envWindow) && envWindow > 0
        ? envWindow
        : (profile.contextWindow ?? contextWindowFor(profile.model)),
    autoCompact: args.autoCompact,
    ...(args.maxTurns !== undefined ? { maxIterations: args.maxTurns } : {}),
    ...(args.thinking !== undefined && args.thinking > 0 ? { thinkingBudget: args.thinking } : {}),
  };
  return { ...partial, agent: buildAgent(partial, cwd, profile.model) };
}

function printUsageSummary(agent: Agent, session: Session): void {
  process.stderr.write(
    `${JSON.stringify({
      usage: agent.usageTotal,
      lastTurn: agent.lastTurnUsage,
      requests: agent.requestCount,
      session: session.file,
    })}\n`,
  );
}

/**
 * Headless mode is the sub-agent story: progress goes to stderr, only the final
 * reply goes to stdout, so `pi -p "..."` composes cleanly inside bash tool calls.
 */
async function headless(args: CliArgs): Promise<number> {
  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    prompt = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (!prompt) {
    process.stderr.write('no prompt: pass one as an argument or on stdin\n');
    return 1;
  }
  const { agent, session } = await setup(args);

  // first Ctrl+C interrupts the turn (state stays well-formed), second force-quits
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    process.stderr.write('interrupting — Ctrl+C again to force quit\n');
  });

  let finalText = '';
  let sawToolLimit = false;
  let iterations = 0;
  for await (const event of agent.run(prompt, controller.signal)) {
    if (event.type === 'tool_start') {
      process.stderr.write(dim(`⚙ ${event.call.name} ${summarizeArgs(event.call.arguments)}\n`));
    } else if (event.type === 'compacted') {
      process.stderr.write(dim(`auto-compacted ${event.dropped} messages\n`));
    } else if (event.type === 'response_done') {
      const text = event.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text.trim()) finalText = text;
      sawToolLimit = event.stopReason === 'tool_use';
    } else if (event.type === 'turn_done') {
      iterations = event.iterations;
    }
  }
  if (args.usage) printUsageSummary(agent, agent.session ?? session);
  // always emit what we have — a parent process needs the partial answer even on truncation
  process.stdout.write(`${finalText}\n`);
  if (controller.signal.aborted) return 130;
  if (sawToolLimit) {
    process.stderr.write(
      `stopped at the turn cap (${iterations}) before the model finished — tools may already have made changes\n`,
    );
    return 2;
  }
  return 0;
}

interface ReplState {
  running: AbortController | undefined;
  atNewline: boolean;
}

function handleEvent(event: AgentEvent, state: ReplState): void {
  const ensureNewline = () => {
    if (!state.atNewline) {
      process.stdout.write('\n');
      state.atNewline = true;
    }
  };
  switch (event.type) {
    case 'text':
      process.stdout.write(event.text);
      state.atNewline = event.text.endsWith('\n');
      break;
    case 'thinking':
      break; // reasoning is not rendered; it is still visible in the session file if the provider stores it
    case 'tool_start':
      ensureNewline();
      process.stdout.write(`${cyan('⚙')} ${bold(event.call.name)} ${dim(summarizeArgs(event.call.arguments))}\n`);
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
    case 'turn_done':
      ensureNewline();
      process.stdout.write(dim(`[${event.iterations} call${event.iterations === 1 ? '' : 's'} | ${formatUsage(event.usage)}]\n`));
      break;
    case 'response_done':
      ensureNewline();
      break;
  }
}

async function runInput(agent: Agent, input: string, state: ReplState): Promise<void> {
  state.running = new AbortController();
  try {
    for await (const event of agent.run(input, state.running.signal)) handleEvent(event, state);
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error);
    process.stdout.write(`\n${red(text)}\n`);
    if (/context|too long|maximum.*length/i.test(text)) {
      process.stdout.write(dim('the conversation may have outgrown the model context — try /compact\n'));
    }
  } finally {
    state.running = undefined;
  }
}

interface SlashResult {
  input?: string;
  exit?: boolean;
  newSession?: Session;
  compact?: boolean;
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
      if (templates.size > 0) process.stdout.write(`templates: ${[...templates.keys()].map((n) => `/${n}`).join(' ')}\n`);
      return {};
    case 'exit':
    case 'quit':
      return { exit: true };
    case 'tokens':
      process.stdout.write(`total:     ${formatUsage(agent.usageTotal)}\n`);
      process.stdout.write(`last turn: ${formatUsage(agent.lastTurnUsage)}\n`);
      process.stdout.write(`requests:  ${agent.requestCount}\n`);
      return {};
    case 'model':
      if (argText) agent.model = argText;
      process.stdout.write(`model: ${agent.model}\n`);
      return {};
    case 'session':
      process.stdout.write(`${session.file}\n${agent.messages.length} messages\n`);
      return {};
    case 'compact':
      return { compact: true };
    case 'branch': {
      const at = Number(argText);
      if (!Number.isInteger(at) || at < 0 || at >= agent.messages.length) {
        process.stdout.write(red(`usage: /branch <message-index 0..${agent.messages.length - 1}>\n`));
        return {};
      }
      const branched = session.branch(at, agent.workingDirectory, agent.model);
      process.stdout.write(`branched to ${branched.file}\n`);
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
  let { agent, session } = initial;
  const templates = loadTemplates(process.cwd());
  const state: ReplState = { running: undefined, atNewline: true };

  process.stdout.write(`${bold('pi')} ${dim(`| ${initial.profile.name}:${agent.model} | session ${session.id} | /help`)}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${cyan('pi>')} ` });
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
    const pending: string[] = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      if (args.usage) printUsageSummary(agent, session);
      resolveRepl(0);
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
        if (result.compact) {
          if (agent.messages.length === 0) {
            process.stdout.write(dim('nothing to compact\n'));
          } else {
            process.stdout.write(dim('compacting…\n'));
            try {
              const summary = await agent.summarize();
              const fresh = Session.create(agent.workingDirectory, agent.model);
              tryLockSession(fresh.file);
              fresh.append({
                t: 'msg',
                message: { role: 'user', content: [{ type: 'text', text: `Summary of the previous session:\n\n${summary}` }] },
              });
              session = fresh;
              agent = buildAgent(
                { ...initial, session, maxIterations: initial.maxIterations, thinkingBudget: initial.thinkingBudget },
                agent.workingDirectory,
                agent.model,
              );
              process.stdout.write(`compacted into session ${session.id}\n`);
            } catch (error) {
              process.stdout.write(red(`compaction failed: ${String(error)}\n`));
            }
          }
        }
        if (result.newSession) {
          session = result.newSession;
          // rebuild on the branched session, keeping tools/extensions, caps, and model
          agent = buildAgent(
            { ...initial, session, maxIterations: initial.maxIterations, thinkingBudget: initial.thinkingBudget },
            agent.workingDirectory,
            agent.model,
          );
        }
        input = result.input;
      } else {
        input = line;
      }
      if (input) {
        await runInput(agent, input, state);
        // auto-compaction may have moved the agent to a fresh session file
        if (agent.session && agent.session !== session) session = agent.session;
      }
      if (!eof) rl.prompt();
      return false;
    };

    const drainQueue = async (first: string): Promise<void> => {
      processing = true;
      let line: string | undefined = first;
      while (line !== undefined) {
        if (await handleLine(line)) break;
        line = pending.shift();
      }
      processing = false;
      if (eof) finish();
    };

    rl.on('line', (rawLine) => {
      if (processing) {
        if (process.stdin.isTTY) {
          // typed input mid-turn is dropped, not queued — a buffered line silently
          // firing a full agent turn later is worse than asking the user to resend
          process.stdout.write(dim('\n(input ignored while a turn is running — resend when idle)\n'));
        } else {
          pending.push(rawLine); // piped stdin is a script: preserve order, run sequentially
        }
        return;
      }
      void drainQueue(rawLine);
    });

    rl.prompt();
  });
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    process.exitCode = args.print ? await headless(args) : await repl(args);
  } catch (error) {
    let text = String(error instanceof Error ? error.message : error);
    // surface the API's own explanation (model not found, quota, …), not just the status
    const body = (error as { body?: string }).body;
    if (body) text += ` — ${oneLine(body.replace(/\s+/g, ' ').trim(), 300)}`;
    process.stderr.write(`${red(text)}\n`);
    process.exitCode = 1;
  }
}

void main();
