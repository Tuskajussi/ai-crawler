import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultRoutingSettings, initialState, makeAgent } from '../shared/defaults';
import type { GateApproval, GateSettings, ReportFinding, Workflow, WorkflowNode } from '../shared/types';
import { delay, WorkflowEngine, type AgentExecutor, type ExecutionContext } from './engine';
import { StateStore } from './store';
import { InputError } from './validation';

const verifiedFinding: ReportFinding = {
  title: 'Boundary needs review', description: 'The branch lacks an empty-input case.',
  severity: 'low', file: 'src/boundary.ts', line: 12,
};
const unverifiedFinding: ReportFinding = {
  title: 'Evidence is missing', description: 'The first report has no inspected location.', severity: 'low',
};

function node(id: string, type: WorkflowNode['type'] = 'agent'): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { ...makeAgent('custom', 'qwen'), label: id,
    ...(type === 'check' ? { check: { requireOutput: true, requireFindingEvidence: true, requireJudgment: false, blockedSeverities: [] } } : {}),
    ...(type === 'gate' ? { gate: { maxCorrections: 2, approval: 'automatic', risk: 'contained' } } : {}),
  } };
}

function graph(branches = false, gate: Partial<GateSettings> = {}): Workflow {
  const workflow = structuredClone(initialState.workflow);
  workflow.settings = { ...workflow.settings, mode: 'once', maxCycles: 1, intervalSeconds: 0,
    executionMode: 'pi', entryNodeId: branches ? 'entry' : 'worker', maxParallelAgents: 3 };
  workflow.nodes = branches
    ? [node('entry'), node('accepted'), node('worker'), node('accepted-check', 'check'), node('check', 'check'), node('gate', 'gate'), node('after')]
    : [node('worker'), node('check', 'check'), node('gate', 'gate'), node('after')];
  workflow.nodes.find(item => item.id === 'gate')!.data.gate = { ...workflow.nodes.find(item => item.id === 'gate')!.data.gate!, ...gate };
  const connections = branches
    ? [['entry', 'accepted'], ['entry', 'worker'], ['accepted', 'accepted-check'], ['worker', 'check'], ['accepted-check', 'gate'], ['check', 'gate'], ['gate', 'after']]
    : [['worker', 'check'], ['check', 'gate'], ['gate', 'after']];
  workflow.edges = connections.map(([source, target], index) => ({ id: `edge-${index}`, source, target }));
  return workflow;
}

async function fixture(workflow: Workflow, executor: AgentExecutor, routingExecutor?: NonNullable<ConstructorParameters<typeof WorkflowEngine>[1]>['routingExecutor']) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-gates-'));
  const store = await StateStore.open(path.join(directory, 'state.json'));
  await store.update(state => {
    state.workflow = workflow;
    state.models.find(model => model.id === 'qwen')!.maxConcurrentRequests = 3;
  });
  const engine = new WorkflowEngine(store, { piExecutor: executor, routingExecutor });
  return { store, engine, cleanup: async () => {
    await engine.stop();
    await engine.waitForIdle();
    await rm(directory, { recursive: true, force: true });
  } };
}

