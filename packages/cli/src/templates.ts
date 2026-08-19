import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const TEMPLATE_MAX_DIRECTORY_ENTRIES = 256;
export const TEMPLATE_MAX_FILE_BYTES = 64 * 1024;
export const TEMPLATE_MAX_TOTAL_BYTES = 512 * 1024;

export interface PromptTemplate {
  name: string;
  body: string;
  source: string;
}

export interface LoadTemplatesOptions {
  /** Repository-owned templates are executable prompt input, so loading them is opt-in. */
  readonly trustProject?: boolean;
  /** Primarily useful to embedders and tests; defaults to ~/.agent/commands. */
  readonly globalDirectory?: string;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFile(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Read one stable regular file without following a final symlink. Invalid files are optional and skipped. */
function readTemplateFile(path: string, remainingBytes: number): { body: string; bytes: number } | undefined {
  let requested: Stats;
  try {
    requested = lstatSync(path);
  } catch {
    return undefined;
  }
  if (
    !requested.isFile() ||
    !Number.isSafeInteger(requested.size) ||
    requested.size < 0 ||
    requested.size > TEMPLATE_MAX_FILE_BYTES ||
    requested.size > remainingBytes
  ) {
    return undefined;
  }

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      !sameFile(requested, before) ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > TEMPLATE_MAX_FILE_BYTES ||
      before.size > remainingBytes
    ) {
      return undefined;
    }

    // The extra byte detects growth after fstat without allocating from an attacker-controlled size.
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || !stableFile(before, after)) return undefined;
    return { body: buffer.subarray(0, offset).toString('utf8'), bytes: offset };
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

function templateDirectory(requested: string, projectRoot?: string): string | undefined {
  try {
    // Reject a symlink at the directory boundary. For projects, canonical containment also
    // rejects an intermediate .agent symlink that points outside the trusted workspace.
    if (!lstatSync(requested).isDirectory()) return undefined;
    const directory = realpathSync(requested);
    if (projectRoot !== undefined && !isInside(projectRoot, directory)) return undefined;
    return directory;
  } catch {
    return undefined;
  }
}

function loadTemplateDirectory(
  requestedDirectory: string,
  templates: Map<string, PromptTemplate>,
  budget: { retainedBytes: number; templateBytes: Map<string, number> },
  projectRoot?: string,
): void {
  const directory = templateDirectory(requestedDirectory, projectRoot);
  if (!directory) return;

  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(directory);
  } catch {
    return;
  }
  try {
    const candidates: string[] = [];
    let visited = 0;
    while (visited < TEMPLATE_MAX_DIRECTORY_ENTRIES) {
      const entry = opened.readSync();
      if (!entry) break;
      visited++;
      if (!entry.name.endsWith('.md') || entry.name === '.md') continue;
      candidates.push(entry.name);
    }

    // The candidate array is capped, retaining deterministic ordering without an unbounded listing.
    candidates.sort();
    for (const file of candidates) {
      const name = file.slice(0, -'.md'.length);
      const previousBytes = budget.templateBytes.get(name) ?? 0;
      const availableBytes = TEMPLATE_MAX_TOTAL_BYTES - budget.retainedBytes + previousBytes;
      const source = join(directory, file);
      const loaded = readTemplateFile(source, availableBytes);
      if (!loaded) continue;
      templates.set(name, { name, body: loaded.body, source });
      budget.retainedBytes += loaded.bytes - previousBytes;
      budget.templateBytes.set(name, loaded.bytes);
    }
  } finally {
    opened.closeSync();
  }
}

/**
 * Global templates are always available. Repository templates are loaded only
 * after an explicit trust decision and then override equal-named global entries.
 */
export function loadTemplates(cwd: string, options: LoadTemplatesOptions = {}): Map<string, PromptTemplate> {
  const templates = new Map<string, PromptTemplate>();
  const budget = { retainedBytes: 0, templateBytes: new Map<string, number>() };
  const globalDirectory = options.globalDirectory ?? join(homedir(), '.agent', 'commands');
  loadTemplateDirectory(globalDirectory, templates, budget);

  if (options.trustProject) {
    try {
      const projectRoot = realpathSync(resolve(cwd));
      loadTemplateDirectory(join(projectRoot, '.agent', 'commands'), templates, budget, projectRoot);
    } catch {
      // A missing or concurrently removed working directory simply has no project templates.
    }
  }
  return templates;
}

export function interpolate(template: PromptTemplate, argumentText: string): string {
  // replacer function: a plain string replacement would interpret $&, $`, $' and $$
  // inside the user's arguments (sed/regex/shell snippets are natural inputs here)
  return template.body.replaceAll('$ARGUMENTS', () => argumentText);
}
