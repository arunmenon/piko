import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompletionRequest, Usage } from '@pi/ai';
import {
  costForUsage,
  loadPricingTable,
  parsePricingTable,
  reserveRequestSpend,
  resolveModelPrice,
  type PricingProvenance,
} from '../src/pricing.js';
import { Session, costAcrossSessionLineageDetailed } from '../src/session.js';

const provenance: PricingProvenance = {
  source: 'explicit',
  revision: 'abc123',
  currency: 'USD',
  effectiveAt: '2026-08-24T00:00:00.000Z',
};

test('pricing parser accepts exact piko/LiteLLM rows and never invents aliases', () => {
  const prices = parsePricingTable(
    {
      exact: {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000005,
        output_cost_per_reasoning_token: 0.000002,
      },
      compact: { inputUSDPerToken: 0.000003, outputUSDPerToken: 0.000004 },
      ambiguous: {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        output_cost_per_token_above_128k_tokens: 0.000004,
      },
      metadata: { max_tokens: 1000 },
    },
    provenance,
  );
  assert.equal(prices.size, 2);
  assert.equal(prices.get('exact')?.cacheReadUSDPerToken, 0.0000005);
  assert.equal(prices.get('exact')?.cacheWriteUSDPerToken, 0.000001, 'missing cache rate is conservative');
  assert.equal(prices.get('exact')?.reservationOutputUSDPerToken, 0.000002);
  assert.equal(prices.get('compact')?.inputUSDPerToken, 0.000003);
  assert.equal(prices.get('ambiguous'), undefined, 'usage-dependent rates are not guessed');
  assert.equal(prices.get('provider/exact'), undefined, 'model aliases are never guessed');
});

test('pricing loader follows explicit, fresh-cache, network, stale-cache, empty without throwing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pricing-'));
  const explicit = join(directory, 'explicit.json');
  const cache = join(directory, 'cache.json');
  writeFileSync(
    explicit,
    JSON.stringify({ models: { explicit: { inputUSDPerToken: 1e-6, outputUSDPerToken: 2e-6 } } }),
  );
  let fetches = 0;
  const explicitTable = await loadPricingTable({
    explicitPath: explicit,
    cachePath: cache,
    fetcher: async () => {
      fetches++;
      throw new Error('must not fetch');
    },
  });
  assert.ok(resolveModelPrice(explicitTable, 'explicit'));
  assert.equal(fetches, 0);

  const now = new Date('2026-08-24T12:00:00.000Z');
  const network = await loadPricingTable({
    cachePath: cache,
    now,
    fetcher: async () =>
      new Response(
        JSON.stringify({ network: { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 } }),
        { status: 200 },
      ),
  });
  assert.equal(resolveModelPrice(network, 'network')?.provenance.source, 'network');
  assert.equal(fetches, 0);
  assert.match(readFileSync(cache, 'utf8'), /fetchedAt/);

  const fresh = await loadPricingTable({
    cachePath: cache,
    now: new Date(now.getTime() + 1_000),
    fetcher: async () => {
      fetches++;
      throw new Error('fresh cache must win');
    },
  });
  assert.equal(resolveModelPrice(fresh, 'network')?.provenance.source, 'fresh_cache');
  assert.equal(fetches, 0);

  const stale = await loadPricingTable({
    cachePath: cache,
    now: new Date(now.getTime() + 25 * 60 * 60 * 1_000),
    fetcher: async () => {
      fetches++;
      throw new Error('offline upstream');
    },
  });
  assert.equal(resolveModelPrice(stale, 'network')?.provenance.source, 'stale_cache');
  assert.equal(fetches, 1);
  assert.ok(stale.warnings.some((warning) => warning.includes('network pricing unavailable')));

  const empty = await loadPricingTable({
    explicitPath: join(directory, 'missing.json'),
    cachePath: join(directory, 'missing-cache.json'),
    offline: true,
  });
  assert.equal(empty.models.size, 0);
  assert.ok(empty.warnings.length > 0);

  const started = Date.now();
  const timedOut = await loadPricingTable({
    fetchTimeoutMs: 10,
    fetcher: async () => new Promise(() => {}),
  });
  assert.equal(timedOut.models.size, 0);
  assert.ok(Date.now() - started < 250, 'a non-cooperative fetcher must not hold startup open');
  assert.ok(timedOut.warnings.some((warning) => warning.includes('timed out')));
});

test('request costs preserve components/provenance and reservations are conservative', () => {
  const table = {
    models: parsePricingTable(
      { m: { inputUSDPerToken: 0.001, outputUSDPerToken: 0.002, cacheReadUSDPerToken: 0.0005 } },
      provenance,
    ),
    warnings: [],
  };
  const price = resolveModelPrice(table, 'm')!;
  const usage: Usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3 };
  const cost = costForUsage(usage, price);
  assert.equal(cost.usd, 0.019);
  assert.deepEqual(cost.pricing, provenance);

  const request: CompletionRequest = {
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    maxTokens: 100,
    maxAttempts: 2,
  };
  const reservation = reserveRequestSpend(request, price);
  assert.equal(reservation.attempts, 2);
  assert.ok(reservation.inputTokenUpperBound > Buffer.byteLength(JSON.stringify(request)));
  assert.ok(reservation.usd >= costForUsage({ inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, price).usd * 2);
});

test('a crash after priced dispatch retains conservative spend exposure on replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pricing-crash-'));
  const session = Session.create('/project', 'm', directory);
  const modelPrice = parsePricingTable(
    { m: { inputUSDPerToken: 0.001, outputUSDPerToken: 0.002 } },
    provenance,
  ).get('m')!;
  const request: CompletionRequest = {
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [],
    maxTokens: 10,
    maxAttempts: 1,
  };
  const reservation = reserveRequestSpend(request, modelPrice);
  session.setRunStatus('running');
  const requestId = session.beginModelRequest('m', { spendReservation: reservation });
  session.markModelRequestOutcomeUnknown(requestId, 'crash after dispatch');

  const replayed = Session.open(session.file);
  assert.equal(replayed.costSummary.actualUSD, 0);
  assert.equal(replayed.costSummary.reservedUSD, reservation.usd);
  assert.equal(replayed.costSummary.unknownRequests, 1);
  assert.equal(replayed.openRun.cost.reservedUSD, reservation.usd);
});

test('cost checkpoints keep compacted lineage accounting bounded and self-contained', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-pricing-lineage-'));
  const modelPrice = parsePricingTable(
    { m: { inputUSDPerToken: 0.001, outputUSDPerToken: 0.002 } },
    provenance,
  ).get('m')!;
  const usage: Usage = { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const parent = Session.create('/project', 'm', directory);
  const parentRequest = parent.beginModelRequest('m');
  parent.completeModelRequest(parentRequest, { usage, cost: costForUsage(usage, modelPrice) });
  const child = Session.create('/project', 'm', directory, {
    lineage: {
      parentSessionId: parent.id,
      parentFile: parent.file,
      relation: 'compaction',
      priorCost: parent.costSummary,
    },
  });
  const childRequest = child.beginModelRequest('m');
  child.completeModelRequest(childRequest, { usage, cost: costForUsage(usage, modelPrice) });
  unlinkSync(parent.file);

  const history = costAcrossSessionLineageDetailed(Session.open(child.file));
  assert.equal(history.cost.actualUSD, 0.008);
  assert.equal(history.cost.pricedRequests, 2);
  assert.equal(history.complete, true);
  assert.equal(history.traversed, 1);
});
