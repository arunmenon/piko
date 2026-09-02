import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, CompletionRequest, Message, StreamEvent, Usage } from '@pi/ai';
import { Agent, type AgentEvent, type CompletionClient } from '../src/agent.js';
import {
  BudgetReminderTracker,
  RootBudgetAuthority,
  budgetReminderText,
  readBudgetAuthorityPath,
  type RootBudgetSnapshot,
} from '../src/budget-authority.js';
import type { ModelPrice } from '../src/pricing.js';
import { sanitizedBashEnvironment } from '../src/tools/bash.js';
import type { Observer, RuntimeTelemetryEvent } from '../src/telemetry.js';

const authorityModule = resolve(import.meta.dirname, '..', 'dist', 'budget-authority.js');

const smallUsage: Usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };

function price(overrides: Partial<ModelPrice> = {}): ModelPrice {
  return {
    model: 'm',
    inputUSDPerToken: 0.000001,
    outputUSDPerToken: 0.000002,
    cacheReadUSDPerToken: 0.0000005,
    cacheWriteUSDPerToken: 0.000001,
    provenance: {
      source: 'explicit',
      revision: 'test-prices',
      currency: 'USD',
      effectiveAt: '2026-09-02T00:00:00.000Z',
    },
    ...overrides,
  };
}

/** Records what the agent actually sent, so an injected harness message is visible. */
function recordingClient(options: { delayMs?: number } = {}): CompletionClient & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent, void, void> {
      requests.push(structuredClone(request) as CompletionRequest);
      if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
      yield { type: 'done', message: answer, stopReason: 'end_turn', usage: smallUsage };
    },
  };
}

async function drain(agent: Agent, input = 'go'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(input)) events.push(event);
  return events;
}

function terminalOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'turn_done' }> {
  return events.at(-1) as Extract<AgentEvent, { type: 'turn_done' }>;
}

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('reserve and reconcile keep the tree exposure exact, and an unknown outcome retains it', () => {
  const directory = workspace('pi-budget-ledger-');
  const authority = RootBudgetAuthority.create({
    rootRunId: 'root-1',
    ceilings: { maxSpendUSD: 1 },
    directory,
  });

  const first = authority.reserve({ runId: 'root-1', requestId: 'req-1', amountUSD: 0.4, tokens: 100 });
  assert.equal(first.admitted, true);
  assert.equal(authority.snapshot().outstandingUSD, 0.4);
  assert.equal(authority.snapshot().remainingUSD, 0.6);

  // A terminal usage row replaces the reservation with what the request cost.
  authority.reconcile('req-1', 0.05, 42);
  const afterReconcile = authority.snapshot();
  assert.equal(afterReconcile.outstandingUSD, 0);
  assert.equal(afterReconcile.reconciledUSD, 0.05);
  assert.equal(afterReconcile.reconciledTokens, 42);
  assert.equal(afterReconcile.remainingUSD, 0.95);
  assert.equal(afterReconcile.admittedUSD, 0.4, 'the admitted total is cumulative, not the outstanding one');

  // Reconciling twice must not subtract exposure twice or add cost twice.
  authority.reconcile('req-1', 0.05, 42);
  assert.equal(authority.snapshot().reconciledUSD, 0.05);

  // An unknown outcome keeps its full reservation until an explicit release.
  authority.reserve({ runId: 'root-1', requestId: 'req-2', amountUSD: 0.3, tokens: 10 });
  assert.equal(authority.snapshot().outstandingUSD, 0.3);
  assert.equal(authority.snapshot().remainingUSD, 0.65);
  authority.releaseUnknown('req-2');
  assert.equal(authority.snapshot().outstandingUSD, 0);
  assert.equal(authority.snapshot().reconciledUSD, 0.05, 'a release is not a cost');

  // The ceiling is enforced against reconciled plus outstanding exposure.
  const refused = authority.reserve({ runId: 'root-1', requestId: 'req-3', amountUSD: 0.96, tokens: 1 });
  assert.equal(refused.admitted, false);
  assert.equal(refused.admitted === false ? refused.reason : '', 'spend');
});

