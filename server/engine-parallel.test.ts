import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelConfig, WorkflowEdge } from '../shared/types';
import { StateStore } from './store';
import { WorkflowEngine, type AgentReport, type ExecutionContext } from './engine';

const empty: AgentReport = { findings: [], messages: [], assignments: [] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean, explanation: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(explanation);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function cancelled(context: ExecutionContext): Promise<void> {
  if (context.signal.aborted) return Promise.resolve();
  return new Promise(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
}

function report(id: string): AgentReport {
  return {
    findings: [{ title: `Evidence from ${id}`, description: `${id} verified its assigned files.`, severity: 'low', file: `${id}.ts` }],
    messages: [{ to: 'join', text: `Committed review from ${id}.` }], assignments: [],
  };
}

async function fixture(branches: string[], options: { workers?: number; join?: boolean; aliases?: boolean; supervisor?: boolean; beforeCommit?: (phase: 'backup' | 'primary') => void | Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-parallel-'));
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: options.beforeCommit });
  await store.update(state => {
    const template = state.workflow.nodes[0];
    const ids = ['entry', ...branches, ...(options.join ? ['join'] : [])];
    state.models = ids.map((id, index): ModelConfig => ({
      id: `model-${id}`, name: `Model ${id}`, provider: 'custom', modelId: 'fixture', kind: 'local',
      baseUrl: `http://machine-${index}:11434/v1`, apiKeyEnv: '', enabled: true,
    }));
    if (options.aliases) {
      branches.forEach((id, index) => {
        const model = state.models.find(item => item.id === `model-${id}`)!;
        model.baseUrl = index === 0 ? 'http://MODEL-LAN:80/v1' : 'http://model-lan/compatible/v1';
        model.maxConcurrentRequests = index === 0 ? 1 : 3;
      });
    }
    if (options.supervisor) state.models.push({
      id: 'supervisor', name: 'Supervisor', provider: 'custom', modelId: 'fixture', kind: 'cloud',
      baseUrl: 'https://supervisor.example/v1', apiKeyEnv: '', enabled: true, maxConcurrentRequests: 3,
    });
    state.workflow.nodes = ids.map(id => ({
      ...structuredClone(template), id, data: { ...structuredClone(template.data), label: id, modelId: `model-${id}` },
    }));
    const edges: WorkflowEdge[] = branches.map(id => ({ id: `entry-${id}`, source: 'entry', target: id }));
    if (options.join) edges.push(...branches.map(id => ({ id: `${id}-join`, source: id, target: 'join' })));
    state.workflow.edges = edges;
    state.workflow.settings = {
      ...state.workflow.settings, mode: 'once', entryNodeId: 'entry',
      ...(options.workers === undefined ? {} : { maxParallelAgents: options.workers }),
      ...(options.supervisor ? { supervisorModelId: 'supervisor', maxEscalationsPerCycle: 1, maxEscalationsPerRun: 1 } : {}),
    };
  });
  return { store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('independent machines overlap and a join receives both committed reports and messages', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['left', 'right'], { workers: 2, join: true });
  const release = deferred(); const entered = new Set<string>();
  let running = 0; let peak = 0; let joined = false;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (['left', 'right'].includes(context.node.id)) {
      running++; peak = Math.max(peak, running); entered.add(context.node.id);
      await release.promise;
      running--;
      return report(context.node.id);
    }
    if (context.node.id === 'join') {
      joined = true;
      assert.deepEqual(context.findings.map(item => item.title).sort(), ['Evidence from left', 'Evidence from right']);
      assert.deepEqual(context.messages.filter(item => item.type === 'message').map(item => item.from).sort(), ['left', 'right']);
    }
    return empty;
  } });
  try {
    await engine.start('pi');
    await until(() => entered.size === 2, 'Two independent branches must enter before either is released.');
    assert.equal(joined, false, 'A join cannot start before its predecessor reports commit.');
    assert.deepEqual(store.get().runs[0].activeNodeIds?.sort(), ['left', 'right']);
    release.resolve(); await engine.waitForIdle();
    assert.equal(peak, 2); assert.equal(joined, true);
    const run = store.get().runs[0];
    assert.equal(run.status, 'completed'); assert.equal(run.steps, 4); assert.equal(run.activeNodeIds?.length ?? 0, 0);
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('parallel execution is opt-in and the global worker ceiling bounds a wider fan-out', { timeout: 15000 }, async () => {
  for (const workers of [undefined, 2]) {
    const { store, cleanup } = await fixture(['one', 'two', 'three', 'four'], { workers });
    let running = 0; let peak = 0; let visits = 0;
    const release = deferred(); const entered = new Set<string>();
    const engine = new WorkflowEngine(store, { piExecutor: async context => {
      if (context.node.id === 'entry') return empty;
      visits++; entered.add(context.node.id); running++; peak = Math.max(peak, running);
      await release.promise; running--;
      return empty;
    } });
    try {
      await engine.start('pi');
      await until(() => entered.size >= (workers ?? 1), 'The configured number of worker slots should be used.');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(entered.size, workers ?? 1, 'Further branches must wait for an available global slot.');
      release.resolve(); await engine.waitForIdle();
      assert.equal(visits, 4); assert.equal(peak, workers ?? 1); assert.equal(store.get().runs[0].status, 'completed');
    } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('endpoint aliases share the strictest configured limit across model names and URL paths', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['one', 'two', 'three'], { workers: 3, aliases: true });
  const release = deferred(); const entered: string[] = [];
  let running = 0; let peak = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'entry') return empty;
    entered.push(context.node.id); running++; peak = Math.max(peak, running);
    await release.promise; running--;
    return empty;
  } });
  try {
    await engine.start('pi'); await until(() => entered.length >= 1, 'One endpoint visit should begin.');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(entered.length, 1, 'Aliases cannot bypass the shared server capacity of one.');
    release.resolve(); await engine.waitForIdle();
    assert.equal(entered.length, 3); assert.equal(peak, 1); assert.equal(store.get().runs[0].status, 'completed');
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a queued visit for one busy machine does not occupy a worker needed by another machine', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['one', 'same-machine', 'other-machine'], { workers: 2 });
  await store.update(state => {
    state.models.find(model => model.id === 'model-same-machine')!.baseUrl = state.models.find(model => model.id === 'model-one')!.baseUrl;
  });
  const release = deferred(); const entered = new Set<string>();
  let running = 0; let peak = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'entry') return empty;
    entered.add(context.node.id); running++; peak = Math.max(peak, running);
    await release.promise; running--;
    return empty;
  } });
  try {
    await engine.start('pi');
    await until(() => entered.has('one') && entered.has('other-machine'), 'The second machine must run while an alias of the first machine waits.');
    assert.equal(entered.has('same-machine'), false);
    assert.deepEqual(store.get().runs[0].activeNodeIds?.sort(), ['one', 'other-machine']);
    release.resolve(); await engine.waitForIdle();
    assert.equal(entered.size, 3); assert.equal(peak, 2); assert.equal(store.get().runs[0].status, 'completed');
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a new cycle waits for every parallel branch from the preceding cycle', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['left', 'right'], { workers: 2 });
  await store.update(state => {
    state.workflow.settings.mode = 'loop'; state.workflow.settings.maxCycles = 2; state.workflow.settings.intervalSeconds = 0;
  });
  const left = deferred(); const right = deferred(); const entered = new Set<string>(); const visits: number[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    visits.push(context.cycle);
    if (context.cycle === 1 && context.node.id !== 'entry') {
      entered.add(context.node.id);
      await (context.node.id === 'left' ? left.promise : right.promise);
    }
    return empty;
  } });
  try {
    await engine.start('pi'); await until(() => entered.size === 2, 'Both first-cycle branches should run together.');
    left.resolve(); await until(() => store.get().workflow.nodes.find(node => node.id === 'left')?.data.status === 'done', 'The first branch should finish independently.');
    assert.equal(visits.includes(2), false, 'One finished branch cannot advance the shared cycle while a sibling is still active.');
    assert.equal(store.get().runs[0].cycle, 1);
    right.resolve(); await engine.waitForIdle();
    assert.deepEqual(visits, [1, 1, 1, 2, 2, 2]);
    assert.equal(store.get().runs[0].steps, 6); assert.equal(store.get().runs[0].status, 'completed');
  } finally { left.resolve(); right.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a branch failure cancels queued work and drains siblings before failure unlocks the run', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['failure', 'slow', 'queued'], { workers: 2 });
  const fail = deferred(); const releaseCleanup = deferred(); const entered = new Set<string>();
  let draining = false;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    entered.add(context.node.id);
    if (context.node.id === 'entry') return report('entry');
    if (context.node.id === 'failure') { await fail.promise; throw new Error('Injected branch failure'); }
    if (context.node.id === 'slow') {
      await cancelled(context); draining = true; await releaseCleanup.promise;
      return report('late-sibling');
    }
    return empty;
  } });
  try {
    await engine.start('pi'); await until(() => entered.has('slow'), 'The sibling must be executing when the failure occurs.');
    fail.resolve(); await until(() => draining, 'A first failure must immediately abort the running sibling.');
    assert.equal(engine.isRunning, true); assert.equal(store.get().runs[0].status, 'running');
    await assert.rejects(engine.start('pi'), /already active/);
    assert.equal(entered.has('queued'), false, 'Queued branch bodies cannot start after the first failure.');
    releaseCleanup.resolve(); await engine.waitForIdle();
    const state = store.get();
    assert.equal(engine.isRunning, false); assert.equal(state.runs[0].status, 'failed');
    assert.match(state.runs[0].error ?? '', /Injected branch failure/);
    assert.equal(state.workflow.nodes.find(node => node.id === 'failure')?.data.status, 'error');
    assert.deepEqual(state.findings.map(item => item.title), ['Evidence from entry'], 'Committed evidence survives while aborted late reports are discarded.');
    assert.equal(state.runs[0].activeNodeIds?.length ?? 0, 0);
  } finally { fail.resolve(); releaseCleanup.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('an activity cleanup commit failure aborts endpoint waiters before releasing capacity', { timeout: 15000 }, async () => {
  let inject = false;
  const { store, cleanup } = await fixture(['one', 'two'], { workers: 2, aliases: true, beforeCommit: phase => {
    if (inject && phase === 'primary') { inject = false; throw new Error('Injected activity cleanup failure'); }
  } });
  const calls: string[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    calls.push(context.node.id);
    if (context.node.id === 'one') inject = true;
    return empty;
  } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    assert.deepEqual(calls, ['entry', 'one'], 'A failed activity save must abort waiters before any replacement visit body enters.');
    assert.equal(store.get().runs[0].status, 'failed'); assert.match(store.get().runs[0].error ?? '', /Injected activity cleanup failure/);
    assert.equal(store.get().workflow.nodes.find(node => node.id === 'one')?.data.status, 'error');
  } finally { inject = false; await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('screenshot leases protect pending report evidence until its durable commit completes', { timeout: 15000 }, async () => {
  const committing = deferred(); const release = deferred();
  let captured = false; let writes = 0;
  const screenshot = '/api/screenshots/00000000-0000-4000-8000-000000000001.png';
  const { store, cleanup } = await fixture(['one'], { workers: 2, beforeCommit: async phase => {
    // The visit first clears its activity, then commits its validated report.
    if (captured && phase === 'primary' && ++writes === 2) { committing.resolve(); await release.promise; }
  } });
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'entry') return empty;
    context.onScreenshot?.(screenshot); captured = true;
    return { ...empty, findings: [{ title: 'Visual evidence', description: 'Screenshot verified the observation.', severity: 'low', screenshot }] };
  } });
  try {
    await engine.start('pi'); await until(() => writes === 2, 'The report commit should reach the persistence barrier.');
    await committing.promise;
    assert.deepEqual(engine.pendingScreenshots, [screenshot], 'Retention must preserve evidence between model cleanup and report persistence.');
    assert.equal(store.get().findings.length, 0, 'The gated report has not yet been published.');
    release.resolve(); await engine.waitForIdle();
    assert.deepEqual(engine.pendingScreenshots, []);
    assert.equal(store.get().findings[0].screenshot, screenshot); assert.equal(store.get().runs[0].status, 'completed');
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('Stop drains every parallel visit and endpoint waiter before a queued replacement run begins', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['one', 'two', 'queued'], { workers: 2 });
  const releaseCleanup = deferred(); const entered = new Set<string>(); const cancelling = new Set<string>();
  let firstRunId: string | undefined; let replacementCalls = 0; let active = 0; let peak = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    firstRunId ??= context.run.id;
    if (context.run.id !== firstRunId) { replacementCalls++; assert.equal(active, 0); return empty; }
    if (context.node.id === 'entry') return empty;
    entered.add(context.node.id); active++; peak = Math.max(peak, active);
    await cancelled(context); cancelling.add(context.node.id); await releaseCleanup.promise; active--;
    return report('late-stop');
  } });
  try {
    await engine.start('pi'); await until(() => entered.size === 2, 'Two visits must enter before stopping.');
    const stopping = engine.stop(); await until(() => cancelling.size === 2, 'Stop must reach all active workers.');
    const restarting = engine.start('pi');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(engine.isRunning, true); assert.equal(replacementCalls, 0); assert.equal(entered.has('queued'), false);
    releaseCleanup.resolve(); await stopping; await restarting; await engine.waitForIdle();
    const state = store.get();
    assert.equal(peak, 2); assert.equal(replacementCalls, 4);
    assert.equal(state.runs[1].status, 'stopped'); assert.equal(state.runs[0].status, 'completed');
    assert.equal(state.findings.length, 0, 'Stopped workers cannot publish reports after cleanup.');
  } finally { releaseCleanup.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('Stop cancels endpoint waiters without invoking their executor bodies', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['one', 'two', 'three'], { workers: 3, aliases: true });
  const releaseCleanup = deferred(); const entered: string[] = [];
  let draining = false;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'entry') return empty;
    entered.push(context.node.id);
    await cancelled(context); draining = true; await releaseCleanup.promise;
    return empty;
  } });
  try {
    await engine.start('pi'); await until(() => entered.length === 1, 'One visit should occupy the shared endpoint.');
    await new Promise(resolve => setTimeout(resolve, 20));
    const stopping = engine.stop(); await until(() => draining, 'The active endpoint visit must begin draining.');
    assert.equal(engine.isRunning, true); assert.equal(entered.length, 1);
    releaseCleanup.resolve(); await stopping; await engine.waitForIdle();
    assert.equal(entered.length, 1, 'Aborted endpoint waiters cannot be handed a permit during cleanup.');
    assert.equal(store.get().runs[0].status, 'stopped'); assert.equal(engine.isRunning, false);
  } finally { releaseCleanup.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('supervisor and primary visits share the endpoint limit without retaining a primary permit', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['left', 'right'], { workers: 2, aliases: true, supervisor: true });
  await store.update(state => {
    const supervisor = state.models.find(model => model.id === 'supervisor')!;
    supervisor.baseUrl = 'http://model-lan/supervisor/v1';
  });
  let running = 0; let peak = 0; let supervisorCalls = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'entry') return empty;
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setImmediate(resolve));
    running--;
    if (context.escalation) { supervisorCalls++; return empty; }
    return context.node.id === 'left' ? { ...empty, escalation: { reason: 'Verify left.' } } : empty;
  } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    assert.equal(peak, 1); assert.equal(supervisorCalls, 1);
    assert.equal(store.get().runs[0].status, 'completed'); assert.equal(store.get().runs[0].escalations, 1);
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('simultaneous escalation requests cannot race the per-cycle supervisor allowance', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture(['left', 'right'], { workers: 2, supervisor: true });
  const release = deferred(); const primary = new Set<string>();
  let supervisors = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'entry') return empty;
    if (context.escalation) {
      supervisors++;
      await cancelled(context);
      return empty;
    }
    primary.add(context.node.id); await release.promise;
    return { ...report(context.node.id), escalation: { reason: `Verify ${context.node.id}.` } };
  } });
  try {
    await engine.start('pi'); await until(() => primary.size === 2, 'Both primary reviewers must be ready to escalate concurrently.');
    release.resolve(); await engine.waitForIdle();
    const state = store.get();
    assert.ok(supervisors <= 1, 'Only one supervisor call may pass an allowance of one.');
    assert.equal(state.runs[0].escalations, 1); assert.equal(state.runs[0].status, 'failed');
    assert.match(state.runs[0].error ?? '', /allowance of 1 visit per cycle is exhausted/);
    assert.deepEqual(state.findings.map(item => item.title).sort(), ['Evidence from left', 'Evidence from right']);
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});
