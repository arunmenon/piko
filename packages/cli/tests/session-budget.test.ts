import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { RootBudgetAuthority } from '@pi/core';
import { runCli, startFakeProvider } from './fake-provider.js';

const cli = resolve(import.meta.dirname, '..', 'dist', 'main.js');

/** A hermetic environment: no ambient credentials, no inherited tree or depth. */
function cleanEnvironment(workspace: string, providerUrl: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment['PI_DEPTH'];
  delete environment['PI_BUDGET_AUTHORITY'];
  return {
    ...environment,
    HOME: workspace,
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: providerUrl,
  };
}

function pricingFile(workspace: string): string {
  const path = join(workspace, 'prices.json');
  writeFileSync(
    path,
    JSON.stringify({
      models: { 'fake-model': { inputUSDPerToken: 0.000001, outputUSDPerToken: 0.000002 } },
      effectiveAt: '2026-09-02T00:00:00.000Z',
    }),
    'utf8',
  );
  return path;
}

/** The last stderr line of a --usage run is the typed usage_summary row. */
function usageSummary(stderr: string): Record<string, unknown> {
  const row = stderr
    .trim()
    .split('\n')
    .reverse()
    .find((line) => line.includes('"usage_summary"'));
  assert.ok(row, `no usage_summary row on stderr: ${stderr}`);
  return JSON.parse(row) as Record<string, unknown>;
}

test('a headless child joins the inherited tree and is refused once the root is exhausted', async () => {
  const provider = await startFakeProvider('the child answered');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-tree-exhausted-'));
  const ledgerDirectory = mkdtempSync(join(tmpdir(), 'pi-cli-tree-ledger-'));
  try {
    const authority = RootBudgetAuthority.create({
      rootRunId: 'exhausted-root',
      ceilings: { maxSpendUSD: 1 },
      directory: ledgerDirectory,
    });
    // The parent already spent the tree's whole budget.
    authority.reserve({ runId: 'exhausted-root', requestId: 'prior', amountUSD: 1, tokens: 10 });
    authority.reconcile('prior', 1, 10);

    const result = await runCli(
      [
        cli,
        '-p',
        '--usage',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--pricing',
        pricingFile(workspace),
        'go',
      ],
      {
        cwd: workspace,
        env: {
          ...cleanEnvironment(workspace, provider.url),
          PI_BUDGET_AUTHORITY: authority.path,
        },
      },
    );

    assert.equal(result.status, 2, JSON.stringify(result));
    assert.equal(provider.requests.length, 0, 'the refusal precedes the provider request');
    assert.match(result.stderr, /budget exceeded: session_spend/);
    assert.match(result.stderr, /session tree spend stop \(root exhausted-root\)/);
    // The four numbers for the tree, plus what the tree has left.
    assert.match(result.stderr, /reserved \$[0-9.]+ for the next request, spent \$1\.000000, ceiling \$1\.000000/);
    assert.match(result.stderr, /\$0\.000000 remaining/);

    const summary = usageSummary(result.stderr);
    const tree = summary['tree'] as Record<string, unknown>;
    assert.equal(tree['rootRunId'], 'exhausted-root');
    assert.deepEqual(tree['ceilings'], { maxSpendUSD: 1 });
    assert.equal(tree['reconciledUSD'], 1);
    assert.equal(tree['outstandingUSD'], 0);
    assert.equal(tree['outstandingRequests'], 0);
    assert.equal(tree['remainingUSD'], 0);
    assert.equal(summary['status'], 'budget_exceeded');
    assert.equal(summary['reason'], 'session_spend');
  } finally {
    await provider.close();
  }
});

