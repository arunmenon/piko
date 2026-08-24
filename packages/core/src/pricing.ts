import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CompletionRequest, Usage } from '@pi/ai';

export const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_PRICING_BYTES = 16 * 1024 * 1024;
const USD_SCALE = 1_000_000_000_000;

export type PricingSource = 'explicit' | 'fresh_cache' | 'network' | 'stale_cache';

export interface PricingProvenance {
  source: PricingSource;
  revision: string;
  currency: 'USD';
  effectiveAt: string;
}

export interface ModelPrice {
  model: string;
  inputUSDPerToken: number;
  outputUSDPerToken: number;
  cacheReadUSDPerToken: number;
  cacheWriteUSDPerToken: number;
  /**
   * Long-context rates, applied to the whole request when its prompt tokens
   * (input + cache read + cache write) exceed aboveInputTokens. Absent tier
   * keys inherit the base rate. Requests are priced per usage record, so the
   * applicable tier is known exactly; this is why tiered rows no longer have
   * to be rejected as ambiguous.
   */
  longContext?: {
    aboveInputTokens: number;
    inputUSDPerToken: number;
    outputUSDPerToken: number;
    cacheReadUSDPerToken: number;
    cacheWriteUSDPerToken: number;
  };
  /** Highest token-denominated rate advertised by the source row, for hard reservations. */
  reservationInputUSDPerToken?: number;
  reservationOutputUSDPerToken?: number;
  provenance: PricingProvenance;
}

/** Durable, request-linked accounting. Token usage remains the provider's data. */
export interface RequestCost {
  model: string;
  usd: number;
  inputUSD: number;
  outputUSD: number;
  cacheReadUSD: number;
  cacheWriteUSD: number;
  pricing: PricingProvenance;
}

/** Conservative exposure journaled before provider dispatch for spend-capped runs. */
export interface SpendReservation {
  model: string;
  usd: number;
  inputTokenUpperBound: number;
  outputTokenUpperBound: number;
  attempts: number;
  pricing: PricingProvenance;
}

export interface CostSummary {
  /** Provider-reported usage priced by a durable request cost row. */
  actualUSD: number;
  /** Conservative reservations whose request never produced priced terminal usage. */
  reservedUSD: number;
  pricedRequests: number;
  unpricedRequests: number;
  unknownRequests: number;
}

export interface PricingTable {
  readonly models: ReadonlyMap<string, ModelPrice>;
  readonly warnings: readonly string[];
}

interface CacheEnvelope {
  schemaVersion: 1;
  fetchedAt: string;
  url: string;
  revision: string;
  body: unknown;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface LoadPricingOptions {
  explicitPath?: string;
  cachePath?: string;
  offline?: boolean;
  url?: string;
  ttlMs?: number;
  now?: Date;
  fetcher?: (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
  fetchTimeoutMs?: number;
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite nonnegative number`);
  }
  return value;
}

function isoTimestamp(value: unknown, fallback: Date): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback.toISOString();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function pricingRows(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('pricing table must be an object');
  }
  const record = value as Record<string, unknown>;
  const models = record['models'];
  if (models !== undefined) {
    if (typeof models !== 'object' || models === null || Array.isArray(models)) {
      throw new TypeError('pricing table models must be an object');
    }
    return models as Record<string, unknown>;
  }
  return record;
}

function optionalRate(row: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const name of names) {
    if (row[name] !== undefined) return finiteNonNegative(row[name], name);
  }
  return undefined;
}

const LONG_CONTEXT_KEY =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/;

/**
 * Extract a single long-context tier from a LiteLLM row. Returns undefined
 * when the row has no tier keys. Throws when tier keys disagree on the
 * threshold: a row with several thresholds is genuinely ambiguous and the
 * whole row stays rejected, as before.
 */
function parseLongContextTier(
  row: Record<string, unknown>,
  base: { input: number; output: number; cacheRead: number; cacheWrite: number },
): ModelPrice['longContext'] {
  let aboveInputTokens: number | undefined;
  const rates: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    const match = LONG_CONTEXT_KEY.exec(key.toLowerCase());
    if (!match) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${key} must be a finite nonnegative number`);
    }
    const threshold = Number(match[2]) * 1_000;
    if (aboveInputTokens !== undefined && aboveInputTokens !== threshold) {
      throw new TypeError('row advertises multiple long-context thresholds');
    }
    aboveInputTokens = threshold;
    rates[match[1]!] = value;
  }
  if (aboveInputTokens === undefined) return undefined;
  const tierInput = rates['input_cost_per_token'] ?? base.input;
  // Mirror the base parser's conservatism: a row that never advertises a
  // cache rate had it defaulted from input, so the tier defaults from tier
  // input; a row with an explicit base cache rate but no tier variant keeps
  // the advertised base value.
  const tierCacheRead =
    rates['cache_read_input_token_cost'] ?? ('cache_read_input_token_cost' in row ? base.cacheRead : tierInput);
  const tierCacheWrite =
    rates['cache_creation_input_token_cost'] ??
    ('cache_creation_input_token_cost' in row ? base.cacheWrite : tierInput);
  return {
    aboveInputTokens,
    inputUSDPerToken: tierInput,
    outputUSDPerToken: rates['output_cost_per_token'] ?? base.output,
    cacheReadUSDPerToken: tierCacheRead,
    cacheWriteUSDPerToken: tierCacheWrite,
  };
}

