import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { EDIT_MAX_FILE_BYTES } from './edit.js';
import {
  assertRegularFile,
  atomicWriteTextFile,
  resolveWorkspacePath,
  runContainmentBarrier,
} from './filesystem.js';
import { requireString, requireStringAllowEmpty, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

/**
 * The precondition hash reads a whole file, so it is bounded by the same
 * 10 MB text-file ceiling read and edit enforce. A larger file is refused
 * before any of it is read.
 */
export const WRITE_MAX_PRECONDITION_BYTES = EDIT_MAX_FILE_BYTES;
/** Fixed staging buffer: the hash never holds more than this at once. */
const PRECONDITION_HASH_CHUNK_BYTES = 64 * 1024;

/**
 * Hash the file behind a descriptor in fixed-size chunks, refusing anything
 * over the ceiling before reading it. Returns undefined when the file is too
 * large or is no longer a regular file, which the caller turns into a refusal.
 */
function boundedFileSha256(path: string): string | undefined {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > WRITE_MAX_PRECONDITION_BYTES) return undefined;
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(PRECONDITION_HASH_CHUNK_BYTES);
    let hashedBytes = 0;
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hashedBytes += bytesRead;
      // A file that grows under the read must not slip past the ceiling.
      if (hashedBytes > WRITE_MAX_PRECONDITION_BYTES) return undefined;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Compare a caller-supplied precondition hash against the bytes on disk
 * (ADR 0007). Returns a refusal message, or undefined when the write may
 * proceed. This is a stale-at-check-time precondition, not a compare-and-swap:
 * it catches a file that moved before the call, and a writer that lands between
 * this check and the rename is still overwritten.
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
  if (existing.size > WRITE_MAX_PRECONDITION_BYTES) {
    return `expected_sha256 cannot be checked for ${requestedPath}: it is ${existing.size} bytes, over the ${WRITE_MAX_PRECONDITION_BYTES}-byte limit for the precondition hash`;
  }
  const actualSha256 = boundedFileSha256(path);
  if (actualSha256 === undefined) {
    return `expected_sha256 cannot be checked for ${requestedPath}: it is not a regular file under the ${WRITE_MAX_PRECONDITION_BYTES}-byte limit for the precondition hash`;
  }
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
    runContainmentBarrier('before-mkdir', dirname(path));
    mkdirSync(dirname(path), { recursive: true });
    // Re-resolve after directory creation so a concurrently introduced symlink
    // cannot redirect the final write outside the workspace or onto a protected path.
    path = resolveWorkspacePath(context, requestedPath, { mustExist: false, forMutation: true });
    atomicWriteTextFile(path, content);
    return textOutput(`wrote ${Buffer.byteLength(content)} bytes to ${requestedPath}`);
  },
};
