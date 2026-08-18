import type { ImageBlock, TextBlock } from '@pi/ai';

export interface ToolOutput {
  content: (TextBlock | ImageBlock)[];
  isError?: boolean;
}

export interface ToolContext {
  readonly cwd: string;
  setCwd(dir: string): void;
  /** aborted when the user interrupts the turn — long-running tools must honor it */
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for arguments — kept terse; every word here is paid on every request */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>;
}

export function textOutput(text: string, isError = false): ToolOutput {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
}

/** like requireString but permits '' — for content fields where empty is legitimate */
export function requireStringAllowEmpty(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`argument "${key}" must be a string (got ${value === null ? 'null' : typeof value})`);
  }
  return value;
}