async function until(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const conflict = (error: unknown) => error instanceof InputError && error.status === 409;

function decide(engine: WorkflowEngine, store: StateStore, runId: string, gateNodeId: string, decision: 'approve' | 'reject', token?: Pick<GateApproval, 'cycle' | 'requestedAt'>) {
  const approval = token ?? store.get().runs.find(run => run.id === runId)?.approval ?? store.get().runs[0]?.approval;
  return engine.approve(runId, gateNodeId, decision, approval?.cycle ?? 1, approval?.requestedAt ?? new Date().toISOString());
}

test('gate corrects only rejected units, preserving sibling snapshots and forwarding the final report', async () => {
  const visits: string[] = [];
  const contexts: ExecutionContext[] = [];
  let downstream: ExecutionContext | undefined;
  const { store, engine, cleanup } = await fixture(graph(true), async context => {
    visits.push(context.node.id);
    if (context.node.id === 'entry') return { output: 'Original bounded assignment.' };
    if (context.node.id === 'accepted') return { output: 'Accepted sibling answer.', findings: [{ ...verifiedFinding, title: 'Accepted sibling private evidence' }],
      messages: [{ to: 'all', text: 'Accepted sibling private message.' }] };
    if (context.node.id === 'worker') {
      contexts.push(context);
      return context.correction
        ? { output: 'Corrected current answer.', findings: [verifiedFinding] }
        : { output: 'Rejected first answer.', findings: [unverifiedFinding] };
    }
    if (context.node.id === 'after') downstream = context;
    return { output: 'Final combined review.' };
  });
  try {
    await engine.start('pi');
    await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(run.status, 'completed');
    assert.equal(visits.filter(id => id === 'accepted').length, 1, 'accepted work must not be regenerated');
    assert.equal(visits.filter(id => id === 'worker').length, 2);
    assert.equal(visits.filter(id => id === 'after').length, 1);
    assert.deepEqual(contexts[0].upstreamResults.map(result => result.nodeId), ['entry']);
    assert.deepEqual(contexts[1].upstreamResults, contexts[0].upstreamResults, 'correction retains the original assignment inputs');
    assert.deepEqual(contexts[1].correction && {
      attempt: contexts[1].correction.attempt, gateNodeId: contexts[1].correction.gateNodeId,
      previousOutput: contexts[1].correction.previousOutput,
    }, { attempt: 2, gateNodeId: 'gate', previousOutput: 'Rejected first answer.' });
    assert.ok(contexts[1].correction!.reasons.length > 0);
    assert.ok(contexts[1].findings.every(finding => finding.nodeId !== 'accepted'));
    assert.ok(contexts[1].messages.every(message => message.text !== 'Accepted sibling private message.'));
    assert.deepEqual(run.outcomes?.map(outcome => [outcome.nodeId, outcome.attempt, outcome.verdict]).sort(), [
      ['accepted', 1, 'accepted'], ['worker', 1, 'rejected'], ['worker', 2, 'accepted'],
    ].sort());
    assert.equal(run.results?.filter(result => result.nodeId === 'gate').at(-1)?.gate?.corrections, 1);
    assert.equal(run.results?.filter(result => result.nodeId === 'worker').at(-1)?.attempt, 2);
    assert.deepEqual(downstream!.upstreamResults.map(result => result.nodeId), ['gate']);
    assert.match(downstream!.upstreamResults[0].output, /Corrected current answer/);
    assert.match(downstream!.upstreamResults[0].output, /Accepted sibling answer/);
    assert.doesNotMatch(downstream!.upstreamResults[0].output, /Rejected first answer/);
  } finally { await cleanup(); }
});

test('a retryable failure is capped at three corrections and never releases downstream work', async () => {
  let workerVisits = 0;
  const visits: string[] = [];
  const { store, engine, cleanup } = await fixture(graph(false, { maxCorrections: 3 }), async context => {
    visits.push(context.node.id);
    if (context.node.id === 'worker') {
      workerVisits++;
      return { output: `Incomplete report ${workerVisits}.`, findings: [unverifiedFinding] };
    }
    return { output: 'Should not run.' };
  });
  try {
    await engine.start('pi');
    await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(run.status, 'failed');
    assert.equal(workerVisits, 4, 'the initial visit is followed by at most three corrections');
    assert.deepEqual(visits, ['worker', 'worker', 'worker', 'worker']);
    assert.deepEqual(run.outcomes?.map(outcome => [outcome.attempt, outcome.verdict]), [[1, 'rejected'], [2, 'rejected'], [3, 'rejected'], [4, 'rejected']]);
    assert.equal(run.results?.filter(result => result.nodeId === 'gate').at(-1)?.gate?.verdict, 'rejected');
    assert.equal(run.results?.filter(result => result.nodeId === 'gate').at(-1)?.gate?.corrections, 3);
    assert.equal(run.activeNodeIds?.length, 0);
  } finally { await cleanup(); }
});

test('blocked severity rejects immediately without trying to rewrite away a verified risk', async () => {
  const workflow = graph(false, { maxCorrections: 3, approval: 'human' });
  workflow.nodes.find(item => item.id === 'check')!.data.check!.blockedSeverities = ['critical'];
  const visits: string[] = [];
  const { store, engine, cleanup } = await fixture(workflow, async context => {
    visits.push(context.node.id);
    return { output: 'A verified critical risk needs attention.', findings: [{ ...verifiedFinding, severity: 'critical' }] };
  });
  try {
    const run = await engine.start('pi');
    await engine.waitForIdle();
    const saved = store.get().runs[0];
    assert.equal(saved.status, 'failed');
    assert.deepEqual(visits, ['worker']);
    assert.equal(saved.results?.find(result => result.nodeId === 'check')?.check?.units[0].retryable, false);
    assert.equal(saved.approval, undefined, 'human approval cannot bypass a failed deterministic check');
    await assert.rejects(decide(engine, store, run.id, 'gate', 'approve'), conflict);
  } finally { await cleanup(); }
});

test('required explicit output and judgment are evaluated before synthesized report text', async () => {
  const workflow = graph();
  workflow.nodes.unshift(node('entry'), node('candidate-a'), node('candidate-b'));
  workflow.settings.entryNodeId = 'entry';
  workflow.nodes.find(item => item.id === 'worker')!.data = makeAgent('judge', 'qwen');
  workflow.edges.unshift(
    { id: 'candidate-a-assignment', source: 'entry', target: 'candidate-a' },
    { id: 'candidate-b-assignment', source: 'entry', target: 'candidate-b' },
    { id: 'candidate-a-review', source: 'candidate-a', target: 'worker' },
    { id: 'candidate-b-review', source: 'candidate-b', target: 'worker' },
  );
  workflow.nodes.find(item => item.id === 'check')!.data.check!.requireJudgment = true;
  let initialReasons: string[] = [];
  const { store, engine, cleanup } = await fixture(workflow, async context => {
    if (context.node.id !== 'worker') return { output: 'Combined review.' };
    if (!context.correction) return { findings: [verifiedFinding] };
    initialReasons = context.correction.reasons;
    return { output: 'Explicit final report.', findings: [verifiedFinding], judgment: {
      winnerNodeId: 'candidate-a', reasoning: 'The first candidate gives stronger direct evidence.',
      scores: [{ nodeId: 'candidate-a', score: 90, reasoning: 'The cited boundary provides direct evidence.' },
        { nodeId: 'candidate-b', score: 70, reasoning: 'The alternative covers the issue with less detail.' }],
    } };
  });
  try {
    await engine.start('pi');
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
    assert.match(initialReasons.join(' '), /output/i);
    assert.match(initialReasons.join(' '), /judgment/i);
    assert.equal(store.get().runs[0].outcomes?.length, 2);
  } finally { await cleanup(); }
});

test('check and gate nodes never call the agent executor or JEV routing', async () => {
  const workflow = graph();
  workflow.settings.routing = { ...defaultRoutingSettings, mode: 'shadow' };
  const visits: string[] = [];
  const decisions: string[] = [];
  const { store, engine, cleanup } = await fixture(workflow, async context => {
    visits.push(context.node.id);
    return { output: 'Valid report.', findings: [verifiedFinding] };
  }, async context => {
    decisions.push(context.node.id);
    return { choice: 'assigned', confidence: 1, probabilities: { assigned: 1, supervisor: 0, review: 0 },
      modelId: 'local-decision', durationMs: 1, inputTokens: 10 };
  });
  try {
    await engine.start('pi');
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
    assert.deepEqual(visits, ['worker', 'after']);
    assert.deepEqual(decisions, ['worker', 'after']);
    assert.equal(store.get().runs[0].results?.find(result => result.nodeId === 'check')?.check?.passed, true);
    assert.equal(store.get().runs[0].results?.find(result => result.nodeId === 'gate')?.gate?.verdict, 'accepted');
  } finally { await cleanup(); }
});

test('a gate keeps combined findings within durable result limits without dropping worker reports', async () => {
  const { store, engine, cleanup } = await fixture(graph(true), async context => ({
    output: `Verified report from ${context.node.id}.`,
    findings: ['accepted', 'worker'].includes(context.node.id)
      ? Array.from({ length: 20 }, (_, index) => ({ ...verifiedFinding, title: `${context.node.id} finding ${index}` }))
      : [],
  }));
  try {
    await engine.start('pi');
    await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.results?.find(result => result.nodeId === 'gate')?.findings.length, 30);
    assert.equal(run.results?.filter(result => ['accepted', 'worker'].includes(result.nodeId)).reduce((count, result) => count + result.findings.length, 0), 40);
    const reloaded = await StateStore.open(store.filePath);
    assert.equal(reloaded.get().runs[0].status, 'completed', 'accepted combined reports must remain valid after restart');
  } finally { await cleanup(); }
});