function unresolvedDefaultRate(
  row: Record<string, unknown>,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): boolean {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    const normalized = key.toLowerCase();

    // These rates belong to modes piko does not request. They do not make the
    // default text request ambiguous.
    if (
      normalized.includes('audio') ||
      normalized.includes('image') ||
      normalized.includes('video') ||
      normalized.includes('character') ||
      normalized.includes('computer_use') ||
      normalized.includes('_priority') ||
      normalized.includes('_flex') ||
      normalized.includes('_batches') ||
      normalized.includes('above_1hr')
    ) {
      continue;
    }

    // Single-threshold long-context keys are represented exactly by the
    // parsed tier and priced per request; they no longer make a row ambiguous.
    if (LONG_CONTEXT_KEY.test(normalized)) continue;

    let representedBy: number | undefined;
    if (normalized === 'output_cost_per_reasoning_token') representedBy = output;
    else if (normalized.includes('_above_') && normalized.includes('_tokens')) {
      if (normalized.startsWith('output_cost_per_token')) representedBy = output;
      else if (normalized.startsWith('cache_read_input_token_cost')) representedBy = cacheRead;
      else if (normalized.startsWith('cache_creation_input_token_cost')) representedBy = cacheWrite;
      else if (normalized.startsWith('input_cost_per_token')) representedBy = input;
    }

    // Normalized provider usage does not retain reasoning-token or pricing-tier
    // splits. A differing applicable rate therefore cannot be called exact.
    if (representedBy !== undefined && value !== representedBy) return true;
  }
  return false;
}

