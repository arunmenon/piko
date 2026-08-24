import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Tool names gated behind a human decision, or "*" for every tool (ADR 0011). */
export type ApprovalPolicy = readonly string[] | '*';

/** Credential source recorded for an endpoint that is configured to need no auth. */
export const KEYLESS_CREDENTIAL_SOURCE = 'config:keyless';

export interface Profile {
  name: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  /**
   * Name of the environment variable that supplied `apiKey`, or
   * `KEYLESS_CREDENTIAL_SOURCE` when the endpoint is configured without auth.
   * A name is not a secret (0016 decision 1) and is the only part of the
   * credential that may be observed.
   */
  credentialSource: string;
  baseUrl?: string;
  /** context window in tokens (defaults to a per-model-family table) */
  contextWindow?: number;
  /** approval gating from the profile, falling back to the top-level setting */
  approval?: ApprovalPolicy;
}

interface ProfileConfig {
  provider?: 'anthropic' | 'openai';
  model?: string;
  baseUrl?: string;
  /** env var holding the API key; the key itself never lives in the config file */
  apiKeyEnv?: string;
  contextWindow?: number;
  approval?: ApprovalPolicy;
}

export interface PiConfig {
  defaultProfile?: string;
  profiles?: Record<string, ProfileConfig>;
  extensions?: string[];
  /** default approval gating for every profile; user config and CLI flags are its only sources */
  approval?: ApprovalPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function optionalApproval(value: unknown, path: string): ApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === '*') return '*';
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${path} must be "*" or an array of tool names`);
  }
  return [...(value as string[])];
}

export function validateConfig(value: unknown): PiConfig {
  if (!isRecord(value)) throw new TypeError('config must be an object');
  const config: PiConfig = {};
  const defaultProfile = optionalString(value['defaultProfile'], 'defaultProfile');
  if (defaultProfile) config.defaultProfile = defaultProfile;
  const approval = optionalApproval(value['approval'], 'approval');
  if (approval !== undefined) config.approval = approval;
  if (value['extensions'] !== undefined) {
    if (!Array.isArray(value['extensions']) || value['extensions'].some((item) => typeof item !== 'string' || !item)) {
      throw new TypeError('extensions must be an array of non-empty strings');
    }
    config.extensions = [...value['extensions']] as string[];
  }
  if (value['profiles'] !== undefined) {
    if (!isRecord(value['profiles'])) throw new TypeError('profiles must be an object');
    const profiles: Record<string, ProfileConfig> = {};
    for (const [name, raw] of Object.entries(value['profiles'])) {
      if (!name || !isRecord(raw)) throw new TypeError(`profiles.${name || '<empty>'} must be an object`);
      const provider = raw['provider'];
      if (provider !== undefined && provider !== 'anthropic' && provider !== 'openai') {
        throw new TypeError(`profiles.${name}.provider must be "anthropic" or "openai"`);
      }
      const contextWindow = raw['contextWindow'];
      if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0)) {
        throw new TypeError(`profiles.${name}.contextWindow must be a positive integer`);
      }
      const profileApproval = optionalApproval(raw['approval'], `profiles.${name}.approval`);
      profiles[name] = {
        ...(profileApproval !== undefined ? { approval: profileApproval } : {}),
        ...(provider ? { provider } : {}),
        ...(optionalString(raw['model'], `profiles.${name}.model`) ? { model: raw['model'] as string } : {}),
        ...(optionalString(raw['baseUrl'], `profiles.${name}.baseUrl`) ? { baseUrl: raw['baseUrl'] as string } : {}),
        ...(optionalString(raw['apiKeyEnv'], `profiles.${name}.apiKeyEnv`)
          ? { apiKeyEnv: raw['apiKeyEnv'] as string }
          : {}),
        ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
      };
    }
    config.profiles = profiles;
  }
  return config;
}

/**
 * Names-only description of the credential a provider request carries. The type
 * deliberately has no field that could hold a key, so the value cannot reach an
 * observer by construction rather than by later redaction (0013, 0016).
 */
export interface CredentialDescriptor {
  readonly provider: 'anthropic' | 'openai';
  readonly profile: string;
  /** Environment variable NAME, or `KEYLESS_CREDENTIAL_SOURCE`. Never a value or a hash of one. */
  readonly source: string;
}

export function credentialDescriptor(profile: Profile): CredentialDescriptor {
  return { provider: profile.provider, profile: profile.name, source: profile.credentialSource };
}

export function configPath(): string {
  return join(homedir(), '.config', 'pi', 'config.json');
}

export function loadConfig(): PiConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; // no config file is the normal case
    throw new Error(`failed to read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateConfig(JSON.parse(raw) as unknown);
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
  // Profile gating overrides the top-level default; neither can be reached by
  // project content or extensions.
  const approval = merged.approval ?? config.approval;
  return {
    name,
    provider,
    model,
    apiKey,
    credentialSource: apiKey ? apiKeyEnv : KEYLESS_CREDENTIAL_SOURCE,
    ...(baseUrl ? { baseUrl } : {}),
    ...(merged.contextWindow ? { contextWindow: merged.contextWindow } : {}),
    ...(approval !== undefined ? { approval } : {}),
  };
}