test("a child's exposure is charged to itself, to every ancestor, and to the root", () => {
  const directory = workspace('pi-budget-ancestors-');
  const root = RootBudgetAuthority.create({ rootRunId: 'root', ceilings: { maxSpendUSD: 5 }, directory });
  const child = RootBudgetAuthority.join(root.path, { runId: 'child', parentRunId: 'root' });
  const grandchild = RootBudgetAuthority.join(root.path, { runId: 'grandchild', parentRunId: 'child' });

  grandchild.reserve({ runId: 'grandchild', requestId: 'g-1', amountUSD: 0.25, tokens: 7 });
  child.reserve({ runId: 'child', requestId: 'c-1', amountUSD: 0.1, tokens: 3 });

  assert.equal(root.chargeFor('grandchild').outstandingUSD, 0.25);
  assert.equal(root.chargeFor('child').outstandingUSD, 0.35, "the parent carries its child's exposure");
  assert.equal(root.chargeFor('root').outstandingUSD, 0.35);
  assert.equal(root.snapshot().outstandingUSD, 0.35);

  const rows = root.outstanding();
  assert.deepEqual(
    rows.find((row) => row.requestId === 'g-1')?.ancestors,
    ['root', 'child'],
    'the ledger row records the whole ancestor chain',
  );

  grandchild.reconcile('g-1', 0.02, 5);
  assert.equal(root.chargeFor('child').reconciledUSD, 0.02);
  assert.equal(root.chargeFor('root').reconciledUSD, 0.02);
  assert.equal(root.chargeFor('grandchild').outstandingUSD, 0);
});

test('two REPL turns cannot exceed the session cap while each alone passes the per-turn cap', async () => {
  // Measure the conservative reservation this exact first turn produces, so the
  // session ceiling can be set to admit precisely one of them.
  const probeDirectory = workspace('pi-budget-probe-');
  const probe = RootBudgetAuthority.create({ rootRunId: 'probe', directory: probeDirectory });
  const probeAgent = new Agent({
    client: recordingClient(),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    pricing: price(),
    budget: { maxSpendUSD: 10 },
    budgetAuthority: probe,
    runId: 'probe',
  });
  assert.equal(terminalOf(await drain(probeAgent)).status, 'completed');
  const oneTurnReservationUSD = probe.snapshot().admittedUSD;
  assert.ok(oneTurnReservationUSD > 0, 'the probe measured a real reservation');

  const directory = workspace('pi-budget-repl-');
  const authority = RootBudgetAuthority.create({
    rootRunId: 'repl',
    ceilings: { maxSpendUSD: oneTurnReservationUSD },
    directory,
  });
  const agent = new Agent({
    client: recordingClient(),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    pricing: price(),
    // Ten times what one turn needs: the per-turn ceiling admits either turn.
    budget: { maxSpendUSD: oneTurnReservationUSD * 10 },
    budgetAuthority: authority,
    runId: 'repl',
  });

  const first = terminalOf(await drain(agent));
  assert.equal(first.status, 'completed', JSON.stringify(first));

  // The REPL keeps the same Agent across turns; the per-turn ledger resets and
  // the tree ledger does not.
  const second = terminalOf(await drain(agent, 'again'));
  assert.equal(second.status, 'budget_exceeded');
  assert.equal(second.reason, 'session_spend');
  assert.equal(second.tree?.reason, 'spend');
  assert.equal(second.tree?.rootRunId, 'repl');
  assert.equal(second.tree?.spend?.ceilingUSD, oneTurnReservationUSD);
  assert.ok((second.tree?.spend?.actualUSD ?? 0) > 0, 'the first turn reconciled into the tree');
  assert.ok((second.tree?.spend?.reservationUSD ?? 0) > 0, 'the refused reservation is reported');
  assert.equal(second.spend?.ceilingUSD, oneTurnReservationUSD * 10, 'the per-turn numbers are still reported');

  // The control: without the tree ceiling the same second turn completes, so
  // the stop above is the session cap and not the per-turn one.
  const controlAgent = new Agent({
    client: recordingClient(),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    pricing: price(),
    budget: { maxSpendUSD: oneTurnReservationUSD * 10 },
  });
  assert.equal(terminalOf(await drain(controlAgent)).status, 'completed');
  assert.equal(terminalOf(await drain(controlAgent, 'again')).status, 'completed');
});