test('pending approval preserves final accepted reports after correction history exceeds retention', async () => {
  const workflow = graph(false, { maxCorrections: 3, approval: 'human' });
  const workers = ['accepted-once', ...Array.from({ length: 31 }, (_, index) => `worker-${index}`)];
  workflow.settings.entryNodeId = 'entry';
  workflow.nodes = [node('entry'), ...workers.map(id => node(id)), ...workers.map(id => node(`${id}-check`, 'check')),
    { ...node('gate', 'gate'), data: { ...node('gate', 'gate').data, gate: { maxCorrections: 3, approval: 'human', risk: 'contained' } } }];
  workflow.edges = workers.flatMap(id => [
    { id: `assign-${id}`, source: 'entry', target: id },
    { id: `report-${id}`, source: id, target: `${id}-check` },
    { id: `criteria-${id}`, source: `${id}-check`, target: 'gate' },
  ]);
  const visits = new Map<string, number>();
  const { store, engine, cleanup } = await fixture(workflow, async context => {
    visits.set(context.node.id, (visits.get(context.node.id) ?? 0) + 1);
    if (context.node.id === 'entry') return { output: 'Original shared assignment.' };
    if (context.node.id === 'accepted-once') return { output: 'Accepted once; preserve this original answer.', findings: [verifiedFinding],
      messages: [{ to: 'all', text: 'Accepted sibling private message.' }] };
    if (context.correction) {
      assert.deepEqual(context.upstreamResults.map(result => result.nodeId), ['entry']);
      assert.ok(context.findings.every(finding => finding.nodeId !== 'accepted-once'));
      assert.ok(context.messages.every(message => message.text !== 'Accepted sibling private message.'));
    }
    const attempt = context.correction?.attempt ?? 1;
    return { output: `${context.node.id} final attempt ${attempt}.`, findings: [attempt === 4 ? verifiedFinding : unverifiedFinding] };
  });
  try {
    const run = await engine.start('pi');
    await until(() => {
      const current = store.get().runs[0];
      assert.notEqual(current.status, 'failed', current.error);
      return current.approval?.status === 'pending';
    }, 'the large correction batch must reach human approval', 30_000);
    const waiting = store.get().runs[0];
    assert.ok(waiting.steps > 200);
    assert.equal(waiting.results?.length, 200);
    assert.equal(waiting.results.some(result => result.nodeId === 'accepted-once'), false, 'the original accepted report has aged out of general history');
    assert.equal(visits.get('accepted-once'), 1);
    assert.equal(waiting.approval?.results?.length, 64, 'the approval bundle preserves each final worker and check report');
    const original = waiting.approval.results.find(result => result.nodeId === 'accepted-once');
    assert.equal(original?.output, 'Accepted once; preserve this original answer.');
    assert.equal(original.attempt, 1);
    for (const worker of workers.slice(1)) {
      assert.equal(visits.get(worker), 4);
      assert.equal(waiting.approval.results.find(result => result.nodeId === worker)?.attempt, 4);
      assert.equal(waiting.approval.results.find(result => result.nodeId === `${worker}-check`)?.check?.passed, true);
    }
    assert.equal(waiting.outcomes?.length, 125);
    assert.equal(waiting.outcomes.filter(outcome => outcome.nodeId === 'accepted-once').length, 1);
    await decide(engine, store, run.id, 'gate', 'approve', waiting.approval);
    await engine.waitForIdle();
    const completed = store.get().runs[0];
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.results?.length, 200);
    assert.ok(completed.outcomes!.length <= 500);
    assert.equal(completed.results.at(-1)?.gate?.verdict, 'accepted');
    assert.match(completed.results.at(-1)!.output, /Accepted once; preserve this original answer/);
    const reloaded = await StateStore.open(store.filePath);
    assert.equal(reloaded.get().runs[0].approval?.results?.find(result => result.nodeId === 'accepted-once')?.output,
      'Accepted once; preserve this original answer.');
  } finally { await cleanup(); }
});

