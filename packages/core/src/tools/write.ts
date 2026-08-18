import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireString, requireStringAllowEmpty, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

export const writeTool: Tool = {
  name: 'write',
  description: 'Create or overwrite a file, creating parent directories as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const path = resolve(context.cwd, requireString(args, 'path'));
    // a non-string here must error, not silently truncate an existing file to ''
    const content = requireStringAllowEmpty(args, 'content');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return textOutput(`wrote ${Buffer.byteLength(content)} bytes to ${path}`);
  },
};
