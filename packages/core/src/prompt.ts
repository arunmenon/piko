import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, join } from 'node:path';

export const AGENTS_MD_LINE_WARNING = 60;

export interface AgentsMd {
  content: string;
  lines: number;
  /** true when the file exceeds the size research says helps (+4% under ~60 hand-written lines, -20% when bloated) */
  oversized: boolean;
}

export function loadAgentsMd(cwd: string): AgentsMd | undefined {
  const path = join(cwd, 'AGENTS.md');
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8').trim();
  if (content.length === 0) return undefined;
  const lines = content.split('\n').length;
  return { content, lines, oversized: lines > AGENTS_MD_LINE_WARNING };
}

export interface SkillEntry {
  name: string;
  path: string;
  summary: string;
}

/** Skills are plain markdown the model reads on demand — only a one-line index is ever in fixed context. */
export function discoverSkills(cwd: string): SkillEntry[] {
  const dir = join(cwd, '.agent', 'skills');
  if (!existsSync(dir)) return [];
  const entries: SkillEntry[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
    const path = join(dir, file);
    const firstLine = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
    entries.push({
      name: basename(file, '.md'),
      path,
      summary: firstLine.replace(/^#+\s*/, '').trim(),
    });
  }
  return entries;
}

/** ~180 words. The budget check in scripts/check-budget.ts fails the build if prompt + tool schemas exceed 1000 tokens. */
export function buildSystemPrompt(options: {
  cwd: string;
  agentsMd?: AgentsMd;
  skills?: SkillEntry[];
  date?: string;
}): string {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  let prompt = `You are pi, a coding agent running in the user's terminal.

Work autonomously: use tools to inspect the project, make changes, and verify them, then reply with a brief summary. Don't narrate routine steps or ask permission to proceed.

Tools:
- map: your first call when a task involves finding code. One map of the relevant directory is cheaper than several searches.
- read/write/edit for files. Read a file before editing it. edit requires old_text to match exactly (whitespace included) and be unique unless replace_all is set.
- bash for everything else: search (rg/grep), git, tests, installs, any CLI. Non-interactive commands only.

Guidance:
- Prefer small surgical edits over rewriting files.
- A task is not done until you verified it: re-run the failing command, run the tests, or check the produced state. Never claim success on an unverified change.
- For multi-step work keep a plan in PLAN.md with markdown checkboxes and update it as you go.
- Keep replies terse: what changed, where, anything the user must know. No preamble.

Environment: cwd ${options.cwd} | ${platform()} | ${date}`;

  if (options.agentsMd) {
    prompt += `\n\nProject notes (AGENTS.md):\n${options.agentsMd.content}`;
  }
  if (options.skills && options.skills.length > 0) {
    const index = options.skills.map((skill) => `- ${skill.name}: ${skill.summary} (${skill.path})`).join('\n');
    prompt += `\n\nSkills — read the file with the read tool when relevant:\n${index}`;
  }
  return prompt;
}
