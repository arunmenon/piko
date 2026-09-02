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
