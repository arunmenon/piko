import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import type { Tool } from './types.js';

export * from './types.js';
export { readTool, writeTool, editTool, bashTool };

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool];
}
