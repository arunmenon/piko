import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { assertRegularFile, atomicWriteTextFile, resolveWorkspacePath } from './filesystem.js';
import { requireString, requireStringAllowEmpty, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

/**
 * Compare a caller-supplied precondition hash against the bytes on disk
 * (ADR 0007). Returns a refusal message, or undefined when the write may
 * proceed. A resumed run whose outcome is unknown uses this to avoid
 * clobbering a file that moved since it planned the write.
 */
function preconditionFailure(
  path: string,
  requestedPath: string,
  existing: Stats | undefined,
  expectedSha256: string,
): string | undefined {
  if (!existing) {
    return `expected_sha256 was given but ${requestedPath} does not exist, so read the current state before writing it`;
  }
  const actualSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actualSha256.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
    return `expected_sha256 mismatch for ${requestedPath}: expected ${expectedSha256}, found ${actualSha256}. The file changed, so read it again before overwriting.`;
  }
  return undefined;
}

export const writeTool: Tool = {
  name: 'write',
  description: 'Create or overwrite a workspace-relative file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      expected_sha256: { type: 'string', description: 'sha256 of current content' },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const requestedPath = requireString(args, 'path');
    // a non-string here must error, not silently truncate an existing file to ''
    const content = requireStringAllowEmpty(args, 'content');
    let path = resolveWorkspacePath(context, requestedPath, { mustExist: false, forMutation: true });
    const existing = assertRegularFile(path, 'write', true);
    if (args['expected_sha256'] !== undefined) {
      const expectedSha256 = requireString(args, 'expected_sha256');
      const refusal = preconditionFailure(path, requestedPath, existing, expectedSha256);
      if (refusal) return textOutput(refusal, true);
    }
    mkdirSync(dirname(path), { recursive: true });
    // Re-resolve after directory creation so a concurrently introduced symlink
    // cannot redirect the final write outside the workspace or onto a protected path.
    path = resolveWorkspacePath(context, requestedPath, { mustExist: false, forMutation: true });
    atomicWriteTextFile(path, content);
    return textOutput(`wrote ${Buffer.byteLength(content)} bytes to ${requestedPath}`);
  },
};