test('active time and elapsed time are separate ceilings', async () => {
  // Active time: the model call itself is what consumes it.
  const activeDirectory = workspace('pi-budget-active-');
  const activeAuthority = RootBudgetAuthority.create({
    rootRunId: 'active',
    // Elapsed is generous; only active time can refuse here.
    ceilings: { maxActiveTimeMs: 50, maxElapsedTimeMs: 600_000 },
    directory: activeDirectory,
  });
  const activeAgent = new Agent({
    client: recordingClient({ delayMs: 80 }),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    budgetAuthority: activeAuthority,
    runId: 'active',
  });
  assert.equal(terminalOf(await drain(activeAgent)).status, 'completed');
  assert.ok(activeAuthority.snapshot().activeTimeMs >= 80, 'model wall time is charged to the tree');
  const activeStop = terminalOf(await drain(activeAgent, 'again'));
  assert.equal(activeStop.status, 'budget_exceeded');
  assert.equal(activeStop.reason, 'active_time');
  assert.equal(activeStop.tree?.reason, 'active_time');
  assert.equal(activeStop.tree?.remainingActiveTimeMs, 0);

  // Elapsed time: wall clock since the root started, whatever the tree was doing.
  const elapsedDirectory = workspace('pi-budget-elapsed-');
  const elapsedAuthority = RootBudgetAuthority.create({
    rootRunId: 'elapsed',
    ceilings: { maxActiveTimeMs: 600_000, maxElapsedTimeMs: 5_000 },
    directory: elapsedDirectory,
    startedAtEpochMs: Date.now() - 10_000,
  });
  const elapsedAgent = new Agent({
    client: recordingClient(),
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    budgetAuthority: elapsedAuthority,
    runId: 'elapsed',
  });
  const elapsedStop = terminalOf(await drain(elapsedAgent));
  assert.equal(elapsedStop.status, 'budget_exceeded');
  assert.equal(elapsedStop.reason, 'elapsed_time');
  assert.ok(elapsedAuthority.snapshot().activeTimeMs < 5_000, 'the tree was idle, not busy');
});

test('a budget reminder is a [harness] turn message carrying the remaining figures', async () => {
  const directory = workspace('pi-budget-reminder-');
  const authority = RootBudgetAuthority.create({
    rootRunId: 'reminder',
    ceilings: { maxSpendUSD: 1, maxTokens: 1_000_000 },
    directory,
  });
  // Pre-charge the tree so the first request of this run is already past the
  // 50-percent threshold.
  authority.reserve({ runId: 'reminder', requestId: 'prior', amountUSD: 0.7, tokens: 700_000 });
  authority.reconcile('prior', 0.7, 700_000);

  const events: RuntimeTelemetryEvent[] = [];
  const observer: Observer = {
    emit(event) {
      events.push(event);
    },
    flush() {
      /* nothing buffered */
    },
  };
  const client = recordingClient();
  const agent = new Agent({
    client,
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    pricing: price(),
    budgetAuthority: authority,
    runId: 'reminder',
    budgetReminders: {},
    observer,
  });
  assert.equal(terminalOf(await drain(agent)).status, 'completed');

  const sent = client.requests[0]!;
  const reminder = sent.messages
    .flatMap((message: Message) => message.content)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .find((text) => text.startsWith('[harness] Budget remaining'));
  assert.ok(reminder, `the reminder reached the model: ${JSON.stringify(sent.messages)}`);
  assert.match(reminder, /\$0\.300000 of a \$1\.000000 spend ceiling/);
  assert.match(reminder, /300000 of 1000000 tokens/);
  assert.ok(!/\[harness\] Budget remaining/.test('s'), 'the reminder is never part of the fixed prefix');

  const requestSpan = events.find(
    (event) => event.kind === 'span_started' && event.name === 'model.request',
  ) as { attributes?: Record<string, unknown> } | undefined;
  assert.equal(requestSpan?.attributes?.['budgetReminder'], true);

  // The same threshold does not fire twice.
  const second = recordingClient();
  const secondAgent = new Agent({
    client: second,
    model: 'm',
    systemPrompt: 's',
    tools: [],
    cwd: '/tmp',
    pricing: price(),
    budgetAuthority: authority,
    runId: 'reminder',
    budgetReminders: {},
  });
  await drain(secondAgent);
  await drain(secondAgent, 'again');
  assert.equal(second.requests.length, 2, 'two turns, two provider requests');
  // The last request carries the whole transcript, so counting there counts
  // every reminder both turns injected.
  const reminders = second.requests
    .at(-1)!
    .messages.flatMap((message: Message) => message.content)
    .filter((block) => block.type === 'text' && block.text.startsWith('[harness] Budget remaining'));
  assert.equal(reminders.length, 1, 'one reminder per crossed threshold, not one per request');
});