test('the budget reminder reaches the model only when headless asks for it', async () => {
  const provider = await startFakeProvider('acknowledged');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-tree-reminder-'));
  const ledgerDirectory = mkdtempSync(join(tmpdir(), 'pi-cli-reminder-ledger-'));
  try {
    const authority = RootBudgetAuthority.create({
      rootRunId: 'reminder-root',
      ceilings: { maxSpendUSD: 1, maxTokens: 1_000_000 },
      directory: ledgerDirectory,
    });
    // 30 percent of the tree budget remains, so the 50-percent threshold is
    // already crossed when this child sends its first request.
    authority.reserve({ runId: 'reminder-root', requestId: 'prior', amountUSD: 0.7, tokens: 700_000 });
    authority.reconcile('prior', 0.7, 700_000);

    const environment = {
      ...cleanEnvironment(workspace, provider.url),
      PI_BUDGET_AUTHORITY: authority.path,
    };
    const flags = [
      cli,
      '-p',
      '--profile',
      'openai',
      '--model',
      'fake-model',
      '--pricing',
      pricingFile(workspace),
    ];

    // Off by default in -p: the caller decides what its children are told.
    const silent = await runCli([...flags, 'go'], { cwd: workspace, env: environment });
    assert.equal(silent.status, 0, JSON.stringify(silent));
    assert.equal(provider.requests.length, 1);
    assert.ok(!provider.requests[0]!.includes('Budget remaining'), provider.requests[0]);

    const reminded = await runCli([...flags, '--budget-reminders', 'go again'], {
      cwd: workspace,
      env: environment,
    });
    assert.equal(reminded.status, 0, JSON.stringify(reminded));
    assert.equal(provider.requests.length, 2);
    const body = provider.requests[1]!;
    assert.match(body, /\[harness\] Budget remaining for this session tree/);
    // The numbers the reminder carries are the tree's, not this run's.
    assert.match(body, /\$0\.2\d{5} of a \$1\.000000 spend ceiling/);
    assert.match(body, /29\d{4} of 1000000 tokens/);
  } finally {
    await provider.close();
  }
});

test('--max-session-spend-usd creates a tree, reports it, and requires an exact price', async () => {
  const provider = await startFakeProvider('done');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-tree-root-'));
  try {
    const environment = cleanEnvironment(workspace, provider.url);
    const priced = await runCli(
      [
        cli,
        '-p',
        '--usage',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--pricing',
        pricingFile(workspace),
        '--max-session-spend-usd',
        '5',
        '--max-elapsed-time',
        '600',
        'go',
      ],
      { cwd: workspace, env: environment },
    );
    assert.equal(priced.status, 0, JSON.stringify(priced));
    assert.match(priced.stderr, /session-tree budget ledger: /);
    const tree = usageSummary(priced.stderr)['tree'] as Record<string, unknown>;
    assert.deepEqual(tree['ceilings'], { maxSpendUSD: 5, maxElapsedTimeMs: 600_000 });
    assert.equal(tree['reconciledRequests'], 1, 'the completed request reconciled into the tree');
    assert.equal(tree['outstandingUSD'], 0, 'nothing is left reserved after a clean turn');
    assert.ok((tree['remainingUSD'] as number) < 5);

    // Fail-closed pairing (ADR 0020 decision 4): a dollar ceiling over a model
    // with no exact price refuses to start rather than warning.
    const unpriced = await runCli(
      [
        cli,
        '-p',
        '--profile',
        'openai',
        '--model',
        'unpriced-model',
        '--offline-pricing',
        '--max-session-spend-usd',
        '5',
        'go',
      ],
      { cwd: workspace, env: environment },
    );
    assert.equal(unpriced.status, 1);
    assert.match(unpriced.stderr, /session-tree spend ceiling requires an exact price/);
  } finally {
    await provider.close();
  }
});

test('a session-tree token ceiling stops the turn with the tree figures', async () => {
  const provider = await startFakeProvider('done');
  const workspace = mkdtempSync(join(tmpdir(), 'pi-cli-tree-tokens-'));
  try {
    const result = await runCli(
      [
        cli,
        '-p',
        '--usage',
        '--profile',
        'openai',
        '--model',
        'fake-model',
        '--offline-pricing',
        // Far below the conservative reservation bound for any real request.
        '--max-session-tokens',
        '10',
        'go',
      ],
      { cwd: workspace, env: cleanEnvironment(workspace, provider.url) },
    );
    assert.equal(result.status, 2, JSON.stringify(result));
    assert.equal(provider.requests.length, 0);
    assert.match(result.stderr, /budget exceeded: session_tokens/);
    assert.match(result.stderr, /session tree tokens stop/);
    assert.match(result.stderr, /10 tokens remaining/);
    const tree = usageSummary(result.stderr)['tree'] as Record<string, unknown>;
    assert.deepEqual(tree['ceilings'], { maxTokens: 10 });
    assert.equal(tree['remainingTokens'], 10);
  } finally {
    await provider.close();
  }
});