test('human approval is a durable barrier and rejects stale, duplicate, and mismatched decisions', async () => {
  const visits: string[] = [];
  const { store, engine, cleanup } = await fixture(graph(false, { approval: 'human', risk: 'high-impact' }), async context => {
    visits.push(context.node.id);
    return { output: 'Valid inspected report.', findings: [verifiedFinding] };
  });
  try {
    const run = await engine.start('pi');
    await until(() => store.get().runs[0].approval?.status === 'pending', 'the accepted checks must reach human approval');
    assert.equal(store.get().runs[0].status, 'running');
    assert.deepEqual(visits, ['worker']);
    assert.equal(engine.isRunning, true);
    await assert.rejects(decide(engine, store, 'wrong-run', 'gate', 'approve'), conflict);
    await assert.rejects(decide(engine, store, run.id, 'wrong-gate', 'approve'), conflict);
    assert.equal(store.get().runs[0].approval?.status, 'pending');
    await decide(engine, store, run.id, 'gate', 'approve');
    await engine.waitForIdle();
    const saved = store.get().runs[0];
    assert.equal(saved.status, 'completed');
    assert.equal(saved.approval?.status, 'approved');
    assert.equal(saved.results?.filter(result => result.nodeId === 'gate').at(-1)?.gate?.approvedByHuman, true);
    assert.deepEqual(visits, ['worker', 'after']);
    await assert.rejects(decide(engine, store, run.id, 'gate', 'approve'), conflict);
  } finally { await cleanup(); }
});