test('the reminder tracker fires per threshold and on the configured request cadence', () => {
  const snapshotAt = (remainingUSD: number): RootBudgetSnapshot => ({
    rootRunId: 'r',
    ledgerPath: '/dev/null',
    ceilings: { maxSpendUSD: 1 },
    admittedUSD: 1 - remainingUSD,
    admittedTokens: 0,
    admittedRequests: 0,
    reconciledUSD: 1 - remainingUSD,
    reconciledTokens: 0,
    reconciledRequests: 0,
    outstandingUSD: 0,
    outstandingTokens: 0,
    outstandingRequests: 0,
    activeTimeMs: 0,
    elapsedTimeMs: 0,
    remainingUSD,
  });
  const tracker = new BudgetReminderTracker({});
  assert.equal(tracker.next(snapshotAt(0.9)), undefined);
  assert.ok(tracker.next(snapshotAt(0.5))?.includes('$0.500000'));
  assert.equal(tracker.next(snapshotAt(0.4)), undefined, '50 percent does not fire twice');
  assert.ok(tracker.next(snapshotAt(0.19)));
  assert.equal(tracker.next(snapshotAt(0.05)), undefined, 'every configured threshold has fired');

  const periodic = new BudgetReminderTracker({ remainingFractions: [0.1], everyRequests: 2 });
  assert.equal(periodic.next(snapshotAt(0.9)), undefined);
  assert.ok(periodic.next(snapshotAt(0.9)), 'the every-N cadence fires without a threshold');
  assert.match(budgetReminderText(snapshotAt(0.25)), /no token ceiling/);
});

test('PI_BUDGET_AUTHORITY names the tree a child joins and reaches every bash child', () => {
  assert.equal(readBudgetAuthorityPath({}), undefined);
  assert.equal(readBudgetAuthorityPath({ PI_BUDGET_AUTHORITY: '  ' }), undefined);
  assert.equal(readBudgetAuthorityPath({ PI_BUDGET_AUTHORITY: '/tmp/x.json' }), '/tmp/x.json');

  const original = process.env['PI_BUDGET_AUTHORITY'];
  try {
    delete process.env['PI_BUDGET_AUTHORITY'];
    assert.equal(sanitizedBashEnvironment()['PI_BUDGET_AUTHORITY'], undefined, 'no tree, no variable');
    process.env['PI_BUDGET_AUTHORITY'] = '/tmp/tree.json';
    assert.equal(sanitizedBashEnvironment()['PI_BUDGET_AUTHORITY'], '/tmp/tree.json');
    // Set explicitly like PI_DEPTH: an explicit policy override still wins, so
    // a caller can deliberately keep a child out of the tree.
    assert.equal(
      sanitizedBashEnvironment({ environment: { PI_BUDGET_AUTHORITY: undefined } })['PI_BUDGET_AUTHORITY'],
      undefined,
    );
  } finally {
    if (original === undefined) delete process.env['PI_BUDGET_AUTHORITY'];
    else process.env['PI_BUDGET_AUTHORITY'] = original;
  }
});

/** A child process that hammers one authority; used for the concurrency proof. */
function writeReserverScript(directory: string): string {
  const path = join(directory, 'reserver.mjs');
  writeFileSync(
    path,
    `import { RootBudgetAuthority } from ${JSON.stringify(authorityModule)};
const [ledgerPath, runId, countText, amountText] = process.argv.slice(2);
const count = Number(countText);
const amountUSD = Number(amountText);
const authority = RootBudgetAuthority.join(ledgerPath, { runId, parentRunId: undefined });
const admitted = [];
const startedAt = Date.now();
for (let index = 0; index < count; index++) {
  const outcome = authority.reserve({
    runId,
    requestId: runId + '-' + index,
    amountUSD,
    tokens: 1,
  });
  if (outcome.admitted) admitted.push(runId + '-' + index);
}
process.stdout.write(JSON.stringify({ runId, admitted, startedAt, finishedAt: Date.now() }) + '\\n');
`,
    'utf8',
  );
  return path;
}

function runChild(script: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
}

