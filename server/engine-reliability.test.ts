import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from './store';
import { WorkflowEngine, type AgentExecutor, type AgentReport } from './engine';
import { AgentExecutionError } from './execution-errors';

const empty: AgentReport = { findings: [], messages: [], assignments: [] };
const request: AgentReport = { ...empty, escalation: { reason: 'Please verify concurrent updates.' } };
const observation: NonNullable<AgentReport['findings']>[number] = { title: 'Concurrent update', description: 'Observed original evidence.', severity: 'medium', file: 'app.ts', line: 1 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(supervisor = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-engine-reliability-'));
  const store = await StateStore.open(path.join(directory, 'state.json'));
  await store.update(state => {
    const node = state.workflow.nodes[0];
    node.data.modelId = 'qwen';
    state.workflow.nodes = [node]; state.workflow.edges = [];
    state.workflow.settings = { ...state.workflow.settings, mode: 'once', entryNodeId: node.id, ...(supervisor ? { supervisorModelId: 'claude' } : {}) };
  });
  return { store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('stop holds the lifecycle lock until delayed executor cleanup drains, with no late reports or overlapping restart', async () => {
  const { store, cleanup } = await fixture();
  const entered = deferred(); const cancelling = deferred(); const release = deferred();
  let calls = 0; let running = 0; let maximumRunning = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    calls++; running++; maximumRunning = Math.max(maximumRunning, running);
    if (calls === 1) {
      entered.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { cancelling.resolve(); resolve(); }, { once: true }));
      await release.promise;
      running--;
      return { ...empty, findings: [observation] };
    }
    running--;
    return empty;
  } });
  try {
    await engine.start('pi'); await entered.promise;
    const stopping = engine.stop(); await cancelling.promise;
    assert.equal(engine.isRunning, true, 'Workflow/model editing must remain locked during cleanup.');
    const restarting = engine.start('pi');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    release.resolve();
    await stopping; await restarting; await engine.waitForIdle();
    assert.equal(maximumRunning, 1);
    assert.equal(store.get().runs[1].status, 'stopped');
    assert.equal(store.get().runs[0].status, 'completed');
    assert.equal(store.get().findings.length, 0, 'An aborted executor cannot publish a late report.');
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('stop during the initial start commit cannot escape cancellation or leave a running record', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-engine-start-stop-'));
  const entered = deferred(); const release = deferred(); let pause = false; let calls = 0;
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: async phase => {
    if (pause && phase === 'primary') { pause = false; entered.resolve(); await release.promise; }
  } });
  const engine = new WorkflowEngine(store, { piExecutor: async () => { calls++; return empty; } });
  try {
    pause = true;
    const starting = engine.start('pi'); await entered.promise;
    const stopping = engine.stop();
    assert.equal(engine.isRunning, true);
    release.resolve(); await starting; await stopping; await engine.waitForIdle();
    assert.equal(calls, 0);
    assert.equal(store.get().runs[0].status, 'stopped');
    assert.equal(engine.isRunning, false);
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await rm(directory, { recursive: true, force: true }); }
});

test('an initial persistence failure publishes no phantom run and a subsequent start works', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-engine-start-failure-'));
  let fail = false;
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: phase => {
    if (fail && phase === 'primary') { fail = false; throw new Error('Injected start write failure'); }
  } });
  const engine = new WorkflowEngine(store, { demoStepMs: 0 });
  try {
    await store.update(state => { state.workflow.settings.mode = 'once'; });
    fail = true;
    await assert.rejects(engine.start('demo'), /start write failure/);
    assert.equal(engine.isRunning, false); assert.equal(store.get().runs.length, 0);
    await engine.start('demo'); await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
  } finally { await engine.stop(); await engine.waitForIdle(); await rm(directory, { recursive: true, force: true }); }
});

