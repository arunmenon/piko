import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateToolSet, type Tool, type ToolValidationOptions } from '@pi/core';

const TYPESCRIPT_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export interface LoadExtensionsOptions {
  /** Maximum aggregate provider-visible schema size for the loaded extensions. */
  readonly maxSchemaBytes?: ToolValidationOptions['maxSchemaBytes'];
}

/**
 * An extension module default-exports Tool[], { tools: Tool[] }, or a function
 * returning either. Extensions are loaded only when listed explicitly (--ext or
 * config "extensions") — never auto-discovered, so fixed context stays predictable.
 */
export async function loadExtensions(
  paths: readonly string[],
  cwd: string,
  options: LoadExtensionsOptions = {},
): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const path of paths) {
    const resolved = resolve(cwd, path);
    if (TYPESCRIPT_SOURCE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
      throw new Error(
        `extension ${path}: TypeScript source files are not portable on the supported Node.js 20 runtime; compile the extension to .js, .mjs, or .cjs first`,
      );
    }

    let module: { default?: unknown };
    try {
      module = (await import(pathToFileURL(resolved).href)) as { default?: unknown };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`extension ${path}: failed to load: ${detail}`, { cause: error });
    }
    let exported = module.default;
    if (typeof exported === 'function') exported = await (exported as () => unknown)();
    const list = Array.isArray(exported) ? exported : (exported as { tools?: unknown })?.tools;
    if (!Array.isArray(list)) throw new Error(`extension ${path}: default export must be Tool[] or { tools: Tool[] }`);
    tools.push(
      ...validateToolSet(list, {
        maxSchemaBytes: options.maxSchemaBytes,
        source: `extension ${path}`,
      }),
    );
  }
  return validateToolSet(tools, { maxSchemaBytes: options.maxSchemaBytes, source: 'extensions' });
}

export interface ExtensionSources {
  /** Paths declared by the trusted user config file. */
  readonly configPaths: readonly string[];
  readonly configFile: string;
  /** Paths supplied explicitly on this CLI invocation. */
  readonly cliPaths: readonly string[];
  readonly cwd: string;
}

/**
 * Config-relative paths must never inherit an untrusted project cwd. Explicit
 * --ext paths intentionally remain cwd-relative because the user supplied them
 * for this invocation. Absolute paths preserve their normal meaning in either.
 */
export async function loadConfiguredExtensions(
  sources: ExtensionSources,
  options: LoadExtensionsOptions = {},
): Promise<Tool[]> {
  const configTools = await loadExtensions(sources.configPaths, dirname(resolve(sources.configFile)), options);
  const cliTools = await loadExtensions(sources.cliPaths, sources.cwd, options);
  return validateToolSet([...configTools, ...cliTools], {
    maxSchemaBytes: options.maxSchemaBytes,
    source: 'configured extensions',
  });
}
