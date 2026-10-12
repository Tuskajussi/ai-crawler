import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import type { Workflow } from '../shared/types';
import { StateStore } from './store';
import { delay, WorkflowEngine } from './engine';
import { localPreviewUrl, traversalOrder, validateModels, validateWorkflow } from './validation';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-test-'));
  const store = await StateStore.open(path.join(directory, 'state.json'));
  return { store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('graph traversal respects branches, joins, and cycles rather than node array order', () => {
  const workflow = structuredClone(initialState.workflow);
  workflow.edges = [
    { id: 'a', source: 'crawler', target: 'reviewer' },
    { id: 'b', source: 'crawler', target: 'tester' },
    { id: 'c', source: 'reviewer', target: 'designer' },
    { id: 'd', source: 'tester', target: 'designer' },
    { id: 'e', source: 'designer', target: 'coordinator' },
    { id: 'f', source: 'coordinator', target: 'crawler' },
  ];
  validateWorkflow(workflow, initialState.models);
  assert.deepEqual(traversalOrder(workflow), ['crawler', 'reviewer', 'tester', 'designer', 'coordinator']);
});

test('validation rejects broken model references, dangling edges, and unreachable agents', () => {
  const check = (modify: (workflow: Workflow) => void, expression: RegExp) => {
    const workflow = structuredClone(initialState.workflow);
    modify(workflow);
    assert.throws(() => validateWorkflow(workflow, initialState.models), expression);
  };
  check(workflow => { workflow.nodes[0].data.modelId = 'missing'; }, /enabled model/);
  check(workflow => { workflow.edges[0].target = 'missing'; }, /missing agent/);
  check(workflow => { workflow.edges = []; }, /Unreachable/);
  check(workflow => { workflow.settings.maxCycles = 0; }, /Maximum cycles/);
  const models = structuredClone(initialState.models);
  models[0].apiKeyEnv = 'sk-some-secret';
  assert.throws(() => validateModels(models), /environment variable name/);
});

test('preview URL allows explicit loopback hosts and rejects remote/credential URLs', () => {
  assert.equal(localPreviewUrl('http://localhost:5173/page').hostname, 'localhost');
  assert.equal(localPreviewUrl('http://[::1]:3000').hostname, '[::1]');
  for (const url of ['https://example.com', 'file:///tmp/index.html', 'http://localhost.example.com', 'http://user:pass@localhost']) {
    assert.throws(() => localPreviewUrl(url));
  }
});

test('Code Mode accepts legacy workflows and explicit choices but rejects invalid settings', () => {
  const workflow = structuredClone(initialState.workflow);
  delete workflow.settings.codeMode;
  validateWorkflow(workflow, initialState.models);
  for (const codeMode of [true, false]) {
    workflow.settings.codeMode = codeMode;
    validateWorkflow(workflow, initialState.models);
  }
  for (const codeMode of ['false', 0, null]) {
    const invalid = { ...workflow, settings: { ...workflow.settings, codeMode } };
    assert.throws(() => validateWorkflow(invalid, initialState.models), /Code Mode must be a boolean/);
  }
});

test('once mode executes each reachable agent once even with a return edge', async () => {
  const { store, cleanup } = await fixture();
  try {
    await store.update(state => { state.workflow.settings.mode = 'once'; });
    const engine = new WorkflowEngine(store, { demoStepMs: 0 });
    await engine.start('demo');
    await engine.waitForIdle();
    const state = store.get();
    assert.equal(state.runs[0].status, 'completed');
    assert.equal(state.runs[0].cycle, 1);
    assert.equal(state.runs[0].steps, state.workflow.nodes.length);
    assert.ok(state.findings.every(finding => finding.demo === true));
    assert.equal(state.findings.length, 3);
    assert.ok(state.messages.some(message => message.type === 'assignment' && message.to === 'tester'));
  } finally { await cleanup(); }
});

test('loop mode obeys maxCycles and deduplicates example findings', async () => {
  const { store, cleanup } = await fixture();
  try {
    await store.update(state => { state.workflow.settings.maxCycles = 3; state.workflow.settings.intervalSeconds = 0; });
    const engine = new WorkflowEngine(store, { demoStepMs: 0 });
    await engine.start('demo');
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].steps, 15);
    assert.equal(store.get().runs[0].cycle, 3);
    assert.equal(store.get().findings.length, 3);
  } finally { await cleanup(); }
});

test('continuous crawling passes the configured cycle cap and stop prevents further visits', async () => {
  const { store, cleanup } = await fixture();
  let visits = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    visits++;
    await delay(10, context.signal);
    return { findings: [], messages: [], assignments: [] };
  } });
  try {
    await store.update(state => {
      state.workflow.settings.continuous = true;
      state.workflow.settings.maxCycles = 1;
      state.workflow.settings.intervalSeconds = 0;
    });
    await engine.start('pi');
    const deadline = Date.now() + 10_000;
    while (store.get().runs[0].cycle < 2 || store.get().runs[0].steps < 6) {
      assert.ok(Date.now() < deadline, 'continuous run must enter a second cycle');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    await engine.stop();
    await engine.waitForIdle();
    const stoppedVisits = visits;
    const stoppedSteps = store.get().runs[0].steps;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(visits, stoppedVisits);
    assert.equal(store.get().runs[0].steps, stoppedSteps);
    assert.equal(store.get().runs[0].status, 'stopped');
    assert.ok(store.get().runs[0].cycle >= 2);
    assert.ok(store.get().messages.some(message => /until you stop/.test(message.text)));
  } finally {
    await engine.stop();
    await engine.waitForIdle();
    await cleanup();
  }
});

test('stop cancels a long step immediately and accepts no late reports', async () => {
  const { store, cleanup } = await fixture();
  try {
    const engine = new WorkflowEngine(store, { demoStepMs: 60_000 });
    await engine.start('demo');
    await new Promise(resolve => setTimeout(resolve, 25));
    const started = Date.now();
    await engine.stop();
    await engine.waitForIdle();
    assert.ok(Date.now() - started < 1500);
    const state = store.get();
    assert.equal(state.runs[0].status, 'stopped');
    assert.equal(state.runs[0].steps, 0);
    assert.equal(state.findings.length, 0);
    assert.ok(state.workflow.nodes.every(node => node.data.status === 'idle'));
  } finally { await cleanup(); }
});

test('an unavailable executor fails a Pi run honestly without generating findings', async () => {
  const { store, cleanup } = await fixture();
  try {
    const engine = new WorkflowEngine(store);
    await engine.start('pi');
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'failed');
    assert.match(store.get().runs[0].error!, /Pi execution is unavailable/);
    assert.equal(store.get().findings.length, 0);
  } finally { await cleanup(); }
});

test('serialized persistence retains concurrent updates and stops interrupted runs on reload', async () => {
  const { store, cleanup } = await fixture();
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update(state => {
      state.messages.push({ id: `test-${index}`, from: 'you', to: 'all', type: 'message', text: String(index), createdAt: new Date().toISOString() });
    })));
    const disk = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(disk.messages.length, initialState.messages.length + 20);
    await store.update(state => { state.runs.push({ id: 'interrupted', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 1 }); });
    const reloaded = await StateStore.open(store.filePath);
    assert.equal(reloaded.get().runs[0].status, 'stopped');
    assert.match(reloaded.get().runs[0].error!, /server restarted/);
  } finally { await cleanup(); }
});
