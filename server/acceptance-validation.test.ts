import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initialState, makeAgent } from '../shared/defaults';
import type { AgentData, GateApproval, GateOutcome, NodeResult, UnitOutcome, Workflow, WorkflowNode } from '../shared/types';
import { validateWorkflow } from './validation';
import { StateStore } from './store';

const stamp = new Date().toISOString();
function node(id: string, type: WorkflowNode['type'] = 'agent'): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ...makeAgent('custom', 'qwen'), label: id,
    ...(type === 'check' ? { check: { requireOutput: true, requireFindingEvidence: true, requireJudgment: false, blockedSeverities: [] } } : {}),
    ...(type === 'gate' ? { gate: { maxCorrections: 3, approval: 'automatic', risk: 'contained' } } : {}),
  } };
}
function workflow(): Workflow {
  return { ...structuredClone(initialState.workflow), nodes: [node('worker'), node('check', 'check'), node('gate', 'gate'), node('after')],
    edges: [{ id: 'e1', source: 'worker', target: 'check' }, { id: 'e2', source: 'check', target: 'gate' }, { id: 'e3', source: 'gate', target: 'after' }],
    settings: { ...initialState.workflow.settings, entryNodeId: 'worker', mode: 'once', lessons: [] },
  };
}
function validGraph(value: Workflow): void { validateWorkflow(value, initialState.models); }

test('existing all-agent cycles stay valid and checks/gates require no model or tools', () => {
  const legacy = structuredClone(initialState.workflow);
  legacy.edges[legacy.edges.length - 1].data = undefined;
  assert.doesNotThrow(() => validGraph(legacy));
  const value = workflow();
  for (const control of value.nodes.filter(item => item.type !== 'agent')) control.data = {
    label: control.id, color: 'teal', status: 'idle', check: control.data.check, gate: control.data.gate,
  } as AgentData;
  assert.doesNotThrow(() => validGraph(value));
  value.edges.push({ id: 'feedback', source: 'after', target: 'worker', data: { loop: true } });
  assert.doesNotThrow(() => validGraph(value));
});

test('acceptance workflows reject cycles, indirect inputs, unsafe forks and shared correction owners', () => {
  const mutations: [(value: Workflow) => void, RegExp][] = [
    [value => { value.settings.entryNodeId = 'check'; }, /entry agent/],
    [value => { value.edges.push({ id: 'cycle', source: 'after', target: 'worker' }); }, /same-cycle cycles/],
    [value => { value.edges[0].source = 'after'; }, /Unreachable|same-cycle/],
    [value => { value.edges[1].source = 'worker'; }, /exactly one gate/],
    [value => { value.edges.push({ id: 'fork', source: 'worker', target: 'after' }); }, /stale results/],
    [value => { value.edges.push({ id: 'gate-input', source: 'worker', target: 'gate' }); }, /direct check predecessors/],
    [value => {
      value.nodes.push(node('other-gate', 'gate'));
      value.edges.push({ id: 'shared', source: 'check', target: 'other-gate' });
    }, /exactly one gate/],
    [value => {
      value.nodes.push(node('other-check', 'check'), node('other-gate', 'gate'));
      value.edges.push({ id: 'other-1', source: 'worker', target: 'other-check' }, { id: 'other-2', source: 'other-check', target: 'other-gate' });
    }, /stale results/],
    [value => { value.edges[0].data = { loop: true }; }, /Unreachable/],
  ];
  for (const [mutate, expected] of mutations) {
    const value = workflow(); mutate(value);
    assert.throws(() => validGraph(value), expected);
  }
});

test('check policies, correction budgets and high-impact approval are explicit and bounded', () => {
  for (const patch of [undefined, { requireOutput: true }, { requireOutput: true, requireFindingEvidence: true, requireJudgment: false, blockedSeverities: ['invented'] }, { requireOutput: false, requireFindingEvidence: false, requireJudgment: false, blockedSeverities: [] }]) {
    const value = workflow(); value.nodes[1].data.check = patch as typeof value.nodes[1]['data']['check'];
    assert.throws(() => validGraph(value));
  }
  for (const patch of [{ maxCorrections: -1 }, { maxCorrections: 4 }, { maxCorrections: 0.5 }, { approval: 'model' }, { risk: 'high-impact', approval: 'automatic' }]) {
    const value = workflow(); Object.assign(value.nodes[2].data.gate!, patch);
    assert.throws(() => validGraph(value));
  }
  const value = workflow(); value.nodes[2].data.gate = { maxCorrections: 0, risk: 'high-impact', approval: 'human' };
  assert.doesNotThrow(() => validGraph(value));
  value.nodes.push(node('next-check', 'check'), node('next-gate', 'gate'));
  value.nodes[value.nodes.length - 1].data.gate!.approval = 'human';
  value.edges.push({ id: 'next-1', source: 'after', target: 'next-check' }, { id: 'next-2', source: 'next-check', target: 'next-gate' });
  assert.throws(() => validGraph(value), /at most one human/);
});

