import { bashTool } from './bash.js';
export { workspaceDigestFor, WORKSPACE_DIGEST_TIMEOUT_MS, type WorkspaceDigestOptions } from './bash.js';
import { editTool } from './edit.js';
import { mapTool } from './map.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import type { Tool } from './types.js';

export * from './types.js';
export * from './approval-rules.js';
export * from './filesystem.js';
export * from './validation.js';
export { readTool, writeTool, editTool, bashTool, mapTool };
export { DEPTH_ENVIRONMENT_NAME, readProcessDepth } from './bash.js';

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, mapTool];
}

/** Identity, not name: the five implementations the sandbox worker also hosts. */
const BUILT_IN_TOOLS: ReadonlySet<Tool> = new Set<Tool>([readTool, writeTool, editTool, bashTool, mapTool]);

/**
 * Whether this is one of piko's own tool implementations. The sandbox executor
 * routes exactly these, because the worker hosts exactly these; an extension
 * tool that happened to be named `read` is trusted controller code (ADR 0012)
 * and keeps running in the parent process.
 */
export function isBuiltInTool(tool: Tool): boolean {
  return BUILT_IN_TOOLS.has(tool);
}
