import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool } from '@pi/core';

/**
 * An extension module default-exports Tool[], { tools: Tool[] }, or a function
 * returning either. Extensions are loaded only when listed explicitly (--ext or
 * config "extensions") — never auto-discovered, so fixed context stays predictable.
 */
export async function loadExtensions(paths: string[], cwd: string): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const path of paths) {
    const module = (await import(pathToFileURL(resolve(cwd, path)).href)) as { default?: unknown };
    let exported = module.default;
    if (typeof exported === 'function') exported = await (exported as () => unknown)();
    const list = Array.isArray(exported) ? exported : (exported as { tools?: unknown })?.tools;
    if (!Array.isArray(list)) throw new Error(`extension ${path}: default export must be Tool[] or { tools: Tool[] }`);
    tools.push(...(list as Tool[]));
  }
  return tools;
}