test('configuration changes and run starts share one lock through their durable commits', async () => {
  const { store, cleanup } = await fixture();
  const entered = deferred(); const release = deferred(); const executing = deferred();
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    assert.equal(context.workflow.name, 'Committed configuration');
    executing.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return empty;
  } });
  try {
    const editing = engine.whenIdle(async () => {
      entered.resolve(); await release.promise;
      return store.update(state => { state.workflow.name = 'Committed configuration'; });
    });
    await entered.promise;
    const starting = engine.start('pi');
    assert.equal(store.get().runs.length, 0, 'A start must wait for a prior configuration commit.');
    release.resolve(); await editing; await starting; await executing.promise;
    let mutated = false;
    await assert.rejects(engine.whenIdle(async () => { mutated = true; }), /Stop the active run/);
    assert.equal(mutated, false, 'A queued edit must check the active run before executing.');
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a failed stop commit keeps configuration and restart locked until a durable stop succeeds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-engine-stop-failure-'));
  let fail = false; const entered = deferred();
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: phase => {
    if (fail && phase === 'primary') { fail = false; throw new Error('Injected stop write failure'); }
  } });
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    entered.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return empty;
  } });
  try {
    await engine.start('pi'); await entered.promise; fail = true;
    await assert.rejects(engine.stop(), /stop write failure/);
    assert.equal(engine.isRunning, true); assert.equal(store.get().runs[0].status, 'running');
    await assert.rejects(engine.start('pi'), /already active/);
    await assert.rejects(engine.whenIdle(async () => {}), /Stop the active run/);
    await engine.stop();
    assert.equal(engine.isRunning, false); assert.equal(store.get().runs[0].status, 'stopped');
  } finally { fail = false; await engine.stop(); await engine.waitForIdle(); await rm(directory, { recursive: true, force: true }); }
});

test('unrecoverable run persistence stays locked until Stop can durably close the run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-engine-storage-lock-'));
  let failures = 0; let calls = 0;
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: phase => {
    if (phase === 'primary' && failures > 0) { failures--; throw new Error('Injected full disk'); }
  } });
  await store.update(state => { state.workflow.settings.mode = 'once'; });
  const engine = new WorkflowEngine(store, { piExecutor: async () => {
    if (++calls === 1) failures = 2; // The report commit and failed-run commit both fail.
    return { ...empty, findings: [observation] };
  } });
  try {
    await engine.start('pi');
    await assert.rejects(engine.waitForIdle(), /full disk/);
    assert.equal(engine.isRunning, true);
    assert.equal(store.get().runs[0].status, 'running');
    assert.equal(store.get().findings.length, 0);
    await assert.rejects(engine.start('pi'), /already active/);
    await engine.stop();
    assert.equal(engine.isRunning, false);
    assert.equal(store.get().runs[0].status, 'stopped');
    await engine.start('pi'); await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
  } finally { failures = 0; await engine.stop(); await engine.waitForIdle(); await rm(directory, { recursive: true, force: true }); }
});