test('twenty concurrent children never exceed the root, and no reservation is lost or double counted', async () => {
  const directory = workspace('pi-budget-concurrent-');
  const script = writeReserverScript(directory);
  const children = 20;
  const reservationsPerChild = 10;
  const amountUSD = 0.01;
  // Half the attempted reservations fit: the ceiling has to do real refusing.
  const ceilingUSD = (children * reservationsPerChild * amountUSD) / 2;
  const authority = RootBudgetAuthority.create({
    rootRunId: 'concurrent-root',
    ceilings: { maxSpendUSD: ceilingUSD },
    directory,
  });

  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: children }, (_, index) =>
      runChild(script, [authority.path, `child-${index}`, String(reservationsPerChild), String(amountUSD)]),
    ),
  );
  const elapsedMs = Date.now() - startedAt;

  const admittedIds: string[] = [];
  let contentionStart = Number.POSITIVE_INFINITY;
  let contentionEnd = 0;
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      runId: string;
      admitted: string[];
      startedAt: number;
      finishedAt: number;
    };
    admittedIds.push(...payload.admitted);
    contentionStart = Math.min(contentionStart, payload.startedAt);
    contentionEnd = Math.max(contentionEnd, payload.finishedAt);
  }

  const snapshot = authority.snapshot();
  const attempts = children * reservationsPerChild;
  assert.ok(admittedIds.length > 0, 'the children were admitted at all');
  assert.ok(admittedIds.length < attempts, 'the ceiling refused some of them');
  assert.equal(new Set(admittedIds).size, admittedIds.length, 'no request id was admitted twice');
  assert.ok(
    snapshot.admittedUSD <= ceilingUSD + 1e-9,
    `admitted ${snapshot.admittedUSD} must not exceed the root ceiling ${ceilingUSD}`,
  );
  assert.equal(
    snapshot.admittedRequests,
    admittedIds.length,
    'every reservation the children were told was admitted is in the ledger, and no others',
  );
  assert.equal(snapshot.outstandingRequests, admittedIds.length, 'nothing reconciled, so all of them are exposure');
  assert.equal(snapshot.outstandingUSD, snapshot.admittedUSD);
  const ledgerIds = authority.outstanding().map((row) => row.requestId).sort();
  assert.deepEqual(ledgerIds, [...admittedIds].sort(), 'the ledger rows are exactly the admitted reservations');
  for (const row of authority.outstanding()) {
    assert.deepEqual(row.ancestors, ['concurrent-root'], 'every child charges the root');
  }

  // The plan asks for this number before contained spawn depends on the lock.
  // Two figures: the contention window is the lock's own throughput, from the
  // first child entering its loop to the last leaving it; the fan-out figure
  // additionally carries twenty Node process startups.
  const contentionMs = Math.max(1, contentionEnd - contentionStart);
  const lockThroughput = (attempts / contentionMs) * 1_000;
  const fanOutThroughput = (attempts / elapsedMs) * 1_000;
  console.log(
    `root-budget lock throughput: ${attempts} reservation attempts from ${children} concurrent child processes ` +
      `in a ${contentionMs}ms contention window = ${lockThroughput.toFixed(1)} reservations/second ` +
      `(${(contentionMs / attempts).toFixed(2)}ms per reservation under the lock); ` +
      `${elapsedMs}ms including process startup = ${fanOutThroughput.toFixed(1)} reservations/second end to end`,
  );
  assert.ok(lockThroughput > 0);
});

test('a child killed after reserving keeps its exposure until an explicit reconcile', async () => {
  const directory = workspace('pi-budget-unknown-');
  const script = join(directory, 'stall.mjs');
  writeFileSync(
    script,
    `import { RootBudgetAuthority } from ${JSON.stringify(authorityModule)};
const [ledgerPath] = process.argv.slice(2);
const authority = RootBudgetAuthority.join(ledgerPath, { runId: 'stalled-child', parentRunId: 'unknown-root' });
const outcome = authority.reserve({ runId: 'stalled-child', requestId: 'stalled-request', amountUSD: 0.25, tokens: 40 });
process.stdout.write(JSON.stringify({ admitted: outcome.admitted }) + '\\n');
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  const authority = RootBudgetAuthority.create({
    rootRunId: 'unknown-root',
    ceilings: { maxSpendUSD: 1 },
    directory,
  });

  const child = spawn(process.execPath, [script, authority.path], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  await new Promise<void>((settle, fail) => {
    child.stdout.once('data', () => settle());
    child.once('error', fail);
  });
  child.kill('SIGKILL');
  await new Promise<void>((settle) => child.once('close', () => settle()));

  // The child is gone; its exposure is not.
  const afterKill = authority.snapshot();
  assert.equal(afterKill.outstandingUSD, 0.25);
  assert.equal(afterKill.outstandingRequests, 1);
  assert.equal(afterKill.remainingUSD, 0.75, 'the parent still cannot spend the killed child\'s reservation');
  assert.equal(authority.chargeFor('unknown-root').outstandingUSD, 0.25, 'charged to the root, not only the child');

  // Nothing releases it on its own, however long the parent waits.
  await new Promise((settle) => setTimeout(settle, 50));
  assert.equal(authority.snapshot().outstandingUSD, 0.25);
  assert.equal(authority.reserve({ runId: 'unknown-root', requestId: 'p-1', amountUSD: 0.8, tokens: 1 }).admitted, false);

  // Only an explicit terminal statement moves it.
  authority.reconcile('stalled-request', 0.02, 12);
  const afterReconcile = authority.snapshot();
  assert.equal(afterReconcile.outstandingUSD, 0);
  assert.equal(afterReconcile.reconciledUSD, 0.02);
  assert.equal(afterReconcile.remainingUSD, 0.98);
});
