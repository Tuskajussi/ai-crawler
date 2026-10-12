import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { initialState, makeAgent } from '../shared/defaults';
import type { ModelConfig, Workflow } from '../shared/types';
import { EndpointLimiter, endpointKey, planWorkflow } from './scheduler';

function workflow(edges: [string, string, boolean?][]): Workflow {
  const value = structuredClone(initialState.workflow);
  const ids = [...new Set(edges.flatMap(([source, target]) => [source, target]))];
  value.settings.entryNodeId = ids[0];
  value.nodes = [...ids].reverse().map(id => ({ id, type: 'agent', position: { x: 0, y: 0 }, data: makeAgent('reviewer') }));
  value.edges = edges.map(([source, target, loop], index) => ({ id: String(index), source, target, ...(loop !== undefined ? { data: { loop } } : {}) }));
  return value;
}

function model(id: string, baseUrl = 'http://localhost:11434/v1', maxConcurrentRequests?: number): ModelConfig {
  return { id, name: id, provider: 'custom', modelId: id, kind: 'local', baseUrl, apiKeyEnv: '', enabled: true, ...(maxConcurrentRequests !== undefined ? { maxConcurrentRequests } : {}) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('fork and join dependencies permit independent branches and retain both prerequisites', () => {
  const graph = workflow([['entry', 'left'], ['entry', 'right'], ['left', 'join'], ['right', 'join'], ['join', 'exit']]);
  assert.deepEqual(planWorkflow(graph), [
    { id: 'entry', nodeIds: ['entry'], dependencies: [] },
    { id: 'left', nodeIds: ['left'], dependencies: ['entry'] },
    { id: 'right', nodeIds: ['right'], dependencies: ['entry'] },
    { id: 'join', nodeIds: ['join'], dependencies: ['left', 'right'] },
    { id: 'exit', nodeIds: ['exit'], dependencies: ['join'] },
  ]);
});

test('explicit feedback and edges returning to entry never create within-cycle prerequisites', () => {
  const graph = workflow([['entry', 'left'], ['left', 'right'], ['right', 'left', true], ['right', 'entry']]);
  assert.deepEqual(planWorkflow(graph), [
    { id: 'entry', nodeIds: ['entry'], dependencies: [] },
    { id: 'left', nodeIds: ['left'], dependencies: ['entry'] },
    { id: 'right', nodeIds: ['right'], dependencies: ['left'] },
  ]);
});

test('unannotated cycles serialize deterministically and their children wait the whole component', () => {
  const graph = workflow([['entry', 'a'], ['entry', 'independent'], ['a', 'b'], ['b', 'a'], ['a', 'child'], ['child', 'exit'], ['independent', 'exit']]);
  assert.deepEqual(planWorkflow(graph), [
    { id: 'entry', nodeIds: ['entry'], dependencies: [] },
    { id: 'a', nodeIds: ['a', 'b'], dependencies: ['entry'] },
    { id: 'independent', nodeIds: ['independent'], dependencies: ['entry'] },
    { id: 'child', nodeIds: ['child'], dependencies: ['a'] },
    { id: 'exit', nodeIds: ['exit'], dependencies: ['independent', 'child'] },
  ]);
});

test('self loops and duplicate connections cannot deadlock or duplicate a visit', () => {
  const graph = workflow([['entry', 'node'], ['entry', 'node'], ['node', 'node'], ['node', 'exit']]);
  assert.deepEqual(planWorkflow(graph), [
    { id: 'entry', nodeIds: ['entry'], dependencies: [] },
    { id: 'node', nodeIds: ['node'], dependencies: ['entry'] },
    { id: 'exit', nodeIds: ['exit'], dependencies: ['node'] },
  ]);
});

test('endpoint identity combines loopback aliases and provider defaults without combining other origins', () => {
  const aliases = ['http://localhost:11434/v1', 'http://127.0.0.1:11434/api', 'http://[::1]:11434/v1/', 'http://LOCALHOST.:11434'];
  assert.deepEqual(aliases.map(url => endpointKey(model('m', url))), Array(aliases.length).fill('http://127.0.0.1:11434'));
  assert.equal(endpointKey({ ...model('m', ''), provider: 'ollama' }), 'http://127.0.0.1:11434');
  assert.equal(endpointKey({ ...model('m', ''), provider: 'openai' }), endpointKey(model('m', 'https://api.openai.com:443/v1')));
  assert.equal(endpointKey({ ...model('m', ''), provider: 'anthropic' }), 'https://api.anthropic.com');
  assert.notEqual(endpointKey(model('m', 'http://localhost:8080')), endpointKey(model('m', 'http://localhost:8081')));
  assert.notEqual(endpointKey(model('m', 'http://localhost:8080')), endpointKey(model('m', 'https://localhost:8080')));
});

test('the strictest enabled alias caps a shared endpoint while other machines can work', async () => {
  const first = model('first', 'http://localhost:11434/v1', 3);
  const alias = model('alias', 'http://[::1]:11434/v1', 1);
  const remote = model('remote', 'http://192.168.1.20:11434/v1', 1);
  const limiter = new EndpointLimiter([first, alias, remote]);
  const gate = deferred();
  const started: string[] = [];
  const signal = new AbortController().signal;
  const call = (target: ModelConfig) => limiter.run(target, signal, async () => { started.push(target.id); await gate.promise; });
  const jobs = [call(first), call(alias), call(remote)];
  await setImmediate();
  assert.deepEqual(started, ['first', 'remote']);
  gate.resolve();
  await Promise.all(jobs);
  assert.deepEqual(started, ['first', 'remote', 'alias']);
});

test('configured capacity greater than one runs only that many visits and ignores disabled aliases', async () => {
  const target = model('target', undefined, 2);
  const limiter = new EndpointLimiter([target, { ...model('disabled', 'http://127.0.0.1:11434/v1', 1), enabled: false }]);
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  const signal = new AbortController().signal;
  const jobs = gates.map((gate, index) => limiter.run(target, signal, async () => { started.push(index); await gate.promise; }));
  await setImmediate();
  assert.deepEqual(started, [0, 1]);
  gates[0].resolve();
  await setImmediate();
  assert.deepEqual(started, [0, 1, 2]);
  gates.forEach(gate => gate.resolve());
  await Promise.all(jobs);
});

test('a full endpoint does not occupy global capacity or block another machine', async () => {
  const first = model('first', 'http://localhost:11434/v1', 1);
  const sameMachine = model('same', 'http://127.0.0.1:11434/v1', 1);
  const otherMachine = model('other', 'http://192.168.1.20:11434/v1', 1);
  const limiter = new EndpointLimiter([first, sameMachine, otherMachine], 2);
  const gates = [deferred(), deferred(), deferred()];
  const started: string[] = [];
  const signal = new AbortController().signal;
  const jobs = [first, sameMachine, otherMachine].map((target, index) => limiter.run(target, signal, async () => {
    started.push(target.id);
    await gates[index].promise;
  }));
  await setImmediate();
  assert.deepEqual(started, ['first', 'other']);
  gates[2].resolve();
  await setImmediate();
  assert.deepEqual(started, ['first', 'other'], 'The queued alias still waits for its own endpoint.');
  gates[0].resolve();
  await setImmediate();
  assert.deepEqual(started, ['first', 'other', 'same']);
  gates[1].resolve();
  await Promise.all(jobs);
});

test('the global actual-visit cap limits work even across available independent machines', async () => {
  const targets = [1, 2, 3].map(id => model(String(id), `http://192.168.1.${id}:11434/v1`, 3));
  const limiter = new EndpointLimiter(targets, 2);
  const gates = targets.map(() => deferred());
  const started: string[] = [];
  const signal = new AbortController().signal;
  const jobs = targets.map((target, index) => limiter.run(target, signal, async () => {
    started.push(target.id);
    await gates[index].promise;
  }));
  await setImmediate();
  assert.deepEqual(started, ['1', '2']);
  gates[0].resolve();
  await setImmediate();
  assert.deepEqual(started, ['1', '2', '3']);
  gates.forEach(gate => gate.resolve());
  await Promise.all(jobs);
});

test('aborted queued visits never execute and do not obstruct later work', async () => {
  const target = model('target');
  const limiter = new EndpointLimiter([target]);
  const gate = deferred();
  const controller = new AbortController();
  const signal = new AbortController().signal;
  let cancelledStarted = false;
  let nextStarted = false;
  const active = limiter.run(target, signal, () => gate.promise);
  const cancelled = limiter.run(target, controller.signal, async () => { cancelledStarted = true; });
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  const next = limiter.run(target, signal, async () => { nextStarted = true; });
  controller.abort();
  await rejection;
  assert.equal(cancelledStarted, false);
  assert.equal(nextStarted, false);
  gate.resolve();
  await Promise.all([active, next]);
  assert.equal(nextStarted, true);
  await assert.rejects(limiter.run(target, controller.signal, async () => { cancelledStarted = true; }), { name: 'AbortError' });
  assert.equal(cancelledStarted, false);
});

test('active cancellation retains the slot until asynchronous cleanup settles', async () => {
  const target = model('target');
  const limiter = new EndpointLimiter([target]);
  const controller = new AbortController();
  const cleanup = deferred();
  const operationStarted = deferred();
  let nextStarted = false;
  const active = limiter.run(target, controller.signal, async () => {
    operationStarted.resolve();
    await cleanup.promise;
    throw new DOMException('stopped after cleanup', 'AbortError');
  });
  const rejection = assert.rejects(active, { name: 'AbortError' });
  await operationStarted.promise;
  const next = limiter.run(target, new AbortController().signal, async () => { nextStarted = true; });
  controller.abort();
  await setImmediate();
  assert.equal(nextStarted, false);
  cleanup.resolve();
  await Promise.all([rejection, next]);
  assert.equal(nextStarted, true);
});

test('cancellation between acquiring a free slot and starting cannot invoke a model', async () => {
  const target = model('target');
  const limiter = new EndpointLimiter([target]);
  const controller = new AbortController();
  let started = false;
  const pending = limiter.run(target, controller.signal, async () => { started = true; });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(started, false);
  assert.equal(await limiter.run(target, new AbortController().signal, async () => 'available'), 'available');
});

test('rejected operations release endpoint capacity for later supervisor work', async () => {
  const primary = model('primary');
  const supervisor = model('supervisor', 'http://127.0.0.1:11434/v1');
  const limiter = new EndpointLimiter([primary, supervisor]);
  const signal = new AbortController().signal;
  await assert.rejects(limiter.run(primary, signal, async () => { throw new Error('primary failed'); }), /primary failed/);
  assert.equal(await limiter.run(supervisor, signal, async () => 'supervisor completed'), 'supervisor completed');
});
