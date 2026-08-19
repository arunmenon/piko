import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from 'node:fs';
import { assertRegularFile, atomicWriteTextFile, resolveWorkspacePath, ToolPolicyError } from './filesystem.js';
import { requireString, requireStringAllowEmpty, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

/** Keep edit's input/output ceiling aligned with the read tool's text-file ceiling. */
export const EDIT_MAX_FILE_BYTES = 10_000_000;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = haystack.indexOf(needle, offset);
    if (match === -1) return count;
    count++;
    offset = match + needle.length;
  }
}

interface FileSnapshot {
  content: string;
  stat: Stats;
}

/**
 * Read only the descriptor that was checked. The extra byte detects growth
 * without allowing readFileSync to chase a concurrently growing regular file.
 */
function readBoundedRegularFile(path: string, preOpenStat: Stats): FileSnapshot {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new ToolPolicyError(`edit requires a regular file: ${path}`);
    if (before.dev !== preOpenStat.dev || before.ino !== preOpenStat.ino) {
      throw new ToolPolicyError(`edit target changed before it could be opened: ${path}`);
    }
    if (before.size > EDIT_MAX_FILE_BYTES) {
      throw new ToolPolicyError(
        `file too large to edit (${before.size} bytes, max ${EDIT_MAX_FILE_BYTES}): ${path}`,
      );
    }

    const capacity = Math.min(EDIT_MAX_FILE_BYTES + 1, before.size + 1);
    const buffer = Buffer.allocUnsafe(capacity);
    let offset = 0;
    while (offset < capacity) {
      const bytesRead = readSync(descriptor, buffer, offset, capacity - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > EDIT_MAX_FILE_BYTES) {
      throw new ToolPolicyError(`file grew beyond the ${EDIT_MAX_FILE_BYTES}-byte edit limit: ${path}`);
    }

    const after = fstatSync(descriptor);
    if (!after.isFile()) throw new ToolPolicyError(`edit requires a regular file: ${path}`);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      offset !== before.size
    ) {
      throw new ToolPolicyError(`edit target changed while it was being read: ${path}`);
    }
    return { content: buffer.subarray(0, offset).toString('utf8'), stat: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace old_text with new_text in a workspace-relative file. Match exactly and uniquely unless replace_all.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'workspace-relative path' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_text', 'new_text'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const requestedPath = requireString(args, 'path');
    const path = resolveWorkspacePath(context, requestedPath);
    const preOpenStat = assertRegularFile(path, 'edit')!;
    if (preOpenStat.size > EDIT_MAX_FILE_BYTES) {
      return textOutput(
        `file too large to edit (${preOpenStat.size} bytes, max ${EDIT_MAX_FILE_BYTES}): ${requestedPath}`,
        true,
      );
    }
    const oldText = requireString(args, 'old_text');
    const newText = requireStringAllowEmpty(args, 'new_text'); // '' is a legitimate deletion
    const snapshot = readBoundedRegularFile(path, preOpenStat);
    const original = snapshot.content;
    const occurrences = countOccurrences(original, oldText);
    if (occurrences === 0) {
      return textOutput(`old_text not found in ${path} — read the file and match exactly, including whitespace`, true);
    }
    if (occurrences > 1 && args['replace_all'] !== true) {
      return textOutput(`old_text matches ${occurrences} times in ${path} — extend it to be unique or set replace_all`, true);
    }
    const originalBytes = Buffer.byteLength(original);
    const projectedBytes =
      originalBytes + occurrences * (Buffer.byteLength(newText) - Buffer.byteLength(oldText));
    if (!Number.isSafeInteger(projectedBytes) || projectedBytes > EDIT_MAX_FILE_BYTES) {
      return textOutput(
        `edit output would be too large (${projectedBytes} bytes, max ${EDIT_MAX_FILE_BYTES})`,
        true,
      );
    }
    const updated =
      args['replace_all'] === true
        ? original.replaceAll(oldText, () => newText)
        : `${original.slice(0, original.indexOf(oldText))}${newText}${original.slice(original.indexOf(oldText) + oldText.length)}`;
    const current = assertRegularFile(path, 'edit')!;
    if (!sameSnapshot(snapshot.stat, current)) {
      return textOutput(`edit target changed before replacement could be committed: ${requestedPath}`, true);
    }
    atomicWriteTextFile(path, updated);
    return textOutput(`edited ${requestedPath} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`);
  },
};
