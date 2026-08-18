import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { requireString, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'coverage',
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_FILES = 400;

/** regex-based top-level symbol extraction; deliberately dependency-free — orientation, not analysis */
const EXTRACTORS: Record<string, RegExp[]> = {
  '.ts': [
    /^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ],
  '.py': [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm],
  '.go': [/^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm],
  '.rs': [
    /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
    /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/gm,
  ],
  '.java': [/^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm],
  '.rb': [/^\s*(?:def|class|module)\s+([A-Za-z_][\w.?!]*)/gm],
  '.c': [/^[A-Za-z_][\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm],
  '.sh': [/^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm],
};
for (const [alias, target] of [
  ['.tsx', '.ts'],
  ['.js', '.ts'],
  ['.jsx', '.ts'],
  ['.mjs', '.ts'],
  ['.kt', '.java'],
  ['.h', '.c'],
  ['.cpp', '.c'],
  ['.cc', '.c'],
  ['.bash', '.sh'],
] as const) {
  EXTRACTORS[alias] = EXTRACTORS[target]!;
}

function symbolsOf(path: string, ext: string): string[] {
  const patterns = EXTRACTORS[ext];
  if (!patterns) return [];
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null && seen.size < MAX_SYMBOLS_PER_FILE + 8) {
      seen.add(match[1]!);
    }
  }
  return [...seen];
}

interface FileEntry {
  relPath: string;
  lines: number;
  symbols: string[];
}

function walk(dir: string, root: string, depthLeft: number, files: FileEntry[]): void {
  if (files.length >= MAX_FILES || depthLeft < 0) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (files.length >= MAX_FILES) return;
    if (name.startsWith('.') && name !== '.') continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, root, depthLeft - 1, files);
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (!(ext in EXTRACTORS) || stat.size > MAX_FILE_BYTES) continue;
    let lines = 0;
    try {
      lines = readFileSync(full, 'utf8').split('\n').length;
    } catch {
      continue;
    }
    files.push({ relPath: relative(root, full), lines, symbols: symbolsOf(full, ext) });
  }
}

export const mapTool: Tool = {
  name: 'map',
  description:
    'Map the code structure: source files with line counts and top-level symbols. Use it to orient before searching or reading.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'subtree to map (default: working directory)' },
      depth: { type: 'number', description: 'directory depth (default 4)' },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const root = resolve(
      context.cwd,
      typeof args['path'] === 'string' && args['path'].length > 0 ? requireString(args, 'path') : '.',
    );
    const depth = typeof args['depth'] === 'number' && args['depth'] > 0 ? Math.floor(args['depth']) : 4;
    const files: FileEntry[] = [];
    walk(root, root, depth, files);
    if (files.length === 0) return textOutput(`no recognized source files under ${root} (depth ${depth})`);

    const rendered = files.map((file) => {
      const symbols =
        file.symbols.length === 0
          ? ''
          : `: ${file.symbols.slice(0, MAX_SYMBOLS_PER_FILE).join(', ')}${file.symbols.length > MAX_SYMBOLS_PER_FILE ? ` +${file.symbols.length - MAX_SYMBOLS_PER_FILE} more` : ''}`;
      return `${file.relPath} (${file.lines}L)${symbols}`;
    });
    let text = rendered.join('\n');
    let note = '';
    if (files.length >= MAX_FILES) note += `\n[capped at ${MAX_FILES} files; map a subtree via path]`;
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS);
      note += `\n[truncated at ${MAX_OUTPUT_CHARS} chars; map a subtree via path or lower depth]`;
    }
    return textOutput(text + note);
  },
};