test('human rejection records a rejected gate and prevents downstream execution', async () => {
  const visits: string[] = [];
  const { store, engine, cleanup } = await fixture(graph(false, { approval: 'human' }), async context => {
    visits.push(context.node.id);
    return { output: 'Valid report.' };
  });
  try {
    const run = await engine.start('pi');
    await until(() => store.get().runs[0].approval?.status === 'pending', 'the gate must wait for a human decision');
    await decide(engine, store, run.id, 'gate', 'reject');
    await engine.waitForIdle();
    const saved = store.get().runs[0];
    assert.equal(saved.status, 'failed');
    assert.equal(saved.approval?.status, 'rejected');
    assert.equal(saved.results?.filter(result => result.nodeId === 'gate').at(-1)?.gate?.verdict, 'rejected');
    assert.deepEqual(visits, ['worker']);
    await assert.rejects(decide(engine, store, run.id, 'gate', 'approve'), conflict);
  } finally { await cleanup(); }
});

test('an approval from an earlier cycle cannot authorize a later visit to the same gate', async () => {
  const workflow = graph(false, { approval: 'human' });
  workflow.settings.mode = 'loop';
  workflow.settings.maxCycles = 2;
  const downstreamCycles: number[] = [];
  const { store, engine, cleanup } = await fixture(workflow, async context => {
    if (context.node.id === 'after') downstreamCycles.push(context.cycle);
    return { output: `Valid cycle ${context.cycle} report.` };
  });
  try {
    const run = await engine.start('pi');
    await until(() => store.get().runs[0].approval?.status === 'pending', 'the first cycle must request approval');
    const first = structuredClone(store.get().runs[0].approval!);
    await decide(engine, store, run.id, 'gate', 'approve', first);
    await until(() => store.get().runs[0].approval?.status === 'pending' && store.get().runs[0].approval?.cycle === 2,
      'the second cycle must request its own approval');
    const second = structuredClone(store.get().runs[0].approval!);
    assert.deepEqual(downstreamCycles, [1]);
    await assert.rejects(decide(engine, store, run.id, 'gate', 'approve', first), conflict);
    await assert.rejects(decide(engine, store, run.id, 'gate', 'approve', { ...second, requestedAt: new Date(0).toISOString() }), conflict);
    assert.equal(store.get().runs[0].approval?.status, 'pending');
    assert.deepEqual(downstreamCycles, [1]);
    await decide(engine, store, run.id, 'gate', 'approve', second);
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
    assert.deepEqual(downstreamCycles, [1, 2]);
  } finally { await cleanup(); }
});