test('no supervisor is called unless explicitly configured and needed', async () => {
  for (const supervisor of [false, true]) {
    const { store, cleanup } = await fixture(supervisor);
    let calls = 0;
    const engine = new WorkflowEngine(store, { piExecutor: async () => { calls++; return supervisor ? empty : request; } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      assert.equal(calls, 1); assert.equal(store.get().runs[0].status, 'completed');
      assert.equal(store.get().runs[0].escalations, 0);
      if (!supervisor) assert.ok(store.get().messages.some(message => /No supervisor is configured/.test(message.text)));
    } finally { await cleanup(); }
  }
  const { store, cleanup } = await fixture(); let calls = 0;
  try {
    const engine = new WorkflowEngine(store, { piExecutor: async () => { calls++; throw new AgentExecutionError('Local server offline', 'transient'); } });
    await engine.start('pi'); await engine.waitForIdle();
    assert.equal(calls, 1); assert.equal(store.get().runs[0].status, 'failed');
    assert.match(store.get().runs[0].error ?? '', /Local server offline/);
  } finally { await cleanup(); }
});

test('explicit escalation preserves verified primary findings and the same confined node tools for one supervisor visit', async () => {
  const { store, cleanup } = await fixture(true); let calls = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    calls++;
    if (!context.escalation) return { ...request, findings: [observation], execution: { modelId: 'qwen', attempts: 2, requests: 3, durationMs: 50, inputTokens: 100, outputTokens: 20 } };
    assert.equal(context.node.id, 'crawler'); assert.deepEqual(context.node.data.tools, ['read']);
    assert.equal(context.node.data.modelId, 'claude'); assert.equal(context.escalation.originalModelId, 'qwen');
    assert.equal(context.escalation.reason, request.escalation?.reason);
    assert.equal(context.findings[0].description, observation.description);
    return { ...empty, findings: [{ ...observation, description: 'Supervisor verified current evidence.', severity: 'high' }] };
  } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const state = store.get();
    assert.equal(calls, 2); assert.equal(state.runs[0].status, 'completed'); assert.equal(state.runs[0].steps, 1);
    assert.equal(state.runs[0].escalations, 1); assert.equal(state.findings.length, 1);
    assert.equal(state.findings[0].description, 'Supervisor verified current evidence.');
    assert.ok(state.messages.some(message => /2 attempt\(s\), 3 request\(s\), 50ms, 100 input and 20 output tokens/.test(message.text)));
    assert.ok(state.messages.some(message => /Escalating Scout to Claude Sonnet/.test(message.text)));
  } finally { await cleanup(); }
});

test('only classified recoverable failures escalate; configuration, cancellation and unknown errors do not', async () => {
  const errors = [new AgentExecutionError('Offline after retries', 'transient'), new AgentExecutionError('Invalid final report', 'report'), new AgentExecutionError('Missing credentials', 'configuration'), new DOMException('Cancelled', 'AbortError'), new Error('Unknown failure')];
  for (const error of errors) {
    const { store, cleanup } = await fixture(true); let calls = 0;
    const engine = new WorkflowEngine(store, { piExecutor: async context => { calls++; if (!context.escalation) throw error; return empty; } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      const escalatable = error instanceof AgentExecutionError && error.code !== 'configuration';
      assert.equal(calls, escalatable ? 2 : 1);
      assert.equal(store.get().runs[0].status, escalatable ? 'completed' : 'failed');
      assert.equal(store.get().runs[0].escalations, escalatable ? 1 : 0);
    } finally { await cleanup(); }
  }
});

test('per-cycle supervisor allowance resets each cycle and blocks additional requests before execution', async () => {
  const { store, cleanup } = await fixture(true); let calls = 0;
  const executor: AgentExecutor = async context => { calls++; return context.escalation ? empty : { ...request, findings: [observation] }; };
  try {
    await store.update(state => { state.workflow.settings.mode = 'loop'; state.workflow.settings.maxCycles = 2; state.workflow.settings.intervalSeconds = 0; });
    let engine = new WorkflowEngine(store, { piExecutor: executor });
    await engine.start('pi'); await engine.waitForIdle();
    assert.equal(calls, 4); assert.equal(store.get().runs[0].escalations, 2); assert.equal(store.get().runs[0].status, 'completed');
    await store.update(state => {
      const first = state.workflow.nodes[0];
      state.workflow.nodes.push({ ...first, id: 'second', data: { ...first.data, label: 'Second reviewer' } });
      state.workflow.edges = [{ id: 'next', source: first.id, target: 'second' }];
      state.workflow.settings.mode = 'once';
    });
    calls = 0; engine = new WorkflowEngine(store, { piExecutor: executor });
    await engine.start('pi'); await engine.waitForIdle();
    assert.equal(calls, 3, 'Two primary calls plus one supervisor call; no second supervisor request.');
    assert.equal(store.get().runs[0].escalations, 1); assert.equal(store.get().runs[0].status, 'failed');
    assert.match(store.get().runs[0].error ?? '', /allowance of 1 visit per cycle is exhausted/);
    assert.equal(store.get().findings.length, 2, 'Both valid primary reports survive exhaustion of the supervisor allowance.');
  } finally { await cleanup(); }
});

test('the run-wide supervisor ceiling prevents repeated cycle allowances from making unbounded requests', async () => {
  const { store, cleanup } = await fixture(true); let calls = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => { calls++; return context.escalation ? empty : { ...request, findings: [{ ...observation, description: `Evidence from cycle ${context.cycle}` }] }; } });
  try {
    await store.update(state => {
      state.workflow.settings.mode = 'loop'; state.workflow.settings.maxCycles = 2; state.workflow.settings.intervalSeconds = 0;
      state.workflow.settings.maxEscalationsPerCycle = 1; state.workflow.settings.maxEscalationsPerRun = 1;
    });
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(calls, 3, 'The second cycle may call its primary but must not call the supervisor again.');
    assert.equal(run.escalations, 1); assert.equal(run.steps, 1); assert.equal(run.cycle, 2); assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /allowance of 1 visit per run is exhausted/);
    assert.ok(store.get().messages.some(message => /supervisor visits this cycle and 1 of 1 this run/.test(message.text)));
    assert.equal(store.get().findings[0].description, 'Evidence from cycle 2', 'The last valid local review is retained even without another supervisor visit.');
  } finally { await cleanup(); }
});

