import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, makeAgent } from '../shared/defaults';
import type { AgentData, ProjectSettings, TestExecution, Workflow, WorkflowNode } from '../shared/types';
import { WorkflowEngine, delay, type AgentExecutor, type ExecutionContext } from './engine';
import { InputError } from './validation';
import { StateStore } from './store';
import { readServerConfig } from './config';
import { validateProjectAccess, validateRunAccess } from './policy';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function node(id: string, tools: AgentData['tools'] = ['read'], modelId = 'qwen'): WorkflowNode {
  return { id, type: 'agent', position: { x: 0, y: 0 }, data: { ...makeAgent('custom', modelId), label: id, tools } };
}

function graph(branches = false): Workflow {
  const workflow = structuredClone(initialState.workflow);
  workflow.settings = { ...workflow.settings, mode: 'once', maxCycles: 1, intervalSeconds: 0, executionMode: 'pi', entryNodeId: 'entry', maxParallelAgents: 3,
    projectPath: path.resolve('old-workflow-folder'), previewUrl: 'http://localhost:9999' };
  workflow.nodes = branches ? [node('entry'), node('left'), node('right', ['read'], 'claude')] : [node('entry')];
  workflow.edges = branches ? [{ id: 'left', source: 'entry', target: 'left' }, { id: 'right', source: 'entry', target: 'right' }] : [];
  return workflow;
}

function execution(commandId: string, passed = true): TestExecution {
  return { commandId, name: commandId === 'unit' ? 'Unit tests' : 'Type check', exitCode: passed ? 0 : 1,
    passed, timedOut: false, durationMs: 10, output: passed ? 'Passed' : 'Assertion failed: expected 2, received 1' };
}