test('curated lessons have bounded text and only reference current agents', () => {
  const value = workflow();
  value.settings.lessons = [{ id: 'lesson', text: 'Preserve keyword arguments.', enabled: true, nodeIds: [] }];
  assert.doesNotThrow(() => validGraph(value));
  value.settings.lessons[0].nodeIds = ['worker', 'after'];
  assert.doesNotThrow(() => validGraph(value));
  for (const nodeIds of [['missing'], ['check'], ['gate'], ['worker', 'worker']]) {
    value.settings.lessons[0].nodeIds = nodeIds;
    assert.throws(() => validGraph(value));
  }
  value.settings.lessons[0].nodeIds = [];
  value.settings.lessons[0].text = 'x'.repeat(2001);
  assert.throws(() => validGraph(value));
});

test('judge comparisons still accept agent candidates and reject deterministic candidates', () => {
  const value = workflow();
  const judge = node('judge'); judge.data = makeAgent('judge', 'qwen');
  value.nodes.find(item => item.id === 'check')!.data.check!.requireJudgment = true;
  assert.throws(() => validGraph(value), /all direct predecessors must be judge agents/);
  value.nodes.push(node('candidate-a'), node('candidate-b'), judge);
  value.edges = [
    ['worker', 'candidate-a'], ['worker', 'candidate-b'], ['candidate-a', 'judge'], ['candidate-b', 'judge'],
    ['judge', 'check'], ['check', 'gate'], ['gate', 'after'],
  ].map(([source, target], index) => ({ id: `comparison-${index}`, source, target }));
  assert.doesNotThrow(() => validGraph(value));
  const invalid = workflow(); invalid.nodes.push(judge);
  invalid.edges.push({ id: 'candidate-1', source: 'after', target: 'judge' }, { id: 'candidate-2', source: 'gate', target: 'judge' });
  assert.throws(() => validGraph(invalid), /candidate agents/);
});

function result(patch: Partial<NodeResult> = {}): NodeResult {
  return { nodeId: 'check', nodeName: 'Check', modelId: 'deterministic', cycle: 1, output: 'Check complete.', findings: [], completedAt: stamp, check: { passed: true, units: [{ nodeId: 'worker', passed: true, retryable: false, reasons: [] }] }, ...patch };
}
const unit: UnitOutcome = { id: 'outcome', nodeId: 'worker', gateNodeId: 'gate', cycle: 1, attempt: 1, verdict: 'accepted', reasons: [], modelId: 'qwen', createdAt: stamp };
const approval: GateApproval = { gateNodeId: 'gate', cycle: 1, status: 'pending', requestedAt: stamp };
const gate: GateOutcome = { verdict: 'accepted', checkNodeIds: ['check'], corrections: 0, risk: 'contained' };

