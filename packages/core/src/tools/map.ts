import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { resolveWorkspacePath } from './filesystem.js';
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
/** Hard traversal bounds include ignored/hidden entries so hostile trees cannot hide work. */
export const MAP_MAX_VISITED_DIRECTORIES = 128;
export const MAP_MAX_DIRECTORY_ENTRIES = 4_096;
export const MAP_MAX_SCANNED_BYTES = 16 * 1024 * 1024;

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

function symbolsOf(source: string, ext: string): string[] {
  const patterns = EXTRACTORS[ext];
  if (!patterns) return [];
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

interface WalkResult {
  files: FileEntry[];
  visitedDirectories: number;
  visitedEntries: number;
  scannedBytes: number;
  directoryLimitHit: boolean;
  entryLimitHit: boolean;
  byteLimitHit: boolean;
  aborted: boolean;
}

function lineCount(source: string): number {
  let lines = 1;
  let offset = 0;
  while ((offset = source.indexOf('\n', offset)) !== -1) {
    lines++;
    offset++;
  }
  return lines;
}

function readBoundedSource(path: string, remainingBytes: number): { source: string; bytes: number } | undefined {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size > remainingBytes) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    // A file that grew after fstat must not bypass either the per-file or
    // aggregate memory ceiling.
    if (bytes > stat.size || bytes > remainingBytes) return undefined;
    return { source: buffer.subarray(0, bytes).toString('utf8'), bytes };
  } finally {
    closeSync(fd);
  }
}

/** Iterative and streaming: never recurse or materialize/sort an unbounded directory listing. */
function walk(root: string, depth: number, signal?: AbortSignal): WalkResult {
  const files: FileEntry[] = [];
  const pending: { dir: string; depthLeft: number }[] = [{ dir: root, depthLeft: depth }];
  let scheduledDirectories = 1;
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let scannedBytes = 0;
  let directoryLimitHit = false;
  let entryLimitHit = false;
  let byteLimitHit = false;
  let aborted = signal?.aborted === true;

  while (
    pending.length > 0 &&
    files.length < MAX_FILES &&
    visitedDirectories < MAP_MAX_VISITED_DIRECTORIES &&
    visitedEntries < MAP_MAX_DIRECTORY_ENTRIES &&
    !byteLimitHit &&
    !aborted
  ) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const current = pending.pop()!;
    visitedDirectories++;
    let directory;
    try {
      directory = opendirSync(current.dir);
    } catch {
      continue;
    }
    try {
      while (files.length < MAX_FILES && visitedEntries < MAP_MAX_DIRECTORY_ENTRIES) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        const entry = directory.readSync();
        if (!entry) break;
        visitedEntries++;
        const name = entry.name;
        if (name.startsWith('.') && name !== '.') continue;
        const full = join(current.dir, name);
        let stat;
        try {
          // Never follow directory/file symlinks while walking. Besides preventing
          // workspace escapes, this avoids cycles and duplicate source trees.
          stat = lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (current.depthLeft > 0 && !SKIP_DIRS.has(name)) {
            if (scheduledDirectories >= MAP_MAX_VISITED_DIRECTORIES) {
              directoryLimitHit = true;
            } else {
              pending.push({ dir: full, depthLeft: current.depthLeft - 1 });
              scheduledDirectories++;
            }
          }
          continue;
        }
        const ext = extname(name).toLowerCase();
        if (!(ext in EXTRACTORS) || stat.size > MAX_FILE_BYTES) continue;
        if (stat.size > MAP_MAX_SCANNED_BYTES - scannedBytes) {
          byteLimitHit = true;
          break;
        }
        let bounded: { source: string; bytes: number } | undefined;
        try {
          bounded = readBoundedSource(full, MAP_MAX_SCANNED_BYTES - scannedBytes);
        } catch {
          continue;
        }
        if (!bounded) {
          byteLimitHit = true;
          break;
        }
        scannedBytes += bounded.bytes;
        const source = bounded.source;
        files.push({ relPath: relative(root, full), lines: lineCount(source), symbols: symbolsOf(source, ext) });
      }
    } finally {
      directory.closeSync();
    }
  }

  if (visitedEntries >= MAP_MAX_DIRECTORY_ENTRIES) entryLimitHit = true;
  if (pending.length > 0 && visitedDirectories >= MAP_MAX_VISITED_DIRECTORIES) directoryLimitHit = true;
  return {
    files,
    visitedDirectories,
    visitedEntries,
    scannedBytes,
    directoryLimitHit,
    entryLimitHit,
    byteLimitHit,
    aborted,
  };
}

export const mapTool: Tool = {
  name: 'map',
  description:
    'Map the code structure: source files with line counts and top-level symbols. Use it to orient before searching or reading.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'workspace-relative subtree (default: cwd)' },
      depth: { type: 'number', description: 'directory depth (default 4)' },
    },
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const root = resolveWorkspacePath(
      context,
      typeof args['path'] === 'string' && args['path'].length > 0 ? requireString(args, 'path') : '.',
    );
    if (!statSync(root).isDirectory()) return textOutput(`map requires a directory: ${root}`, true);
    const depth = typeof args['depth'] === 'number' && args['depth'] > 0 ? Math.floor(args['depth']) : 4;
    const traversal = walk(root, depth, context.signal);
    const { files } = traversal;
    const capNotes: string[] = [];
    if (files.length >= MAX_FILES) capNotes.push(`capped at ${MAX_FILES} files; map a subtree via path`);
    if (traversal.directoryLimitHit) {
      capNotes.push(`capped at ${MAP_MAX_VISITED_DIRECTORIES} visited directories; map a subtree or lower depth`);
    }
    if (traversal.entryLimitHit) {
      capNotes.push(`capped at ${MAP_MAX_DIRECTORY_ENTRIES} directory entries; map a subtree`);
    }
    if (traversal.byteLimitHit) {
      capNotes.push(`capped at ${MAP_MAX_SCANNED_BYTES} scanned source bytes; map a subtree`);
    }
    if (traversal.aborted) capNotes.push('map canceled before traversal completed');
    if (files.length === 0) {
      const notes = capNotes.map((note) => `\n[${note}]`).join('');
      return textOutput(`no recognized source files under ${root} (depth ${depth})${notes}`);
    }

    const rendered = files.map((file) => {
      const symbols =
        file.symbols.length === 0
          ? ''
          : `: ${file.symbols.slice(0, MAX_SYMBOLS_PER_FILE).join(', ')}${file.symbols.length > MAX_SYMBOLS_PER_FILE ? ` +${file.symbols.length - MAX_SYMBOLS_PER_FILE} more` : ''}`;
      return `${file.relPath} (${file.lines}L)${symbols}`;
    });
    let text = rendered.join('\n');
    let note = capNotes.map((capNote) => `\n[${capNote}]`).join('');
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS);
      note += `\n[truncated at ${MAX_OUTPUT_CHARS} chars; map a subtree via path or lower depth]`;
    }
    return textOutput(text + note);
  },
};
