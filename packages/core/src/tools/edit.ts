import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireString, requireStringAllowEmpty, textOutput, type Tool, type ToolContext, type ToolOutput } from './types.js';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace old_text with new_text in a file. old_text must match exactly (whitespace included) and be unique unless replace_all.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_text', 'new_text'],
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
    const path = resolve(context.cwd, requireString(args, 'path'));
    const oldText = requireString(args, 'old_text');
    const newText = requireStringAllowEmpty(args, 'new_text'); // '' is a legitimate deletion
    const original = readFileSync(path, 'utf8');
    const occurrences = countOccurrences(original, oldText);
    if (occurrences === 0) {
      return textOutput(`old_text not found in ${path} — read the file and match exactly, including whitespace`, true);
    }
    if (occurrences > 1 && args['replace_all'] !== true) {
      return textOutput(`old_text matches ${occurrences} times in ${path} — extend it to be unique or set replace_all`, true);
    }
    const updated =
      args['replace_all'] === true
        ? original.split(oldText).join(newText)
        : original.replace(oldText, () => newText);
    writeFileSync(path, updated, 'utf8');
    return textOutput(`edited ${path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`);
  },
};
