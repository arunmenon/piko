import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { mapTool } from './map.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import type { Tool } from './types.js';

export * from './types.js';
export { readTool, writeTool, editTool, bashTool, mapTool };

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, mapTool];
}
