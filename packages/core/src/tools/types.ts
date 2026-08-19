import type { ImageBlock, TextBlock } from '@pi/ai';
import { resolve } from 'node:path';

export interface ToolOutput {
  content: (TextBlock | ImageBlock)[];
  isError?: boolean;
}

/**
 * Environment configuration for the host bash executor. The executor starts
 * from a small allowlist; callers must explicitly opt additional variables in.
 */
export interface BashExecutionPolicy {
  /**
   * Permit spawning bash directly on the host. When a ToolExecutionPolicy is
   * present this must be explicitly true; omission is fail-closed. A host shell
   * is not a filesystem or network sandbox.
   */
  readonly allowHostExecution?: boolean;
  /** Additional names to copy from the parent process environment. */
  readonly inheritEnvironment?: readonly string[];
  /** Explicit variables to add/override. `undefined` removes a default variable. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Security policy shared by the built-in tools. */
export interface ToolExecutionPolicy {
  /**
   * Stable workspace boundary. Integrations should set this once, independently
   * of the mutable working directory. It defaults to the current cwd for
   * backwards-compatible direct tool use.
   */
  readonly workspaceRoot?: string;
  /**
   * Permit absolute tool arguments when they still resolve inside workspaceRoot.
   * Relative paths are the secure default.
   */
  readonly allowAbsolutePaths?: boolean;
  readonly bash?: BashExecutionPolicy;
}

/** Build the default, workspace-confined policy for an agent/tool context. */
export function defaultToolExecutionPolicy(workspaceRoot: string): ToolExecutionPolicy {
  return { workspaceRoot: resolve(workspaceRoot), bash: { allowHostExecution: false } };
}

export interface ToolContext {
  readonly cwd: string;
  setCwd(dir: string): void;
  /** aborted when the user interrupts the turn — long-running tools must honor it */
  signal?: AbortSignal;
  /** Optional execution policy. File tools stay cwd-confined; host bash requires an explicit allow policy. */
  readonly policy?: ToolExecutionPolicy;
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
