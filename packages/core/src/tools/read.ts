import { closeSync, constants, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { extname } from 'node:path';
import { trimTrailingSurrogate } from '../truncate.js';
import { resolveWorkspacePath } from './filesystem.js';
import { requireString, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_LINES = 2000;
const MAX_CHARS = 50_000;
// 3.5MB raw stays under the 5MB per-image API cap after base64 expansion (~4/3)
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_TEXT_BYTES = 10_000_000;

function readBoundedFile(path: string, expected: Stats, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size > maxBytes
    ) {
      throw new Error(`read target changed or exceeds the ${maxBytes}-byte limit: ${path}`);
    }
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd);
    if (
      bytes !== before.size ||
      bytes > maxBytes ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`read target changed while it was being read: ${path}`);
    }
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

export const readTool: Tool = {
  name: 'read',
  description: 'Read a workspace-relative file (text or image). For large files use offset (1-based line) and limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      offset: { type: 'number', description: '1-based start line' },
      limit: { type: 'number', description: 'max lines' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const requestedPath = requireString(args, 'path');
    const path = resolveWorkspacePath(context, requestedPath);
    const stat = statSync(path);
    if (stat.isDirectory()) return textOutput(`${path} is a directory`, true);
    if (!stat.isFile()) return textOutput(`read requires a regular file: ${path}`, true);

    const mime = IMAGE_MIME[extname(path).toLowerCase()];
    if (mime) {
      if (stat.size > MAX_IMAGE_BYTES) return textOutput(`image too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES})`, true);
      return { content: [{ type: 'image', mimeType: mime, data: readBoundedFile(path, stat, MAX_IMAGE_BYTES).toString('base64') }] };
    }

    if (stat.size > MAX_TEXT_BYTES) {
      return textOutput(
        `file too large (${stat.size} bytes) — split it first, or page it with an explicitly enabled isolated/host shell`,
        true,
      );
    }
    const lines = readBoundedFile(path, stat, MAX_TEXT_BYTES).toString('utf8').split('\n');
    const offset = typeof args['offset'] === 'number' && args['offset'] > 0 ? Math.floor(args['offset']) : 1;
    const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.floor(args['limit']) : MAX_LINES;
    const end = Math.min(offset - 1 + limit, lines.length, offset - 1 + MAX_LINES);
    let slice = lines.slice(offset - 1, end).join('\n');
    let note = '';
    if (slice.length > MAX_CHARS) {
      slice = trimTrailingSurrogate(slice.slice(0, MAX_CHARS));
      note = `\n[truncated at ${MAX_CHARS} chars]`;
    }
    if (offset > 1 || end < lines.length) {
      note += `\n[showing lines ${offset}-${end} of ${lines.length}]`;
    }
    return textOutput(slice + note);
  },
};