test('acceptance metadata is validated before publication, survives restart, and pending approval closes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-acceptance-store-'));
  try {
    const store = await StateStore.open(path.join(directory, 'state.json'));
    await store.update(state => {
      state.workflow = workflow(); state.workflow.nodes[2].data.gate!.approval = 'human';
      state.runs = [{ id: 'run', status: 'running', mode: 'pi', startedAt: stamp, cycle: 1, steps: 3, results: [result(), result({ nodeId: 'gate', check: undefined, gate })], outcomes: [unit], approval }];
    });
    const saved = await readFile(store.filePath, 'utf8'); const memory = store.get();
    const changes: ((state: ReturnType<StateStore['get']>) => void)[] = [
      state => { state.runs[0].outcomes![0].attempt = 5; },
      state => { state.runs[0].outcomes![0].verdict = 'invented' as UnitOutcome['verdict']; },
      state => { state.runs[0].outcomes![0].reasons = ['Accepted despite failure']; },
      state => { state.runs[0].outcomes = Array.from({ length: 501 }, (_, index) => ({ ...unit, id: `outcome-${index}` })); },
      state => { state.runs[0].results![0].attempt = 0; },
      state => { state.runs[0].results![0].check!.passed = false; },
      state => { state.runs[0].results![0].check!.units[0].retryable = true; },
      state => { state.runs[0].results![0].modelId = 'qwen'; },
      state => { state.runs[0].results![1].gate!.corrections = 4; },
      state => { state.runs[0].results![1].gate!.risk = 'high-impact'; },
      state => { state.runs[0].approval!.status = 'approved'; },
      state => { state.runs[0].approval!.cycle = 2; },
      state => { state.runs[0].approval!.resolvedAt = stamp; },
    ];
    for (const mutate of changes) {
      await assert.rejects(store.update(mutate));
      assert.deepEqual(store.get(), memory);
      assert.equal(await readFile(store.filePath, 'utf8'), saved);
    }
    const reopened = await StateStore.open(store.filePath);
    const stopped = reopened.get().runs[0];
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.approval!.status, 'rejected');
    assert.ok(stopped.approval!.resolvedAt);
    assert.deepEqual(stopped.results, JSON.parse(JSON.stringify(memory.runs[0].results)));
    assert.deepEqual(stopped.outcomes, memory.runs[0].outcomes);
    assert.deepEqual(JSON.parse(await readFile(store.filePath, 'utf8')), reopened.get());
    await reopened.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt acceptance metadata recovers only from a validated backup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-acceptance-recovery-'));
  try {
    const store = await StateStore.open(path.join(directory, 'state.json'));
    await store.update(state => { state.workflow = workflow(); state.runs = [{ id: 'run', status: 'completed', mode: 'pi', startedAt: stamp, finishedAt: stamp, cycle: 1, steps: 3, results: [result()], outcomes: [unit] }]; });
    await store.update(state => { state.workflow.name = 'Most recent'; });
    const corrupted = store.get(); corrupted.runs[0].outcomes![0].attempt = 99;
    await writeFile(store.filePath, JSON.stringify(corrupted), 'utf8');
    const recovered = await StateStore.open(store.filePath);
    assert.notEqual(recovered.get().workflow.name, 'Most recent');
    assert.equal(recovered.get().runs[0].outcomes![0].attempt, 1);
    assert.ok(recovered.get().messages.some(message => /last-good backup/.test(message.text)));
    await recovered.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('approval snapshots retain final reports independently of history and reject malformed or cross-cycle evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-approval-evidence-'));
  try {
    const store = await StateStore.open(path.join(directory, 'state.json'));
    const worker = result({ nodeId: 'worker', modelId: 'qwen', output: 'The complete accepted work.', check: undefined });
    await store.update(state => {
      state.workflow = workflow(); state.workflow.nodes[2].data.gate!.approval = 'human';
      state.runs = [{ id: 'run', status: 'running', mode: 'pi', startedAt: stamp, cycle: 1, steps: 202, results: [], approval: { ...approval, results: [worker, result()] } }];
    });
    assert.equal(store.get().runs[0].approval!.results![0].output, 'The complete accepted work.');
    assert.deepEqual(store.get().runs[0].results, []);
    const memory = store.get(); const saved = await readFile(store.filePath, 'utf8');
    const invalid: NodeResult[][] = [
      [], [worker, worker], [{ ...worker, cycle: 2 }], [{ ...worker, output: 'x'.repeat(30_001) }],
      [{ ...worker, findings: [{ title: 'Issue', description: 'Invalid source line.', severity: 'high', file: 'source.ts', line: 0 }] }],
      [result({ nodeId: 'gate', check: undefined, gate })],
      Array.from({ length: 101 }, (_, index) => ({ ...worker, nodeId: `worker-${index}` })),
    ];
    for (const results of invalid) {
      await assert.rejects(store.update(state => { state.runs[0].approval!.results = results; }));
      assert.deepEqual(store.get(), memory);
      assert.equal(await readFile(store.filePath, 'utf8'), saved);
    }
    const restarted = await StateStore.open(store.filePath);
    assert.equal(restarted.get().runs[0].approval!.status, 'rejected');
    assert.equal(restarted.get().runs[0].approval!.results![0].output, 'The complete accepted work.');
    await restarted.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
