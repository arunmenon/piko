import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface PromptTemplate {
  name: string;
  body: string;
  source: string;
}

/** Global templates first, project templates override — same precedence users expect from config. */
export function loadTemplates(cwd: string): Map<string, PromptTemplate> {
  const templates = new Map<string, PromptTemplate>();
  for (const dir of [join(homedir(), '.agent', 'commands'), join(cwd, '.agent', 'commands')]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
      const name = basename(file, '.md');
      templates.set(name, { name, body: readFileSync(join(dir, file), 'utf8'), source: join(dir, file) });
    }
  }
  return templates;
}

export function interpolate(template: PromptTemplate, argumentText: string): string {
  // replacer function: a plain string replacement would interpret $&, $`, $' and $$
  // inside the user's arguments (sed/regex/shell snippets are natural inputs here)
  return template.body.replaceAll('$ARGUMENTS', () => argumentText);
}
