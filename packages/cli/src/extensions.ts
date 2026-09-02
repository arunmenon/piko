import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateToolSet, type Tool, type ToolValidationOptions } from '@pi/core';

const TYPESCRIPT_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
/** `<path>@sha256:<64 hex>`; only a full-length digest suffix is read as a pin, so
 *  an `@` inside an ordinary path (a scoped package directory) stays part of it. */
const PIN_SUFFIX = /@sha256:([0-9a-fA-F]{64})$/;

export interface LoadExtensionsOptions {
  /** Maximum aggregate provider-visible schema size for the loaded extensions. */
  readonly maxSchemaBytes?: ToolValidationOptions['maxSchemaBytes'];
}

/** What was actually loaded from one `--ext` argument, for the journal (ADR 0012). */
export interface LoadedExtension {
  /** The path as written, with any pin suffix removed. */
  readonly path: string;
  /** SHA-256 of the file bytes that were imported, lowercase hex. */
  readonly sha256: string;
  readonly toolNames: readonly string[];
  /** True when the caller supplied a digest and it matched. */
  readonly pinned: boolean;
}

export interface ExtensionLoadResult {
  readonly tools: Tool[];
  readonly extensions: readonly LoadedExtension[];
}

interface ExtensionRequest {
  readonly path: string;
  readonly expectedDigest?: string;
}

/** Split `<path>@sha256:<hex>` into its parts; a bare path pins nothing. */
export function parseExtensionRequest(argument: string): ExtensionRequest {
  const match = PIN_SUFFIX.exec(argument);
  if (!match) return { path: argument };
  return {
    path: argument.slice(0, argument.length - match[0].length),
    expectedDigest: match[1]!.toLowerCase(),
  };
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
): Promise<ExtensionLoadResult> {
  const tools: Tool[] = [];
  const extensions: LoadedExtension[] = [];
  for (const argument of paths) {
    const { path, expectedDigest } = parseExtensionRequest(argument);
    const resolved = resolve(cwd, path);
    if (TYPESCRIPT_SOURCE_EXTENSIONS.has(extname(resolved).toLowerCase())) {
      throw new Error(
        `extension ${path}: TypeScript source files are not portable on the supported Node.js 20 runtime; compile the extension to .js, .mjs, or .cjs first`,
      );
    }

    // Hash the bytes before the import so a mismatched pin refuses to start
    // rather than refusing after the module's top level has already run.
    let sha256: string;
    try {
      sha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`extension ${path}: cannot read the module to hash it: ${detail}`, { cause: error });
    }
    if (expectedDigest !== undefined && sha256 !== expectedDigest) {
      throw new Error(
        `extension ${path}: sha256 pin mismatch; expected ${expectedDigest}, file is ${sha256}`,
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
    const validated = validateToolSet(list, {
      maxSchemaBytes: options.maxSchemaBytes,
      source: `extension ${path}`,
    });
    tools.push(...validated);
    extensions.push({
      path,
      sha256,
      toolNames: validated.map((tool) => tool.name),
      pinned: expectedDigest !== undefined,
    });
  }
  return {
    tools: validateToolSet(tools, { maxSchemaBytes: options.maxSchemaBytes, source: 'extensions' }),
    extensions,
  };
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
): Promise<ExtensionLoadResult> {
  const fromConfig = await loadExtensions(sources.configPaths, dirname(resolve(sources.configFile)), options);
  const fromCli = await loadExtensions(sources.cliPaths, sources.cwd, options);
  return {
    tools: validateToolSet([...fromConfig.tools, ...fromCli.tools], {
      maxSchemaBytes: options.maxSchemaBytes,
      source: 'configured extensions',
    }),
    extensions: [...fromConfig.extensions, ...fromCli.extensions],
  };
}