test('recursive escalation and exhausted supervisor plans fail clearly without extra model calls', async () => {
  for (const supervisorFailure of ['recursive', 'plan'] as const) {
    const { store, cleanup } = await fixture(true); let calls = 0;
    const engine = new WorkflowEngine(store, { piExecutor: async context => {
      calls++;
      if (!context.escalation) return { ...request, findings: [observation] };
      if (supervisorFailure === 'plan') throw new AgentExecutionError('ChatGPT plan usage allowance is exhausted. Try again after reset.', 'configuration');
      return request;
    } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      assert.equal(calls, 2); assert.equal(store.get().runs[0].status, 'failed');
      assert.equal(store.get().runs[0].escalations, 1); assert.equal(store.get().findings.length, 1, 'Valid primary evidence survives a supervisor failure.');
      assert.match(store.get().runs[0].error ?? '', supervisorFailure === 'plan' ? /plan usage allowance is exhausted/ : /Further model calls are blocked/);
    } finally { await cleanup(); }
  }
});

test('a supervisor already assigned to the agent cannot recurse or discard verified primary evidence', async () => {
  const { store, cleanup } = await fixture(true); let calls = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async () => { calls++; return { ...request, findings: [observation] }; } });
  try {
    await store.update(state => { state.workflow.nodes[0].data.modelId = 'claude'; });
    await engine.start('pi'); await engine.waitForIdle();
    const state = store.get();
    assert.equal(calls, 1); assert.equal(state.runs[0].escalations, 0); assert.equal(state.runs[0].steps, 0);
    assert.equal(state.runs[0].status, 'failed'); assert.match(state.runs[0].error ?? '', /recursive escalation is not allowed/);
    assert.equal(state.findings.length, 1); assert.equal(state.findings[0].description, observation.description);
  } finally { await cleanup(); }
});

test('recurring findings refresh evidence and reopen resolved observations without duplicating IDs', async () => {
  const { store, cleanup } = await fixture(); let pass = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async () => ({ ...empty, findings: [{ ...observation, description: ++pass === 1 ? 'Original' : 'Current evidence', line: pass, severity: pass === 1 ? 'medium' : 'high', screenshot: `/api/screenshots/${pass}.png` }] }) });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const original = store.get().findings[0];
    await store.update(state => { state.findings[0].status = 'resolved'; });
    await engine.start('pi'); await engine.waitForIdle();
    const current = store.get().findings;
    assert.equal(current.length, 1); assert.equal(current[0].id, original.id); assert.equal(current[0].createdAt, original.createdAt);
    assert.equal(current[0].status, 'open'); assert.equal(current[0].description, 'Current evidence');
    assert.equal(current[0].line, 2); assert.equal(current[0].severity, 'high'); assert.equal(current[0].screenshot, '/api/screenshots/2.png');
  } finally { await cleanup(); }
});
