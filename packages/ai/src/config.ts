import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Profile {
  name: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** context window in tokens (defaults to a per-model-family table) */
  contextWindow?: number;
}

interface ProfileConfig {
  provider?: 'anthropic' | 'openai';
  model?: string;
  baseUrl?: string;
  /** env var holding the API key; the key itself never lives in the config file */
  apiKeyEnv?: string;
  contextWindow?: number;
}

export interface PiConfig {
  defaultProfile?: string;
  profiles?: Record<string, ProfileConfig>;
  extensions?: string[];
}

export function configPath(): string {
  return join(homedir(), '.config', 'pi', 'config.json');
}

export function loadConfig(): PiConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch {
    return {}; // no config file is the normal case
  }
  try {
    return JSON.parse(raw) as PiConfig;
  } catch (error) {
    // a malformed config must not be silently ignored — profiles would vanish confusingly
    throw new Error(`failed to parse ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const BUILTIN_PROFILES: Record<string, ProfileConfig> = {
  anthropic: { provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
};

export function resolveProfile(
  config: PiConfig,
  profileName?: string,
  modelOverride?: string,
): Profile {
  const name =
    profileName ??
    config.defaultProfile ??
    (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'openai');
  const fromConfig = config.profiles?.[name];
  const builtin = BUILTIN_PROFILES[name];
  if (!fromConfig && !builtin) {
    throw new Error(`unknown profile "${name}" (define it in ${configPath()})`);
  }
  const merged: ProfileConfig = { ...builtin, ...fromConfig };
  const provider = merged.provider ?? 'openai';
  const model = modelOverride ?? merged.model ?? process.env['PI_MODEL'];
  if (!model) {
    throw new Error(`no model for profile "${name}": pass --model, set PI_MODEL, or set profiles.${name}.model in ${configPath()}`);
  }
  const apiKeyEnv = merged.apiKeyEnv ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const apiKey = process.env[apiKeyEnv] ?? '';
  const baseUrl =
    merged.baseUrl ??
    (provider === 'openai' ? process.env['OPENAI_BASE_URL'] : process.env['ANTHROPIC_BASE_URL']);
  // keyless is fine for explicit endpoints (local vLLM / llama.cpp servers run without auth)
  if (!apiKey && !baseUrl) {
    throw new Error(`no API key for profile "${name}": set ${apiKeyEnv}`);
  }
  return {
    name,
    provider,
    model,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(merged.contextWindow ? { contextWindow: merged.contextWindow } : {}),
  };
}