test('stopping a pending approval drains the gate and cannot release downstream later', async () => {
  const visits: string[] = [];
  const { store, engine, cleanup } = await fixture(graph(false, { approval: 'human' }), async context => {
    visits.push(context.node.id);
    return { output: 'Valid report.' };
  });
  try {
    const run = await engine.start('pi');
    await until(() => store.get().runs[0].approval?.status === 'pending', 'approval must be pending before stop');
    await engine.stop();
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'stopped');
    assert.equal(engine.isRunning, false);
    assert.deepEqual(visits, ['worker']);
    assert.equal(store.get().runs[0].activeNodeIds?.length, 0);
    await assert.rejects(decide(engine, store, run.id, 'gate', 'approve'), conflict);
  } finally { await cleanup(); }
});

test('a restart interrupts a persisted pending approval instead of silently approving it', async () => {
  const { store, engine, cleanup } = await fixture(graph(false, { approval: 'human' }), async () => ({ output: 'Valid report.' }));
  try {
    const run = await engine.start('pi');
    await until(() => store.get().runs[0].approval?.status === 'pending', 'approval must be durable before restart');
    const reloaded = await StateStore.open(store.filePath);
    assert.equal(reloaded.get().runs[0].status, 'stopped');
    assert.match(reloaded.get().runs[0].error!, /restarted/i);
    const restartedEngine = new WorkflowEngine(reloaded);
    await assert.rejects(decide(restartedEngine, reloaded, run.id, 'gate', 'approve'), conflict);
    assert.equal(reloaded.get().runs[0].results?.some(result => result.nodeId === 'after'), false);
  } finally { await cleanup(); }
});

test('stopping a correction drains its executor and saves no late accepted result', async () => {
  let correctionStarted = false;
  let visits = 0;
  const { store, engine, cleanup } = await fixture(graph(), async context => {
    visits++;
    if (context.correction) {
      correctionStarted = true;
      await delay(60_000, context.signal);
      return { output: 'Late repaired answer.', findings: [verifiedFinding] };
    }
    return { output: 'Incomplete report.', findings: [unverifiedFinding] };
  });
  try {
    await engine.start('pi');
    await until(() => correctionStarted, 'a rejected report must enter its correction visit');
    await engine.stop();
    await engine.waitForIdle();
    const saved = store.get().runs[0];
    assert.equal(saved.status, 'stopped');
    assert.equal(visits, 2);
    assert.equal(saved.outcomes?.some(outcome => outcome.verdict === 'accepted'), false);
    assert.equal(saved.results?.some(result => /Late repaired/.test(result.output)), false);
    assert.equal(saved.results?.some(result => result.nodeId === 'after'), false);
  } finally { await cleanup(); }
});

test('one failed correction cannot unlock the run while another correction is cleaning up', async () => {
  let siblingStarted = false;
  let siblingCleaning = false;
  let releaseCleanup!: () => void;
  const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let idle = false;
  const { store, engine, cleanup } = await fixture(graph(true), async context => {
    if (context.node.id === 'entry') return { output: 'Original assignment.' };
    if (!context.correction) return { output: 'Report without required evidence.', findings: [unverifiedFinding] };
    if (context.node.id === 'accepted') {
      siblingStarted = true;
      try { await delay(60_000, context.signal); }
      finally { siblingCleaning = true; await cleanupHeld; }
      return { output: 'Must not be accepted after sibling failure.', findings: [verifiedFinding] };
    }
    await until(() => siblingStarted, 'the other corrective visit must be active before failure');
    throw new Error('Correction executor failed.');
  });
  try {
    await engine.start('pi');
    const drained = engine.waitForIdle().then(() => { idle = true; });
    await until(() => siblingCleaning, 'the aborted sibling must begin asynchronous cleanup');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(idle, false, 'waitForIdle must include every correction executor cleanup');
    assert.equal(engine.isRunning, true, 'a replacement run must remain locked during correction cleanup');
    releaseCleanup();
    await drained;
    const saved = store.get().runs[0];
    assert.equal(saved.status, 'failed');
    assert.match(saved.error!, /Correction executor failed/);
    assert.equal(saved.results?.some(result => result.nodeId === 'after'), false);
    assert.equal(saved.outcomes?.some(outcome => outcome.verdict === 'accepted'), false);
  } finally { releaseCleanup(); await cleanup(); }
});
