import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { trimTrailingSurrogate } from '../truncate.js';
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

export const readTool: Tool = {
  name: 'read',
  description: 'Read a file (text or image). For large files use offset (1-based line) and limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number', description: '1-based start line' },
      limit: { type: 'number', description: 'max lines' },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const path = resolve(context.cwd, requireString(args, 'path'));
    const stat = statSync(path);
    if (stat.isDirectory()) return textOutput(`${path} is a directory`, true);

    const mime = IMAGE_MIME[extname(path).toLowerCase()];
    if (mime) {
      if (stat.size > MAX_IMAGE_BYTES) return textOutput(`image too large (${stat.size} bytes, max ${MAX_IMAGE_BYTES})`, true);
      return { content: [{ type: 'image', mimeType: mime, data: readFileSync(path).toString('base64') }] };
    }

    if (stat.size > MAX_TEXT_BYTES) {
      return textOutput(
        `file too large (${stat.size} bytes) — page it with bash instead, e.g. sed -n '1,200p' "${path}" or rg`,
        true,
      );
    }
    const lines = readFileSync(path, 'utf8').split('\n');
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
