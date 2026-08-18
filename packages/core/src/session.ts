import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { addUsage, emptyUsage, type Message, type Usage } from '@pi/ai';

export type SessionEntry =
  | { t: 'meta'; v: 1; id: string; cwd: string; model: string; created: string }
  | { t: 'msg'; message: Message }
  | { t: 'usage'; usage: Usage };

export function sessionsDirFor(cwd: string): string {
  // hash suffix disambiguates slug collisions ("/a/b-c" vs "/a/b/c" both slug to "-a-b-c")
  const slug = cwd.replace(/[/\\:]/g, '-');
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return join(homedir(), '.pi', 'sessions', `${slug}-${hash}`);
}

export function latestSessionFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files: { file: string; mtime: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      files.push({ file, mtime: statSync(file).mtimeMs });
    } catch {
      /* deleted concurrently */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file;
}

/**
 * Best-effort advisory lock so two `pi -c` processes don't interleave writes into one
 * JSONL. Returns a release function, or undefined when another live process holds it.
 */
export function tryLockSession(file: string): (() => void) | undefined {
  const lockPath = `${file}.lock`;
  const take = (flag: string): boolean => {
    try {
      writeFileSync(lockPath, String(process.pid), { flag });
      return true;
    } catch {
      return false;
    }
  };
  if (!take('wx')) {
    try {
      const holder = Number(readFileSync(lockPath, 'utf8'));
      process.kill(holder, 0); // throws if the holder is dead
      return undefined; // alive — genuinely locked
    } catch {
      if (!take('w')) return undefined; // stale lock — take over
    }
  }
  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
  return release;
}

function newSessionId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${stamp}-${suffix}`;
}

/** Append-only JSONL: every byte sent to or received from the model is inspectable. */
export class Session {
  private constructor(
    readonly file: string,
    readonly id: string,
    private readonly entries: SessionEntry[],
  ) {}

  static create(cwd: string, model: string, dir = sessionsDirFor(cwd)): Session {
    mkdirSync(dir, { recursive: true });
    const id = newSessionId();
    const file = join(dir, `${id}.jsonl`);
    const meta: SessionEntry = { t: 'meta', v: 1, id, cwd, model, created: new Date().toISOString() };
    writeFileSync(file, `${JSON.stringify(meta)}\n`, 'utf8');
    return new Session(file, id, [meta]);
  }

  static open(file: string): Session {
    // a partial trailing line is expected after a crash — skip bad lines, never refuse to open
    const entries: SessionEntry[] = [];
    let skipped = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) process.stderr.write(`warning: skipped ${skipped} corrupt line(s) in ${file}\n`);
    const meta = entries.find((entry) => entry.t === 'meta');
    return new Session(file, meta?.t === 'meta' ? meta.id : 'unknown', entries);
  }

  /** New session containing entries up to and including message index `atMessage` (0-based). */
  branch(atMessage: number, cwd: string, model: string): Session {
    const branched = Session.create(cwd, model, dirname(this.file));
    let messageIndex = -1;
    for (const entry of this.entries) {
      if (entry.t === 'meta') continue;
      if (entry.t === 'msg') {
        messageIndex++;
        if (messageIndex > atMessage) break;
      }
      branched.append(entry);
    }
    return branched;
  }

  append(entry: SessionEntry): void {
    this.entries.push(entry);
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  get messages(): Message[] {
    return this.entries.filter((entry): entry is Extract<SessionEntry, { t: 'msg' }> => entry.t === 'msg').map((entry) => entry.message);
  }

  get usage(): Usage {
    const total = emptyUsage();
    for (const entry of this.entries) {
      if (entry.t === 'usage') addUsage(total, entry.usage);
    }
    return total;
  }

  get meta(): Extract<SessionEntry, { t: 'meta' }> | undefined {
    const entry = this.entries.find((item) => item.t === 'meta');
    return entry?.t === 'meta' ? entry : undefined;
  }
}
