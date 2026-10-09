import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, makeAgent } from '../shared/defaults';
import type { NodeResult, Workflow } from '../shared/types';
import { delay, type ExecutionContext, WorkflowEngine } from './engine';
import { StateStore } from './store';
import { validateWorkflow } from './validation';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for concurrent agent progress.')), 3000);
    })]);
  } finally { clearTimeout(timer!); }
}

function comparisonWorkflow(): Workflow {
  const workflow = structuredClone(initialState.workflow);
  workflow.settings = { ...workflow.settings, mode: 'once', continuous: false, intervalSeconds: 0, entryNodeId: 'input' };
  delete workflow.settings.maxParallel;
  workflow.nodes = ['input', 'a', 'b', 'c', 'judge'].map((id, index) => ({
    id, type: 'agent', position: { x: index * 200, y: 0 },
    data: { ...makeAgent(id === 'judge' ? 'judge' : 'custom', id === 'b' ? 'qwen' : id === 'c' ? 'third-model' : 'claude'), label: id, prompt: id === 'judge' ? 'Compare the candidate answers.' : 'Solve the shared problem.' },
  }));
  workflow.edges = ['a', 'b', 'c'].flatMap(id => [
    { id: `input-${id}`, source: 'input', target: id },
    { id: `${id}-judge`, source: id, target: 'judge' },
  ]);
  workflow.edges.push({ id: 'return', source: 'judge', target: 'input', data: { loop: true } });
  return workflow;
}

async function fixture(workflow = comparisonWorkflow()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-parallel-'));
  const store = await StateStore.open(path.join(directory, 'state.json'));
  await store.update(state => {
    state.workflow = workflow;
    state.models.push({ ...state.models[0], id: 'third-model', name: 'Third candidate', modelId: 'candidate-model' });
  });
  return { store, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('three candidate models overlap and a judge receives distinct direct-predecessor outputs', async () => {
  const { store, cleanup } = await fixture();
  const branchesStarted = deferred();
  const releaseBranches = deferred();
  const candidates: ExecutionContext[] = [];
  let judgmentInputs: NodeResult[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'input') return { output: 'Shared task input' };
    if (context.node.id === 'judge') {
      judgmentInputs = context.upstreamResults;
      return { output: 'Candidate c was best.', judgment: {
        winnerNodeId: 'c', reasoning: 'c covers the edge cases.',
        scores: context.upstreamResults.map(result => ({ nodeId: result.nodeId, score: result.nodeId === 'c' ? 95 : 70, reasoning: `Compared ${result.output}` })),
      } };
    }
    candidates.push(context);
    assert.equal(context.upstreamResults.length, 1);
    assert.equal(context.upstreamResults[0].output, 'Shared task input');
    assert.equal(context.messages.some(message => message.text === 'Private candidate mutation'), false);
    context.messages.push({ id: 'mutation', from: context.node.id, to: 'all', type: 'message', text: 'Private candidate mutation', createdAt: '' });
    if (candidates.length === 3) branchesStarted.resolve();
    await releaseBranches.promise;
    return { output: `Answer from ${context.node.id} using ${context.node.data.modelId}` };
  } });
  try {
    await engine.start('pi');
    await within(branchesStarted.promise);
    assert.deepEqual(store.get().runs[0].activeNodeIds?.sort(), ['a', 'b', 'c']);
    assert.equal(store.get().workflow.nodes.filter(node => node.data.status === 'running').length, 3);
    releaseBranches.resolve();
    await within(engine.waitForIdle());
    const run = store.get().runs[0];
    assert.equal(run.status, 'completed');
    assert.equal(run.steps, 5);
    assert.deepEqual(judgmentInputs.map(result => result.nodeId).sort(), ['a', 'b', 'c']);
    assert.deepEqual(judgmentInputs.map(result => result.output).sort(), ['Answer from a using claude', 'Answer from b using qwen', 'Answer from c using third-model']);
    assert.equal(run.results?.find(result => result.nodeId === 'judge')?.judgment?.winnerNodeId, 'c');
    assert.deepEqual(run.activeNodeIds, []);
    assert.equal(run.activeNodeId, undefined);
    assert.equal(store.get().messages.some(message => message.id === 'mutation'), false);
  } finally {
    releaseBranches.resolve();
    await engine.stop();
    await engine.waitForIdle();
    await cleanup();
  }
});