async function fixture() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'crawlspace-engine-project-'));
  const projectPath = path.join(directory, 'repository');
  const dataDir = path.join(directory, 'account-data');
  const projectsRoot = path.join(dataDir, 'private-projects');
  await Promise.all([mkdir(projectPath), mkdir(projectsRoot, { recursive: true })]);
  const config = readServerConfig({ NODE_ENV: 'development' }, { dataDir });
  const project: ProjectSettings = { path: await realpath(projectPath), previewUrl: 'http://127.0.0.1:4173', allowEdits: true, allowTests: true,
    testCommands: [{ id: 'unit', name: 'Unit tests', command: 'npm test', timeoutSeconds: 60 }, { id: 'types', name: 'Type check', command: 'npm run typecheck', timeoutSeconds: 60 }] };
  const engines: WorkflowEngine[] = [];
  let sequence = 0;
  return { directory, project, projectPath, projectsRoot, config,
    open: async (workflow: Workflow, executor: AgentExecutor, selected: ProjectSettings = project) => {
      const approved = { ...structuredClone(selected), path: await validateProjectAccess(selected, projectsRoot, config) };
      await validateRunAccess(workflow, initialState.models, projectsRoot, config, approved);
      const store = await StateStore.open(path.join(dataDir, `workspace-${++sequence}.json`));
      await store.update(state => { state.workflow = workflow; state.project = approved; state.models.forEach(model => { model.maxConcurrentRequests = 3; }); });
      const engine = new WorkflowEngine(store, { piExecutor: executor });
      engines.push(engine);
      return { store, engine };
    },
    cleanup: async () => {
      for (const engine of engines) { await engine.stop(); await engine.waitForIdle(); }
      assert.equal(path.dirname(directory), temporaryRoot);
      assert.ok(path.basename(directory).startsWith('crawlspace-engine-project-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const conflict = (error: unknown) => error instanceof InputError && error.status === 409;

test('a run freezes project-wide settings and command requirements rather than mutable legacy workflow paths', async () => {
  const item = await fixture();
  const entered = deferred(), release = deferred();
  const contexts: Pick<ExecutionContext, 'workflow' | 'project'>[] = [];
  const workflow = graph();
  workflow.nodes = [node('entry', ['read', 'test']), node('after', ['read', 'test'])];
  workflow.edges = [{ id: 'next', source: 'entry', target: 'after' }];
  const { store, engine } = await item.open(workflow, async context => {
    contexts.push(structuredClone({ workflow: context.workflow, project: context.project }));
    if (context.node.id === 'entry') {
      context.project!.path = 'modified context';
      context.project!.testCommands.length = 0;
      entered.resolve(); await release.promise;
    }
    const tests = [execution('unit'), execution('types')];
    for (const test of tests) await context.onProjectActivity!({ test });
    return { output: 'Completed.', tests };
  });
  try {
    await engine.start('pi'); await entered.promise;
    const laterPath = path.join(item.directory, 'next-project');
    await mkdir(laterPath);
    await store.update(state => { state.project = { ...item.project, path: laterPath, previewUrl: '', testCommands: [] }; });
    release.resolve(); await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
    assert.equal(contexts.length, 2);
    for (const context of contexts) {
      assert.deepEqual(context.project, item.project);
      assert.equal(context.workflow.settings.projectPath, item.project.path);
      assert.equal(context.workflow.settings.previewUrl, item.project.previewUrl);
    }
    assert.ok(store.get().runs[0].results!.every(result => JSON.stringify(result.requiredTestIds) === JSON.stringify(['unit', 'types'])));
    assert.equal(store.get().project!.path, laterPath, 'A future selection must not be silently overwritten by the prior run.');
  } finally { release.resolve(); await item.cleanup(); }
});

test('actual failed test evidence retries only its rejected worker while preserving accepted sibling work', async () => {
  const item = await fixture();
  const workflow = graph(true);
  workflow.nodes[0].data.tools = ['read', 'edit'];
  workflow.nodes[1].data.tools = ['read', 'test'];
  workflow.nodes[2].data.tools = ['read', 'edit', 'test'];
  const controls: WorkflowNode[] = [
    { ...node('left-check'), type: 'check', data: { ...makeAgent('custom'), check: { requireOutput: true, requireFindingEvidence: false, requireJudgment: false, requireTests: true, blockedSeverities: [] } } },
    { ...node('right-check'), type: 'check', data: { ...makeAgent('custom'), check: { requireOutput: true, requireFindingEvidence: false, requireJudgment: false, requireTests: true, blockedSeverities: [] } } },
    { ...node('gate'), type: 'gate', data: { ...makeAgent('custom'), gate: { maxCorrections: 2, approval: 'automatic', risk: 'contained' } } }, node('after'),
  ];
  workflow.nodes.push(...controls);
  workflow.edges.push(...[['left', 'left-check'], ['right', 'right-check'], ['left-check', 'gate'], ['right-check', 'gate'], ['gate', 'after']]
    .map(([source, target], index) => ({ id: `control-${index}`, source, target })));
  const visits: string[] = [];
  let correction: ExecutionContext['correction'];
  const { engine, store } = await item.open(workflow, async context => {
    visits.push(context.node.id);
    if (context.node.id === 'entry') {
      await context.onProjectActivity!({ change: { path: 'src/boundary.ts', action: 'edited' } });
      return { output: 'Prepared the bounded source change.', changes: [{ path: 'src/boundary.ts', action: 'edited' }] };
    }
    if (!['left', 'right'].includes(context.node.id)) return { output: 'Combined result.' };
    const failed = context.node.id === 'right' && !context.correction;
    const tests = [execution('unit', !failed), execution('types')];
    if (context.node.id === 'right') {
      assert.equal(context.project!.allowEdits, true);
      assert.equal(context.project!.allowTests, true);
      correction = context.correction;
    }
    for (const test of tests) await context.onProjectActivity!({ test });
    return { output: failed ? 'Tests identified a boundary error.' : 'Completed with passing tests.', tests };
  });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const saved = store.get(), run = saved.runs[0];
    assert.equal(run.status, 'completed', run.error);
    assert.equal(visits.filter(id => id === 'left').length, 1);
    assert.equal(visits.filter(id => id === 'right').length, 2);
    assert.equal(visits.filter(id => id === 'after').length, 1);
    assert.equal(correction!.attempt, 2);
    assert.match(correction!.reasons.join(' '), /every configured test command/);
    assert.deepEqual(run.outcomes!.map(outcome => [outcome.nodeId, outcome.attempt, outcome.verdict]).sort(), [['left', 1, 'accepted'], ['right', 1, 'rejected'], ['right', 2, 'accepted']].sort());
    const right = run.results!.filter(result => result.nodeId === 'right');
    assert.equal(right[0].tests![0].passed, false);
    assert.ok(right[1].tests!.every(result => result.passed));
    assert.deepEqual(right[1].requiredTestIds, ['unit', 'types']);
    assert.deepEqual(run.results!.find(result => result.nodeId === 'entry')!.changes, [{ path: 'src/boundary.ts', action: 'edited' }]);
    assert.ok(saved.messages.some(message => /Project file edited: src\/boundary.ts/.test(message.text)));
    assert.ok(saved.messages.some(message => /Test executed: Unit tests \[unit\].*failed/.test(message.text)));
  } finally { await item.cleanup(); }
});

test('a passing subset of configured commands cannot approve a test gate', async () => {
  const item = await fixture();
  const workflow = graph();
  workflow.nodes[0].data.tools = ['read', 'test'];
  workflow.nodes.push(
    { ...node('check'), type: 'check', data: { ...makeAgent('custom'), check: { requireOutput: true, requireFindingEvidence: false, requireJudgment: false, requireTests: true, blockedSeverities: [] } } },
    { ...node('gate'), type: 'gate', data: { ...makeAgent('custom'), gate: { maxCorrections: 0, approval: 'automatic', risk: 'contained' } } }, node('after'),
  );
  workflow.edges = [['entry', 'check'], ['check', 'gate'], ['gate', 'after']].map(([source, target], index) => ({ id: `edge-${index}`, source, target }));
  const visits: string[] = [];
  const { engine, store } = await item.open(workflow, async context => {
    visits.push(context.node.id);
    const tests = [execution('unit')];
    for (const test of tests) await context.onProjectActivity!({ test });
    return { output: 'All checks passed, according to the model.', tests };
  });
  try {
    await engine.start('pi'); await engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(run.status, 'failed');
    assert.deepEqual(visits, ['entry']);
    assert.deepEqual(run.results!.find(result => result.nodeId === 'entry')!.requiredTestIds, ['unit', 'types']);
    assert.equal(run.results!.find(result => result.nodeId === 'gate')!.gate!.verdict, 'rejected');
  } finally { await item.cleanup(); }
});

test('a later worker edit invalidates earlier accepted tests and the gate requires a fresh retest', async () => {
  const item = await fixture();
  const workflow = graph(true);
  workflow.nodes[1].data.tools = ['read', 'edit', 'test'];
  workflow.nodes[2].data.tools = ['read', 'edit', 'test'];
  for (const id of ['left-check', 'right-check']) workflow.nodes.push({ ...node(id), type: 'check', data: { ...makeAgent('custom'),
    check: { requireOutput: true, requireFindingEvidence: false, requireJudgment: false, requireTests: true, blockedSeverities: [] } } });
  workflow.nodes.push({ ...node('gate'), type: 'gate', data: { ...makeAgent('custom'), gate: { maxCorrections: 2, approval: 'automatic', risk: 'contained' } } }, node('after'));
  workflow.edges.push(...[['left', 'left-check'], ['right', 'right-check'], ['left-check', 'gate'], ['right-check', 'gate'], ['gate', 'after']]
    .map(([source, target], index) => ({ id: `revision-edge-${index}`, source, target })));
  const visits: string[] = [];
  const edits: string[] = [];
  let store!: StateStore;
  const opened = await item.open(workflow, async context => {
    visits.push(context.node.id);
    if (!['left', 'right'].includes(context.node.id)) return { output: 'Bounded assignment or final report.' };
    if (context.node.id === 'right') {
      const deadline = Date.now() + 3000;
      while (!store.get().runs[0].results!.some(result => result.nodeId === 'left-check' && result.check?.passed)) {
        assert.ok(Date.now() < deadline, 'The first worker must have accepted test evidence before the later edit.');
        await delay(5, context.signal);
      }
    }
    if (!context.correction) {
      edits.push(context.node.id);
      await context.onProjectActivity!({ change: { path: `src/${context.node.id}.ts`, action: 'edited' } });
    } else assert.match(context.correction.reasons.join(' '), /test|edit|revision/i);
    const tests = [execution('unit'), execution('types')];
    for (const test of tests) await context.onProjectActivity!({ test });
    return { output: context.correction ? 'Retested after the other worker edit; existing code preserved.' : 'Edited and tested.', tests,
      ...(!context.correction ? { changes: [{ path: `src/${context.node.id}.ts`, action: 'edited' as const }] } : {}) };
  });
  store = opened.store;
  try {
    await opened.engine.start('pi'); await opened.engine.waitForIdle();
    const run = store.get().runs[0];
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(edits, ['left', 'right'], 'Correcting stale test evidence must preserve the completed code edits.');
    assert.equal(visits.filter(id => id === 'left').length, 2);
    assert.equal(visits.filter(id => id === 'right').length, 1);
    assert.equal(visits.filter(id => id === 'after').length, 1);
    const left = run.results!.filter(result => result.nodeId === 'left');
    assert.ok(left[0].tests!.every(test => test.projectRevision === 1));
    assert.ok(left[1].tests!.every(test => test.projectRevision === 2));
    assert.ok(run.results!.find(result => result.nodeId === 'right')!.tests!.every(test => test.projectRevision === 2));
    const check = run.results!.filter(result => result.nodeId === 'left-check');
    assert.equal(check[0].check!.passed, true, 'The original test report was valid before the other worker changed the project.');
    assert.ok(check.some(result => result.check!.passed === false && result.projectRevision === 2), 'The gate must refresh the formerly accepted check after the later edit.');
    assert.equal(check.at(-1)!.check!.passed, true);
    assert.equal(check.at(-1)!.projectRevision, 2);
  } finally { await item.cleanup(); }
});

test('editing and test workflows serialize every visit even across different model endpoints', async () => {
  for (const capability of ['edit', 'test'] as const) {
    const item = await fixture();
    const workflow = graph(true);
    workflow.nodes[1].data.tools.push(capability);
    let active = 0, maximum = 0;
    const visited = new Set<string>();
    const { engine, store } = await item.open(workflow, async context => {
      active++; maximum = Math.max(maximum, active); visited.add(context.node.id);
      try { await delay(25, context.signal); return { output: 'Completed.' }; }
      finally { active--; }
    });
    try {
      await engine.start('pi'); await engine.waitForIdle();
      assert.equal(store.get().runs[0].status, 'completed');
      assert.equal(maximum, 1, `${capability} must serialize read-only sibling visits too, to preserve a consistent project view.`);
      assert.deepEqual([...visited].sort(), ['entry', 'left', 'right']);
    } finally { await item.cleanup(); }
  }
});

test('independent read-only workflows can overlap on one project and block a writer until both finish', async () => {
  const item = await fixture();
  const firstEntered = deferred(), secondEntered = deferred();
  const reader = (entered: ReturnType<typeof deferred>): AgentExecutor => async context => { entered.resolve(); await delay(60_000, context.signal); return { output: 'Read-only report.' }; };
  const first = await item.open(graph(), reader(firstEntered));
  const second = await item.open(graph(), reader(secondEntered));
  const writerWorkflow = graph(); writerWorkflow.nodes[0].data.tools.push('edit');
  const writer = await item.open(writerWorkflow, async () => ({ output: 'Edited.' }));
  try {
    await first.engine.start('pi'); await firstEntered.promise;
    await second.engine.start('pi'); await secondEntered.promise;
    assert.equal(first.engine.isRunning, true); assert.equal(second.engine.isRunning, true);
    await assert.rejects(writer.engine.start('pi'), conflict);
    assert.equal(writer.store.get().runs.length, 0);
    await first.engine.stop(); await first.engine.waitForIdle();
    await assert.rejects(writer.engine.start('pi'), conflict);
    await second.engine.stop(); await second.engine.waitForIdle();
    await writer.engine.start('pi'); await writer.engine.waitForIdle();
    assert.equal(writer.store.get().runs[0].status, 'completed');
    await first.engine.start('pi'); await first.engine.stop(); await first.engine.waitForIdle();
  } finally { await item.cleanup(); }
});

test('a writer keeps the project lease through cancellation cleanup and releases it only after cleanup drains', async () => {
  const item = await fixture();
  const entered = deferred(), cleaning = deferred(), release = deferred();
  const workflow = graph(); workflow.nodes[0].data.tools.push('edit');
  const writer = await item.open(workflow, async context => {
    entered.resolve();
    try { await delay(60_000, context.signal); }
    finally { cleaning.resolve(); await release.promise; }
    return { output: 'Late edited report.' };
  });
  const reader = await item.open(graph(), async () => ({ output: 'Reviewed.' }));
  const anotherWriter = await item.open(workflow, async () => ({ output: 'Edited after cleanup.' }));
  try {
    await writer.engine.start('pi'); await entered.promise;
    await assert.rejects(reader.engine.start('pi'), conflict);
    await assert.rejects(anotherWriter.engine.start('pi'), conflict);
    let stopped = false;
    const stopping = writer.engine.stop().then(() => { stopped = true; });
    await cleaning.promise;
    assert.equal(stopped, false);
    assert.equal(writer.engine.isRunning, true);
    await assert.rejects(reader.engine.start('pi'), conflict);
    await assert.rejects(anotherWriter.engine.start('pi'), conflict);
    release.resolve(); await stopping; await writer.engine.waitForIdle();
    assert.equal(writer.store.get().runs[0].status, 'stopped');
    assert.equal(writer.store.get().runs[0].results!.length, 0, 'Cancellation cannot publish a late report.');
    await reader.engine.start('pi'); await reader.engine.waitForIdle();
    await anotherWriter.engine.start('pi'); await anotherWriter.engine.waitForIdle();
    assert.equal(anotherWriter.store.get().runs[0].status, 'completed');
  } finally { release.resolve(); await item.cleanup(); }
});

test('canonical selections through a symlink share the same process-wide project lease', async context => {
  const item = await fixture();
  const entered = deferred();
  try {
    const alias = path.join(item.directory, 'repository-alias');
    try { await symlink(item.projectPath, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Host does not allow creating symlinks.'); return; }
      throw error;
    }
    const workflow = graph(); workflow.nodes[0].data.tools.push('test');
    const writer = await item.open(workflow, async visit => { entered.resolve(); await delay(60_000, visit.signal); return { output: 'Tests complete.' }; });
    const aliasReader = await item.open(graph(), async () => ({ output: 'Read.' }), { ...item.project, path: alias });
    assert.equal(aliasReader.store.get().project!.path, writer.store.get().project!.path);
    await writer.engine.start('pi'); await entered.promise;
    await assert.rejects(aliasReader.engine.start('pi'), conflict);
    await writer.engine.stop(); await writer.engine.waitForIdle();
    await aliasReader.engine.start('pi'); await aliasReader.engine.waitForIdle();
    assert.equal(aliasReader.store.get().runs[0].status, 'completed');
  } finally { await item.cleanup(); }
});
