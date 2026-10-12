import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRoutingSettings } from '../shared/defaults';
import type { RoutingAnswer, RoutingChoice, RoutingSettings } from '../shared/types';
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

function answer(choice: RoutingChoice = 'assigned', confidence = 0.99): RoutingAnswer {
  const probabilities = { assigned: 0.005, supervisor: 0.005, review: 0.005 };
  probabilities[choice] = 0.99;
  return { choice, confidence, probabilities, modelId: 'jev-fixture-1', durationMs: 3, inputTokens: 20 };
}

async function fixture(options: { branches?: number; workers?: number; supervisor?: boolean; routing?: Partial<RoutingSettings>; beforeCommit?: (phase: 'backup' | 'primary') => void | Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-routing-engine-'));
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: options.beforeCommit });
  await store.update(state => {
    const template = state.workflow.nodes[0];
    const ids = Array.from({ length: options.branches ?? 1 }, (_, index) => `node-${index}`);
    const branched = ids.length > 1;
    const allIds = [...(branched ? ['entry'] : []), ...ids];
    state.models = allIds.map((id, index) => ({
      id: `model-${id}`, name: `Model ${id}`, provider: 'custom', modelId: 'fixture', kind: id === 'entry' ? 'cloud' : 'local',
      baseUrl: `http://127.0.0.1:${18100 + index}/v1`, apiKeyEnv: '', enabled: true,
    }));
    if (options.supervisor !== false) state.models.push({
      id: 'supervisor', name: 'Supervisor', provider: 'custom', modelId: 'fixture', kind: 'cloud',
      baseUrl: 'http://127.0.0.1:18200/v1', apiKeyEnv: '', enabled: true,
    });
    state.workflow.nodes = allIds.map(id => ({
      ...structuredClone(template), id, data: { ...structuredClone(template.data), label: id, modelId: `model-${id}` },
    }));
    state.workflow.edges = branched ? ids.map(id => ({ id: `entry-${id}`, source: 'entry', target: id })) : [];
    state.workflow.settings = {
      ...state.workflow.settings, mode: 'once', entryNodeId: allIds[0], maxParallelAgents: options.workers ?? 1,
      ...(options.supervisor === false ? {} : { supervisorModelId: 'supervisor' }),
      routing: { ...defaultRoutingSettings, mode: 'active', baseUrl: 'http://127.0.0.1:18090/v1', ...options.routing },
    };
  });
  return { store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('legacy, disabled and demo runs never call the decision model', { timeout: 15000 }, async () => {
  for (const scenario of ['legacy', 'off', 'demo'] as const) {
    const { store, cleanup } = await fixture();
    await store.update(state => {
      if (scenario === 'legacy') delete state.workflow.settings.routing;
      else if (scenario === 'off') state.workflow.settings.routing!.mode = 'off';
    });
    let decisions = 0; let reviews = 0;
    const engine = new WorkflowEngine(store, {
      demoStepMs: 0, routingExecutor: async () => { decisions++; return answer('supervisor'); },
      piExecutor: async () => { reviews++; return empty; },
    });
    try {
      await engine.start(scenario === 'demo' ? 'demo' : 'pi'); await engine.waitForIdle();
      assert.equal(decisions, 0); assert.equal(reviews, scenario === 'demo' ? 0 : 1);
      assert.equal(store.get().runs[0].status, 'completed'); assert.equal(store.get().runs[0].decisionCount ?? 0, 0);
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('cloud primaries and a primary already assigned the supervisor bypass local routing', { timeout: 15000 }, async () => {
  for (const scenario of ['cloud', 'supervisor'] as const) {
    const { store, cleanup } = await fixture();
    await store.update(state => {
      if (scenario === 'cloud') state.models.find(model => model.id === 'model-node-0')!.kind = 'cloud';
      else state.workflow.nodes[0].data.modelId = 'supervisor';
    });
    let decisions = 0;
    const visits: string[] = [];
    const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer(); }, piExecutor: async context => { visits.push(context.node.data.modelId); return empty; } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      assert.equal(decisions, 0); assert.deepEqual(visits, [scenario === 'cloud' ? 'model-node-0' : 'supervisor']);
      assert.equal(store.get().runs[0].status, 'completed');
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('shadow decisions never alter assigned reviews, including invalid and unavailable decisions', { timeout: 15000 }, async () => {
  for (const scenario of ['supervisor', 'review', 'low-confidence', 'malformed', 'unavailable'] as const) {
    const { store, cleanup } = await fixture({ routing: { mode: 'shadow' } });
    const visits: string[] = [];
    const engine = new WorkflowEngine(store, {
      routingExecutor: async () => {
        if (scenario === 'unavailable') throw new Error('Fixture decision service unavailable.');
        if (scenario === 'malformed') return { choice: 'arbitrary-model', confidence: 1 } as unknown as RoutingAnswer;
        return answer(scenario === 'review' ? 'review' : scenario === 'supervisor' ? 'supervisor' : 'assigned', scenario === 'low-confidence' ? 0.2 : 0.99);
      },
      piExecutor: async context => { visits.push(context.node.data.modelId); return empty; },
    });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      const run = store.get().runs[0];
      assert.deepEqual(visits, ['model-node-0']); assert.equal(run.status, 'completed');
      assert.equal(run.escalations, 0); assert.equal(run.decisionCount, 1);
      assert.equal(run.decisions?.length, 1);
      assert.equal(run.decisions?.[0].status, ['malformed', 'unavailable'].includes(scenario) ? 'error' : 'completed');
      assert.equal(run.decisions?.[0].selectedModelId, 'model-node-0');
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('shadow routing preserves an assigned worker request for stronger review without classifying the supervisor again', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture({ routing: { mode: 'shadow' } });
  let decisions = 0; const visits: string[] = [];
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer('review'); }, piExecutor: async context => {
    visits.push(context.node.data.modelId);
    if (context.escalation) return empty;
    return { ...empty, findings: [{ title: 'Local evidence', description: 'Primary evidence remains available.', severity: 'low' }], escalation: { reason: 'Verify primary evidence.' } };
  } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const state = store.get(); const run = state.runs[0];
    assert.equal(decisions, 1); assert.deepEqual(visits, ['model-node-0', 'supervisor']);
    assert.equal(run.status, 'completed'); assert.equal(run.escalations, 1); assert.equal(run.decisions?.[0].selectedModelId, 'model-node-0');
    assert.equal(state.findings[0].title, 'Local evidence');
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('active routing uses returned confidence at its boundary and persists the trace before a model visit', { timeout: 15000 }, async () => {
  for (const [choice, confidence, selected] of [
    ['assigned', 0.95, 'model-node-0'], ['assigned', 0.949, 'supervisor'], ['supervisor', 0.99, 'supervisor'], ['review', 0.99, 'supervisor'],
  ] as const) {
    const { store, cleanup } = await fixture({ routing: { confidenceThreshold: 0.95 } });
    const response = answer(choice, confidence);
    const visits: string[] = [];
    const engine = new WorkflowEngine(store, { routingExecutor: async () => response, piExecutor: async context => {
      const decision = store.get().runs[0].decisions?.[0];
      assert.equal(decision?.status, 'completed'); assert.equal(decision?.selectedModelId, selected);
      assert.equal(decision?.choice, choice); assert.equal(decision?.confidence, confidence);
      assert.deepEqual(decision?.probabilities, response.probabilities); assert.equal(decision?.threshold, 0.95);
      assert.equal(decision?.configuredModelId, defaultRoutingSettings.modelId); assert.equal(decision?.modelId, response.modelId);
      assert.ok(decision?.questionVersion); assert.equal(decision?.inputTokens, 20);
      visits.push(context.node.data.modelId);
      if (selected === 'supervisor') {
        assert.equal(context.escalation?.originalModelId, 'model-node-0');
        assert.deepEqual(context.node.data.tools, ['read']);
      }
      return empty;
    } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      const run = store.get().runs[0];
      assert.deepEqual(visits, [selected]); assert.equal(run.status, 'completed'); assert.equal(run.steps, 1);
      assert.equal(run.decisionCount, 1); assert.equal(run.escalations, selected === 'supervisor' ? 1 : 0);
      const persisted = JSON.parse(await readFile(store.filePath, 'utf8'));
      assert.deepEqual(persisted.runs[0].decisions, run.decisions);
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('uncertain active decisions without a supervisor stop for human review and never invoke a worker', { timeout: 15000 }, async () => {
  for (const response of [answer('review'), answer('assigned', 0.5)]) {
    const { store, cleanup } = await fixture({ supervisor: false });
    let reviews = 0;
    const engine = new WorkflowEngine(store, { routingExecutor: async () => response, piExecutor: async () => { reviews++; return empty; } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      const run = store.get().runs[0];
      assert.equal(reviews, 0); assert.equal(run.status, 'failed'); assert.match(run.error ?? '', /human|supervisor|review/i);
      assert.equal(run.decisionCount, 1); assert.equal(run.escalations, 0);
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('an invalid or unavailable active classifier uses one configured supervisor visit and retains an error trace', { timeout: 15000 }, async () => {
  for (const malformed of [false, true]) {
    const { store, cleanup } = await fixture();
    const visits: string[] = [];
    const engine = new WorkflowEngine(store, { routingExecutor: async () => {
      if (malformed) return { choice: 'assigned', confidence: Number.NaN } as RoutingAnswer;
      throw new Error('Fixture classifier unavailable.');
    }, piExecutor: async context => { visits.push(context.node.data.modelId); return empty; } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      const run = store.get().runs[0];
      assert.deepEqual(visits, ['supervisor']); assert.equal(run.escalations, 1); assert.equal(run.decisionCount, 1); assert.equal(run.status, 'completed');
      assert.equal(run.decisions?.[0].status, 'error'); assert.equal(run.decisions?.[0].selectedModelId, 'supervisor');
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('parallel shadow decisions reserve allowances atomically and retain budget traces while reviews continue', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture({ branches: 3, workers: 3, routing: { mode: 'shadow', maxConcurrentRequests: 3, maxDecisionsPerCycle: 1, maxDecisionsPerRun: 1 } });
  let decisions = 0; let reviews = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer(); }, piExecutor: async () => { reviews++; return empty; } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(decisions, 1); assert.equal(reviews, 4); assert.equal(run.status, 'completed'); assert.equal(run.decisionCount, 1);
    assert.equal(run.decisions?.filter(decision => decision.status === 'budget').length, 2);
    assert.equal(run.decisions?.filter(decision => decision.status === 'completed').length, 1);
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('failed shadow attempts consume the decision allowance and cannot trigger hidden retries', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture({ branches: 2, workers: 2, routing: { mode: 'shadow', maxDecisionsPerCycle: 1, maxDecisionsPerRun: 1 } });
  let decisions = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; throw new Error('Fixture native timeout.'); }, piExecutor: async () => empty });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(decisions, 1); assert.equal(run.decisionCount, 1); assert.equal(run.status, 'completed');
    assert.equal(run.decisions?.filter(decision => decision.status === 'error').length, 1);
    assert.equal(run.decisions?.filter(decision => decision.status === 'budget').length, 1);
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('cycle decision allowances reset while the run ceiling remains shared across cycles', { timeout: 15000 }, async () => {
  for (const runCeiling of [1, 2]) {
    const { store, cleanup } = await fixture({ branches: 2, workers: 2, routing: { mode: 'shadow', maxDecisionsPerCycle: 1, maxDecisionsPerRun: runCeiling } });
    await store.update(state => { state.workflow.settings.mode = 'loop'; state.workflow.settings.maxCycles = 2; state.workflow.settings.intervalSeconds = 0; });
    let decisions = 0; let reviews = 0;
    const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer(); }, piExecutor: async () => { reviews++; return empty; } });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      const run = store.get().runs[0];
      assert.equal(decisions, runCeiling); assert.equal(run.decisionCount, runCeiling); assert.equal(reviews, 6);
      assert.equal(run.decisions?.filter(decision => decision.status === 'budget').length, 4 - runCeiling);
      assert.equal(run.status, 'completed'); assert.equal(run.cycle, 2);
    } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
  }
});

test('active decision exhaustion fails without calling the classifier or supervisor beyond the reserved allowance', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture({ branches: 3, workers: 3, routing: { maxConcurrentRequests: 3, maxDecisionsPerCycle: 1, maxDecisionsPerRun: 1 } });
  let decisions = 0; let supervisors = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer(); }, piExecutor: async context => { if (context.node.data.modelId === 'supervisor') supervisors++; return empty; } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(decisions, 1); assert.equal(supervisors, 0); assert.equal(run.decisionCount, 1); assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /decision|allowance|budget/i); assert.ok(run.decisions?.some(decision => decision.status === 'budget'));
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('parallel routed supervisor requests share the existing supervisor allowance exactly once', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture({ branches: 2, workers: 2, routing: { maxConcurrentRequests: 2 } });
  const release = deferred();
  let decisions = 0; let supervisors = 0;
  const engine = new WorkflowEngine(store, {
    routingExecutor: async () => { decisions++; await release.promise; return answer('supervisor'); },
    piExecutor: async context => { if (context.node.data.modelId === 'supervisor') { supervisors++; await cancelled(context); } return empty; },
  });
  try {
    await engine.start('pi'); await until(() => decisions === 2, 'Both native decisions should hold their independent request slots.');
    release.resolve(); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(run.decisionCount, 2); assert.equal(run.escalations, 1); assert.ok(supervisors <= 1);
    assert.equal(run.status, 'failed'); assert.match(run.error ?? '', /allowance of 1 visit per cycle is exhausted/);
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a direct supervisor route cannot recurse into another supervisor visit', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture();
  let reviews = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => answer('supervisor'), piExecutor: async () => { reviews++; return { ...empty, escalation: { reason: 'Ask for another supervisor.' } }; } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(reviews, 1); assert.equal(run.escalations, 1); assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /further|recurs|blocked|human/i);
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a routing outcome save failure prevents the selected worker from running', { timeout: 15000 }, async () => {
  let inject = false;
  const { store, cleanup } = await fixture({ beforeCommit: phase => {
    if (inject && phase === 'primary') { inject = false; throw new Error('Injected routing outcome save failure'); }
  } });
  let decisions = 0; let reviews = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; inject = true; return answer(); }, piExecutor: async () => { reviews++; return empty; } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(decisions, 1); assert.equal(reviews, 0); assert.equal(run.decisionCount, 1); assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /routing outcome save failure/);
    assert.equal(run.decisions?.[0].status, 'cancelled', 'A failed outcome save must not leave a terminal run with an apparently pending classifier.');
  } finally { inject = false; await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('a decision reservation must be durable before any native classifier request is made', { timeout: 15000 }, async () => {
  let observedStore: StateStore | undefined; let inject = true;
  const { store, cleanup } = await fixture({ beforeCommit: phase => {
    const run = observedStore?.get().runs[0];
    if (inject && phase === 'primary' && run?.cycle === 1 && !run.decisions?.length) {
      inject = false;
      throw new Error('Injected decision reservation save failure');
    }
  } });
  observedStore = store;
  let decisions = 0; let reviews = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer(); }, piExecutor: async () => { reviews++; return empty; } });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(decisions, 0); assert.equal(reviews, 0); assert.equal(run.decisionCount ?? 0, 0); assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /decision reservation save failure/);
  } finally { inject = false; await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('Stop drains a native decision and publishes no chosen worker or late report before a replacement starts', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture();
  const release = deferred();
  let decisions = 0; let draining = false; let reviews = 0;
  const engine = new WorkflowEngine(store, { demoStepMs: 0,
    routingExecutor: async context => { decisions++; await cancelled(context); draining = true; await release.promise; return answer('supervisor'); },
    piExecutor: async () => { reviews++; return empty; },
  });
  try {
    await engine.start('pi'); await until(() => decisions === 1, 'The native decision should be active before Stop.');
    const stopping = engine.stop(); await until(() => draining, 'Stop must abort the native decision.');
    assert.equal(engine.isRunning, true); assert.equal(store.get().runs[0].status, 'running');
    const restarting = engine.start('demo');
    assert.equal(reviews, 0);
    release.resolve(); await stopping; await restarting; await engine.waitForIdle();
    const state = store.get();
    assert.equal(decisions, 1); assert.equal(reviews, 0);
    assert.equal(state.runs[1].status, 'stopped'); assert.equal(state.runs[0].status, 'completed');
    assert.equal(state.runs[1].decisions?.[0].status, 'cancelled'); assert.equal(state.runs[1].escalations, 0);
  } finally { release.resolve(); await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});

test('the decision and assigned model release a shared endpoint permit between their visits', { timeout: 15000 }, async () => {
  const { store, cleanup } = await fixture();
  await store.update(state => { state.workflow.settings.routing!.baseUrl = state.models.find(model => model.id === 'model-node-0')!.baseUrl; });
  let decisions = 0; let reviews = 0;
  const engine = new WorkflowEngine(store, { routingExecutor: async () => { decisions++; return answer(); }, piExecutor: async () => { reviews++; return empty; } });
  try {
    await engine.start('pi'); await until(() => !engine.isRunning, 'A classifier sharing the worker endpoint must release its permit before the worker starts.');
    await engine.waitForIdle();
    assert.equal(decisions, 1); assert.equal(reviews, 1); assert.equal(store.get().runs[0].status, 'completed');
  } finally { await engine.stop(); await engine.waitForIdle(); await cleanup(); }
});