/** Parse piko's compact schema or the exact-key rows in LiteLLM's public table. */
export function parsePricingTable(
  value: unknown,
  provenance: PricingProvenance,
): ReadonlyMap<string, ModelPrice> {
  const rows = pricingRows(value);
  const prices = new Map<string, ModelPrice>();
  for (const [model, raw] of Object.entries(rows)) {
    if (!model || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    try {
      const input = optionalRate(row, ['inputUSDPerToken', 'input_cost_per_token']);
      const output = optionalRate(row, ['outputUSDPerToken', 'output_cost_per_token']);
      if (input === undefined || output === undefined) continue;
      const cacheRead =
        optionalRate(row, [
          'cacheReadUSDPerToken',
          'cache_read_input_token_cost',
          'input_cost_per_token_cache_hit',
        ]) ?? input;
      const cacheWrite =
        optionalRate(row, ['cacheWriteUSDPerToken', 'cache_creation_input_token_cost']) ?? input;
      const longContext = parseLongContextTier(row, { input, output, cacheRead, cacheWrite });
      if (unresolvedDefaultRate(row, input, output, cacheRead, cacheWrite)) continue;
      prices.set(model, {
        model,
        inputUSDPerToken: input,
        outputUSDPerToken: output,
        cacheReadUSDPerToken: cacheRead,
        cacheWriteUSDPerToken: cacheWrite,
        ...(longContext ? { longContext } : {}),
        reservationInputUSDPerToken: Math.max(
          input,
          cacheRead,
          cacheWrite,
          longContext?.inputUSDPerToken ?? 0,
          longContext?.cacheReadUSDPerToken ?? 0,
          longContext?.cacheWriteUSDPerToken ?? 0,
        ),
        reservationOutputUSDPerToken: Math.max(output, longContext?.outputUSDPerToken ?? 0),
        provenance: { ...provenance },
      });
    } catch {
      // One malformed/unpriced public row must not erase every valid model.
    }
  }
  return prices;
}

function parseText(text: string, source: PricingSource, effectiveAt: Date): ReadonlyMap<string, ModelPrice> {
  if (Buffer.byteLength(text) > MAX_PRICING_BYTES) throw new RangeError('pricing table exceeds the 16 MiB limit');
  const parsed = JSON.parse(text) as unknown;
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  return parsePricingTable(parsed, {
    source,
    revision: sha256(text),
    currency: 'USD',
    effectiveAt: isoTimestamp(record?.['effectiveAt'], effectiveAt),
  });
}

async function readCache(path: string): Promise<{ envelope: CacheEnvelope; text: string }> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_PRICING_BYTES) {
    throw new RangeError('pricing cache is not a bounded regular file');
  }
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_PRICING_BYTES) throw new RangeError('pricing cache exceeds the 16 MiB limit');
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('invalid pricing cache');
  const row = value as Record<string, unknown>;
  if (
    row['schemaVersion'] !== 1 ||
    typeof row['fetchedAt'] !== 'string' ||
    Number.isNaN(Date.parse(row['fetchedAt'])) ||
    typeof row['url'] !== 'string' ||
    typeof row['revision'] !== 'string' ||
    row['body'] === undefined
  ) {
    throw new TypeError('invalid pricing cache envelope');
  }
  return { envelope: row as unknown as CacheEnvelope, text };
}

async function boundedResponseText(response: FetchResponse): Promise<string> {
  if (!response.ok) throw new Error(`pricing endpoint returned HTTP ${response.status}`);
  if (!response.body) throw new Error('pricing endpoint returned no response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_PRICING_BYTES) throw new RangeError('pricing response exceeds the 16 MiB limit');
      chunks.push(next.value);
    }
  } finally {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup must not convert a successfully bounded read into loader failure.
    }
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function writeCache(path: string, envelope: CacheEnvelope): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Resolve once at startup: explicit path -> fresh cache -> fetch -> stale cache
 * -> empty. Every error degrades to a warning and an empty/older table.
 */