test('a join waits for every uneven branch while ready descendants start immediately', async () => {
  const workflow = comparisonWorkflow();
  workflow.nodes.push({ id: 'b-tail', type: 'agent', position: { x: 0, y: 0 }, data: { ...makeAgent('custom'), label: 'b tail' } });
  workflow.edges = workflow.edges.filter(edge => edge.id !== 'b-judge');
  workflow.edges.push({ id: 'b-tail', source: 'b', target: 'b-tail' }, { id: 'tail-judge', source: 'b-tail', target: 'judge' });
  const { store, cleanup } = await fixture(workflow);
  const shortStarted = deferred();
  const tailStarted = deferred();
  const releaseShort = deferred();
  const releaseTail = deferred();
  let shortCount = 0;
  let judgeStarts = 0;
  let inputIds: string[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (['a', 'c'].includes(context.node.id)) {
      if (++shortCount === 2) shortStarted.resolve();
      await releaseShort.promise;
    }
    if (context.node.id === 'b-tail') {
      tailStarted.resolve();
      await releaseTail.promise;
    }
    if (context.node.id === 'judge') {
      judgeStarts++;
      inputIds = context.upstreamResults.map(result => result.nodeId).sort();
    }
    return { output: context.node.id };
  } });
  try {
    await engine.start('pi');
    await within(Promise.all([shortStarted.promise, tailStarted.promise]));
    assert.equal(judgeStarts, 0);
    releaseShort.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(judgeStarts, 0, 'judge must wait for the unfinished longer branch');
    releaseTail.resolve();
    await within(engine.waitForIdle());
    assert.equal(judgeStarts, 1);
    assert.deepEqual(inputIds, ['a', 'b-tail', 'c']);
    assert.equal(store.get().runs[0].steps, 6);
  } finally {
    releaseShort.resolve();
    releaseTail.resolve();
    await engine.stop();
    await engine.waitForIdle();
    await cleanup();
  }
});

test('parallel limit queues candidates with isolated inputs captured before sibling results', async () => {
  const workflow = comparisonWorkflow();
  workflow.settings.maxParallel = 1;
  const { store, cleanup } = await fixture(workflow);
  let active = 0;
  let peak = 0;
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    active++;
    peak = Math.max(peak, active);
    try {
      await delay(5, context.signal);
      if (['a', 'b', 'c'].includes(context.node.id)) {
        assert.equal(context.findings.length, 0, 'queued sibling must not consume a completed candidate finding');
        assert.equal(context.run.results?.length, 1);
        return { output: context.node.id, findings: [{ title: context.node.id, description: 'Candidate observation.', severity: 'low' }] };
      }
      return { output: context.node.id };
    } finally { active--; }
  } });
  try {
    await engine.start('pi');
    await within(engine.waitForIdle());
    assert.equal(peak, 1);
    assert.equal(store.get().runs[0].status, 'completed');
    assert.equal(store.get().runs[0].results?.length, 5);
  } finally { await cleanup(); }
});

test('stop aborts every sibling and discards late provider reports without waiting for them', async () => {
  const { store, cleanup } = await fixture();
  const started = deferred();
  const release = deferred();
  const signals: AbortSignal[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'input') return { output: 'Task' };
    signals.push(context.signal);
    if (signals.length === 3) started.resolve();
    await release.promise; // Deliberately simulate a provider that ignores AbortSignal.
    return { output: 'Late output', findings: [{ title: 'Late finding', description: 'Must not persist.', severity: 'high' }] };
  } });
  try {
    await engine.start('pi');
    await within(started.promise);
    await engine.stop();
    await within(engine.waitForIdle());
    assert.ok(signals.every(signal => signal.aborted));
    const stopped = store.get();
    assert.equal(stopped.runs[0].status, 'stopped');
    assert.equal(stopped.runs[0].steps, 1);
    assert.deepEqual(stopped.runs[0].activeNodeIds, []);
    assert.ok(stopped.workflow.nodes.every(node => node.data.status === 'idle'));
    release.resolve();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(store.get().runs[0].steps, 1);
    assert.equal(store.get().runs[0].results?.length, 1);
    assert.equal(store.get().findings.length, 0);
  } finally {
    release.resolve();
    await engine.stop();
    await engine.waitForIdle();
    await cleanup();
  }
});

