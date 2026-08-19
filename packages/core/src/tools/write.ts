import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertRegularFile, atomicWriteTextFile, resolveWorkspacePath } from './filesystem.js';
import { requireString, requireStringAllowEmpty, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

export const writeTool: Tool = {
  name: 'write',
  description: 'Create or overwrite a workspace-relative file, creating parent directories as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const requestedPath = requireString(args, 'path');
    // a non-string here must error, not silently truncate an existing file to ''
    const content = requireStringAllowEmpty(args, 'content');
    let path = resolveWorkspacePath(context, requestedPath, { mustExist: false });
    assertRegularFile(path, 'write', true);
    mkdirSync(dirname(path), { recursive: true });
    // Re-resolve after directory creation so a concurrently introduced symlink
    // cannot redirect the final write outside the workspace.
    path = resolveWorkspacePath(context, requestedPath, { mustExist: false });
    atomicWriteTextFile(path, content);
    return textOutput(`wrote ${Buffer.byteLength(content)} bytes to ${requestedPath}`);
  },
};