export async function loadPricingTable(options: LoadPricingOptions = {}): Promise<PricingTable> {
  const warnings: string[] = [];
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? PRICING_CACHE_TTL_MS;
  const url = options.url ?? DEFAULT_PRICING_URL;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(ttl) || ttl < 0) warnings.push('pricing ttlMs is invalid; cache freshness disabled');
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs < 1) {
    warnings.push('pricing fetchTimeoutMs is invalid; network pricing disabled');
  }

  if (options.explicitPath) {
    try {
      const metadata = await stat(options.explicitPath);
      if (!metadata.isFile() || metadata.size > MAX_PRICING_BYTES) {
        throw new RangeError('explicit pricing is not a bounded regular file');
      }
      const text = await readFile(options.explicitPath, 'utf8');
      const models = parseText(text, 'explicit', metadata.mtime);
      if (models.size === 0) throw new Error('pricing table contains no usable model rows');
      return { models, warnings };
    } catch (error) {
      warnings.push(`explicit pricing unavailable: ${String(error)}`);
    }
  }

  let cached: { envelope: CacheEnvelope; text: string } | undefined;
  if (options.cachePath) {
    try {
      cached = await readCache(options.cachePath);
      const age = now.getTime() - Date.parse(cached.envelope.fetchedAt);
      if (Number.isSafeInteger(ttl) && ttl >= 0 && age >= 0 && age <= ttl) {
        const models = parsePricingTable(cached.envelope.body, {
          source: 'fresh_cache',
          revision: cached.envelope.revision,
          currency: 'USD',
          effectiveAt: cached.envelope.fetchedAt,
        });
        if (models.size > 0) return { models, warnings };
        warnings.push('fresh pricing cache contains no usable model rows');
      }
    } catch (error) {
      warnings.push(`pricing cache unavailable: ${String(error)}`);
    }
  }

  const networkAllowed = !options.offline && !options.explicitPath && Number.isSafeInteger(fetchTimeoutMs) && fetchTimeoutMs > 0;
  if (networkAllowed) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('pricing fetch timed out');
        controller.abort(error);
        reject(error);
      }, fetchTimeoutMs);
    });
    try {
      const fetcher = options.fetcher ?? ((target, init) => fetch(target, init) as Promise<FetchResponse>);
      const response = await Promise.race([fetcher(url, { signal: controller.signal }), timeout]);
      // One absolute deadline across fetch AND body consumption: native fetch
      // propagates the abort into its body stream, but an injected fetcher may
      // return an OK response whose reads never settle (review finding 10).
      const text = await Promise.race([boundedResponseText(response), timeout]);
      const body = JSON.parse(text) as unknown;
      const fetchedAt = now.toISOString();
      const revision = sha256(text);
      const models = parsePricingTable(body, {
        source: 'network',
        revision,
        currency: 'USD',
        effectiveAt: fetchedAt,
      });
      if (models.size === 0) throw new Error('network pricing table contains no usable model rows');
      if (options.cachePath) {
        try {
          await writeCache(options.cachePath, { schemaVersion: 1, fetchedAt, url, revision, body });
        } catch (error) {
          warnings.push(`pricing cache write failed: ${String(error)}`);
        }
      }
      return { models, warnings };
    } catch (error) {
      warnings.push(`network pricing unavailable: ${String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (cached) {
    try {
      const models = parsePricingTable(cached.envelope.body, {
        source: 'stale_cache',
        revision: cached.envelope.revision,
        currency: 'USD',
        effectiveAt: cached.envelope.fetchedAt,
      });
      if (models.size > 0) return { models, warnings };
      warnings.push('stale pricing cache contains no usable model rows');
    } catch (error) {
      warnings.push(`stale pricing cache unavailable: ${String(error)}`);
    }
  }
  return { models: new Map(), warnings };
}

export function resolveModelPrice(table: PricingTable, model: string): ModelPrice | undefined {
  const price = table.models.get(model);
  return price ? structuredClone(price) : undefined;
}

export function validateModelPrice(price: ModelPrice): void {
  if (!price.model) throw new TypeError('pricing model must be nonempty');
  for (const [name, value] of Object.entries({
    inputUSDPerToken: price.inputUSDPerToken,
    outputUSDPerToken: price.outputUSDPerToken,
    cacheReadUSDPerToken: price.cacheReadUSDPerToken,
    cacheWriteUSDPerToken: price.cacheWriteUSDPerToken,
    ...(price.reservationInputUSDPerToken !== undefined
      ? { reservationInputUSDPerToken: price.reservationInputUSDPerToken }
      : {}),
    ...(price.reservationOutputUSDPerToken !== undefined
      ? { reservationOutputUSDPerToken: price.reservationOutputUSDPerToken }
      : {}),
    ...(price.longContext
      ? {
          'longContext.aboveInputTokens': price.longContext.aboveInputTokens,
          'longContext.inputUSDPerToken': price.longContext.inputUSDPerToken,
          'longContext.outputUSDPerToken': price.longContext.outputUSDPerToken,
          'longContext.cacheReadUSDPerToken': price.longContext.cacheReadUSDPerToken,
          'longContext.cacheWriteUSDPerToken': price.longContext.cacheWriteUSDPerToken,
        }
      : {}),
  })) {
    finiteNonNegative(value, `price.${name}`);
  }
  if (price.longContext && !Number.isSafeInteger(price.longContext.aboveInputTokens)) {
    throw new TypeError('price.longContext.aboveInputTokens must be a safe integer');
  }
  if (!['explicit', 'fresh_cache', 'network', 'stale_cache'].includes(price.provenance.source)) {
    throw new TypeError('price.provenance.source is unsupported');
  }
  if (!price.provenance.revision || price.provenance.currency !== 'USD') {
    throw new TypeError('price provenance requires a revision and USD currency');
  }
  if (Number.isNaN(Date.parse(price.provenance.effectiveAt))) {
    throw new TypeError('price.provenance.effectiveAt must be a timestamp');
  }
}

function usd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('computed USD value must be finite and nonnegative');
  return Math.round(value * USD_SCALE) / USD_SCALE;
}

function usdCeiling(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('reserved USD value must be finite and nonnegative');
  return Math.ceil(value * USD_SCALE) / USD_SCALE;
}

export function costForUsage(usage: Usage, price: ModelPrice): RequestCost {
  validateModelPrice(price);
  // LiteLLM long-context semantics: once the request's prompt exceeds the
  // threshold, the whole request bills at the tier rates.
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const rates =
    price.longContext && promptTokens > price.longContext.aboveInputTokens ? price.longContext : price;
  const inputUSD = usd(usage.inputTokens * rates.inputUSDPerToken);
  const outputUSD = usd(usage.outputTokens * rates.outputUSDPerToken);
  const cacheReadUSD = usd(usage.cacheReadTokens * rates.cacheReadUSDPerToken);
  const cacheWriteUSD = usd(usage.cacheWriteTokens * rates.cacheWriteUSDPerToken);
  return {
    model: price.model,
    usd: usd(inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD),
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheWriteUSD,
    pricing: { ...price.provenance },
  };
}

/** UTF-8 bytes plus framing is a tokenizer-independent upper bound for normal BPE request text. */
export function conservativeInputTokenBound(request: CompletionRequest): number {
  const bytes = Buffer.byteLength(
    JSON.stringify({ model: request.model, system: request.system, messages: request.messages, tools: request.tools }),
  );
  const framing = 1_024 + 64 * (request.messages.length + request.tools.length + 1);
  const bound = bytes + framing;
  if (!Number.isSafeInteger(bound) || bound < 1) throw new RangeError('request is too large to reserve safely');
  return bound;
}

export function reserveRequestSpend(
  request: CompletionRequest,
  price: ModelPrice,
  attempts = request.maxAttempts ?? 1,
): SpendReservation {
  validateModelPrice(price);
  if (request.model !== price.model) {
    throw new Error(`pricing model ${price.model} does not match request model ${request.model}`);
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive safe integer');
  if (!Number.isSafeInteger(request.maxTokens) || (request.maxTokens ?? 0) < 1) {
    throw new RangeError('a spend-capped request requires a positive maxTokens output cap');
  }
  const inputTokenUpperBound = conservativeInputTokenBound(request);
  const inputRate = Math.max(
    price.inputUSDPerToken,
    price.cacheReadUSDPerToken,
    price.cacheWriteUSDPerToken,
    price.reservationInputUSDPerToken ?? 0,
    price.longContext?.inputUSDPerToken ?? 0,
    price.longContext?.cacheReadUSDPerToken ?? 0,
    price.longContext?.cacheWriteUSDPerToken ?? 0,
  );
  const outputRate = Math.max(
    price.outputUSDPerToken,
    price.reservationOutputUSDPerToken ?? 0,
    price.longContext?.outputUSDPerToken ?? 0,
  );
  const perAttempt = inputTokenUpperBound * inputRate + request.maxTokens! * outputRate;
  return {
    model: price.model,
    usd: usdCeiling(perAttempt * attempts),
    inputTokenUpperBound,
    outputTokenUpperBound: request.maxTokens!,
    attempts,
    pricing: { ...price.provenance },
  };
}

export function emptyCostSummary(): CostSummary {
  return { actualUSD: 0, reservedUSD: 0, pricedRequests: 0, unpricedRequests: 0, unknownRequests: 0 };
}

export function addRequestCost(total: CostSummary, cost: RequestCost | undefined): void {
  if (cost) {
    total.actualUSD = usd(total.actualUSD + cost.usd);
    total.pricedRequests++;
  } else {
    total.unpricedRequests++;
  }
}

export function addCostSummary(total: CostSummary, delta: CostSummary): void {
  total.actualUSD = usd(total.actualUSD + delta.actualUSD);
  total.reservedUSD = usdCeiling(total.reservedUSD + delta.reservedUSD);
  total.pricedRequests += delta.pricedRequests;
  total.unpricedRequests += delta.unpricedRequests;
  total.unknownRequests += delta.unknownRequests;
}

export function spendExposure(summary: CostSummary): number {
  return usdCeiling(summary.actualUSD + summary.reservedUSD);
}

export function costComplete(summary: CostSummary): boolean {
  return summary.reservedUSD === 0 && summary.unpricedRequests === 0 && summary.unknownRequests === 0;
}