test('a failing branch aborts siblings and a late report cannot change the failed run', async () => {
  const { store, cleanup } = await fixture();
  const allStarted = deferred();
  const releaseLate = deferred();
  let starts = 0;
  const signals: AbortSignal[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    if (context.node.id === 'input') return { output: 'Task' };
    signals.push(context.signal);
    if (++starts === 3) allStarted.resolve();
    if (context.node.id === 'a') {
      await allStarted.promise;
      throw new Error('Candidate model unavailable.');
    }
    await releaseLate.promise;
    return { output: 'Late output', findings: [{ title: 'Late finding', description: 'Must not persist.', severity: 'high' }] };
  } });
  try {
    await engine.start('pi');
    await within(engine.waitForIdle());
    assert.ok(signals.every(signal => signal.aborted));
    const failed = store.get();
    assert.equal(failed.runs[0].status, 'failed');
    assert.match(failed.runs[0].error!, /Candidate model unavailable/);
    assert.equal(failed.workflow.nodes.find(node => node.id === 'a')?.data.status, 'error');
    assert.ok(failed.workflow.nodes.filter(node => ['b', 'c'].includes(node.id)).every(node => node.data.status === 'idle'));
    releaseLate.resolve();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(store.get().runs[0].steps, 1);
    assert.equal(store.get().runs[0].results?.length, 1);
    assert.equal(store.get().findings.length, 0);
    assert.deepEqual(store.get().runs[0].activeNodeIds, []);
  } finally {
    releaseLate.resolve();
    await engine.stop();
    await engine.waitForIdle();
    await cleanup();
  }
});

test('explicit return edges run once per cycle and never feed stale candidates into the next judge', async () => {
  const workflow = comparisonWorkflow();
  workflow.settings.mode = 'loop';
  workflow.settings.maxCycles = 2;
  const { store, cleanup } = await fixture(workflow);
  const visits: string[] = [];
  const engine = new WorkflowEngine(store, { piExecutor: async context => {
    visits.push(`${context.cycle}:${context.node.id}`);
    if (context.node.id === 'input') assert.deepEqual(context.upstreamResults, []);
    if (context.node.id === 'judge') {
      assert.equal(context.upstreamResults.length, 3);
      assert.ok(context.upstreamResults.every(result => result.cycle === context.cycle));
    }
    return { output: `${context.cycle}:${context.node.id}` };
  } });
  try {
    await engine.start('pi');
    await within(engine.waitForIdle());
    assert.equal(new Set(visits).size, 10);
    assert.equal(visits.length, 10);
    assert.equal(store.get().runs[0].status, 'completed');
    assert.equal(store.get().runs[0].cycle, 2);
    assert.equal(store.get().runs[0].results?.length, 10);
  } finally { await cleanup(); }
});

test('validation requires marked cycle returns, ignores them for reachability, and bounds parallelism', () => {
  const workflow = structuredClone(initialState.workflow);
  const returnEdge = workflow.edges.find(edge => edge.data?.loop)!;
  delete returnEdge.data;
  assert.throws(() => validateWorkflow(workflow, initialState.models), /unmarked cycle.*Next cycle/i);
  returnEdge.data = { loop: true };
  assert.doesNotThrow(() => validateWorkflow(workflow, initialState.models));
  workflow.edges = workflow.edges.filter(edge => edge.target !== 'tester');
  workflow.edges.push({ id: 'loop-only', source: 'crawler', target: 'tester', data: { loop: true } });
  assert.throws(() => validateWorkflow(workflow, initialState.models), /Unreachable/);
  for (const limit of [0, 9, 1.5]) {
    const invalid = structuredClone(initialState.workflow);
    invalid.settings.maxParallel = limit;
    assert.throws(() => validateWorkflow(invalid, initialState.models), /Parallel agents/);
  }
});
