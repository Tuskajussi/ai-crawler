import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, makeAgent } from '../shared/defaults';
import type { NodeResult, ProjectSettings, TestExecution } from '../shared/types';
import { readServerConfig } from './config';
import { validateProjectAccess, validateRunAccess } from './policy';
import { StateStore } from './store';
import { validateCheckSettings, validateProjectSettings, validateWorkflow } from './validation';

function settings(projectPath: string, overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return { path: projectPath, previewUrl: '', allowEdits: false, allowTests: false, testCommands: [], ...overrides };
}

async function fixture() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'crawlspace-project-settings-'));
  const dataDir = path.join(directory, 'account-data');
  const projectsRoot = path.join(dataDir, 'users', 'account', 'projects');
  const project = path.join(directory, 'existing-repository');
  const privateProject = path.join(projectsRoot, 'repository');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(privateProject, { recursive: true })]);
  await writeFile(path.join(project, 'source.ts'), 'export const value = 1;');
  const config = readServerConfig({ NODE_ENV: 'development' }, { dataDir });
  return {
    directory, dataDir, projectsRoot, project, privateProject, config,
    cleanup: async () => {
      assert.equal(path.dirname(directory), temporaryRoot);
      assert.ok(path.basename(directory).startsWith('crawlspace-project-settings-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('explicit local project selection permits an existing external repository without moving it', async () => {
  const item = await fixture();
  try {
    assert.equal(await validateProjectAccess(settings(item.project), item.projectsRoot, item.config), await realpath(item.project));
    assert.equal(await validateProjectAccess(settings(item.directory), item.projectsRoot, item.config), await realpath(item.directory), 'An ancestor of account data remains usable as a project root; project tools exclude internal data.');
    await assert.rejects(validateProjectAccess(settings('relative/repository'), item.projectsRoot, item.config), /absolute project folder/);
    await assert.rejects(validateProjectAccess(settings(path.parse(item.project).root), item.projectsRoot, item.config), /inside the drive or filesystem root/);
    await assert.rejects(validateProjectAccess(settings(path.join(item.project, 'missing')), item.projectsRoot, item.config), /must exist/);
    await assert.rejects(validateProjectAccess(settings(path.join(item.project, 'source.ts')), item.projectsRoot, item.config), /must be a folder/);
  } finally { await item.cleanup(); }
});

test('local selection rejects account data and internal dependency or version-control folders', async () => {
  const item = await fixture();
  try {
    for (const selected of [item.dataDir, item.privateProject]) {
      await assert.rejects(validateProjectAccess(settings(selected), item.projectsRoot, item.config), /outside Crawlspace account/);
    }
    for (const component of ['.git', 'node_modules', '.crawlspace', 'NODE_MODULES']) {
      const internal = path.join(item.project, component, 'nested');
      await mkdir(internal, { recursive: true });
      await assert.rejects(validateProjectAccess(settings(internal), item.projectsRoot, item.config), /outside .git, node_modules, and .crawlspace/);
    }
  } finally { await item.cleanup(); }
});

test('local selection checks canonical symlink targets before allowing account-data access', async context => {
  const item = await fixture();
  try {
    const alias = path.join(item.directory, 'friendly-repo');
    try { await symlink(item.privateProject, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Host does not allow creating symlinks.'); return; }
      throw error;
    }
    await assert.rejects(validateProjectAccess(settings(alias), item.projectsRoot, item.config), /outside Crawlspace account/);
  } finally { await item.cleanup(); }
});

test('hosted project selection stays confined and cannot enable commands or code editing', async () => {
  const item = await fixture();
  const hosted = { ...item.config, hosted: true };
  try {
    assert.equal(await validateProjectAccess(settings(item.privateProject), item.projectsRoot, hosted), await realpath(item.privateProject));
    await assert.rejects(validateProjectAccess(settings(item.project), item.projectsRoot, hosted), /private projects folder/);
    await assert.rejects(validateProjectAccess(settings(item.privateProject, { allowEdits: true }), item.projectsRoot, hosted), /Hosted projects are read-only/);
    await assert.rejects(validateProjectAccess(settings(item.privateProject, { allowTests: true }), item.projectsRoot, hosted), /Hosted projects are read-only/);
  } finally { await item.cleanup(); }
});

test('run access applies project-wide paths and preview URLs over legacy workflow settings', async () => {
  const item = await fixture();
  try {
    const workflow = structuredClone(initialState.workflow);
    workflow.settings.projectPath = path.join(item.directory, 'missing-legacy-path');
    workflow.settings.previewUrl = 'http://invalid-preview.example';
    assert.equal(await validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, settings(item.project, { previewUrl: 'http://localhost:4173' })), await realpath(item.project));
    await assert.rejects(validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, settings(item.project)), /valid local preview URL/);
  } finally { await item.cleanup(); }
});

test('edit and test tools require explicit local project permissions and approved commands', async () => {
  const item = await fixture();
  try {
    const workflow = structuredClone(initialState.workflow);
    workflow.settings.projectPath = item.privateProject;
    workflow.nodes.forEach(node => { node.data.tools = ['read']; });
    workflow.nodes[0].data.tools.push('edit');
    await assert.rejects(validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config), /Enable code editing/);
    await assert.rejects(validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, settings(item.project)), /Enable code editing/);
    const editable = settings(item.project, { allowEdits: true });
    assert.equal(await validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, editable), await realpath(item.project));
    workflow.nodes[0].data.tools.push('test');
    await assert.rejects(validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, editable), /Enable test execution/);
    editable.allowTests = true;
    await assert.rejects(validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, editable), /Add an approved test command/);
    editable.testCommands.push({ id: 'test', name: 'Unit tests', command: 'npm test', timeoutSeconds: 120 });
    assert.equal(await validateRunAccess(workflow, initialState.models, item.projectsRoot, item.config, editable), await realpath(item.project));
    await assert.rejects(validateRunAccess(workflow, initialState.models, item.projectsRoot, { ...item.config, hosted: true }), /Hosted projects are read-only/);
  } finally { await item.cleanup(); }
});

test('project settings reject malformed permissions, arbitrary fields and unbounded command definitions', () => {
  const valid = settings(path.resolve('repository'), { allowTests: true, testCommands: [{ id: 'tests', name: 'Unit tests', command: 'npm test', timeoutSeconds: 600 }] });
  assert.doesNotThrow(() => validateProjectSettings(valid));
  const invalid: unknown[] = [
    { ...valid, path: '' }, { ...valid, path: 'repo\0file' }, { ...valid, path: 'x'.repeat(4001) },
    { ...valid, previewUrl: 'https://external.example' }, { ...valid, allowEdits: 'yes' }, { ...valid, secret: 'no' },
    { ...valid, testCommands: [...valid.testCommands, ...valid.testCommands] },
    ...[
      { id: 'bad id' }, { name: ' ' }, { name: 'x'.repeat(101) }, { command: '' }, { command: 'x'.repeat(2001) },
      { command: 'npm\0test' }, { timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 1.5 }, { shell: 'powershell' },
    ].map(override => ({ ...valid, testCommands: [{ ...valid.testCommands[0], ...override }] })),
    { ...valid, testCommands: Array.from({ length: 21 }, (_, index) => ({ ...valid.testCommands[0], id: `test-${index}` })) },
  ];
  for (const input of invalid) assert.throws(() => validateProjectSettings(input));
});

test('test-only acceptance is valid, and editing agents must also be able to read their project', () => {
  assert.doesNotThrow(() => validateCheckSettings({ requireOutput: false, requireFindingEvidence: false, requireJudgment: false, requireTests: true, blockedSeverities: [] }));
  assert.throws(() => validateCheckSettings({ requireOutput: false, requireFindingEvidence: false, requireJudgment: false, requireTests: false, blockedSeverities: [] }), /at least one acceptance/);
  assert.throws(() => validateCheckSettings({ requireOutput: true, requireFindingEvidence: false, requireJudgment: false, requireTests: 'true', blockedSeverities: [] }), /boolean/);
  const workflow = structuredClone(initialState.workflow);
  workflow.nodes[0].data.tools = ['edit'];
  assert.throws(() => validateWorkflow(workflow, initialState.models), /project reading enabled/);
  workflow.nodes[0].data.tools = ['read', 'edit', 'test'];
  assert.doesNotThrow(() => validateWorkflow(workflow, initialState.models));
  workflow.settings.entryNodeId = 'worker';
  workflow.nodes = [
    { id: 'worker', type: 'agent', position: { x: 0, y: 0 }, data: { ...makeAgent('custom'), tools: ['read'] } },
    { id: 'check', type: 'check', position: { x: 200, y: 0 }, data: { ...makeAgent('custom'), check: { requireOutput: false, requireFindingEvidence: false, requireJudgment: false, requireTests: true, blockedSeverities: [] } } },
    { id: 'gate', type: 'gate', position: { x: 400, y: 0 }, data: { ...makeAgent('custom'), gate: { maxCorrections: 1, approval: 'automatic', risk: 'contained' } } },
  ];
  workflow.edges = [{ id: 'report', source: 'worker', target: 'check' }, { id: 'criteria', source: 'check', target: 'gate' }];
  assert.throws(() => validateWorkflow(workflow, initialState.models), /all direct predecessors must have test tools enabled/);
  workflow.nodes[0].data.tools.push('test');
  assert.doesNotThrow(() => validateWorkflow(workflow, initialState.models));
});

test('project permissions and actual test/change evidence persist and invalid evidence cannot replace them', async () => {
  const item = await fixture();
  const execution: TestExecution = { commandId: 'unit', name: 'Unit tests', exitCode: 0, passed: true, timedOut: false, durationMs: 125, output: 'Tests passed', projectRevision: 0 };
  const result: NodeResult = { nodeId: 'crawler', nodeName: 'Crawler', modelId: initialState.models[0].id, cycle: 1, output: 'Implemented and tested', findings: [], completedAt: new Date().toISOString(), tests: [execution], requiredTestIds: ['unit'], changes: [{ path: 'src/example.ts', action: 'edited' }], projectRevision: 0 };
  try {
    const filePath = path.join(item.dataDir, 'state.json');
    const store = await StateStore.open(filePath);
    await store.update(state => {
      state.project = settings(item.project, { allowEdits: true, allowTests: true, testCommands: [{ id: 'unit', name: 'Unit tests', command: 'npm test', timeoutSeconds: 120 }] });
      state.runs.push({ id: 'run', status: 'completed', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 1, results: [result] });
    });
    for (const tests of [
      [{ ...execution, passed: false }], [{ ...execution, timedOut: true }], [{ ...execution, exitCode: null }],
      [{ ...execution, durationMs: -1 }], [{ ...execution, durationMs: Infinity }], [{ ...execution, output: 'x'.repeat(16001) }],
      [{ ...execution, createdAt: new Date().toISOString() }], Array.from({ length: 21 }, () => execution),
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(projectRevision => [{ ...execution, projectRevision }]),
    ]) {
      await assert.rejects(store.update(state => { state.runs[0].results![0].tests = tests as TestExecution[]; }));
      assert.deepEqual(store.get().runs[0].results![0].tests, [execution]);
    }
    await assert.rejects(store.update(state => { state.runs[0].results![0].changes = [{ path: 'x', action: 'deleted' as 'edited' }]; }));
    await assert.rejects(store.update(state => { state.runs[0].results![0].changes = Array.from({ length: 101 }, () => ({ path: 'x', action: 'edited' })); }));
    for (const requiredTestIds of [['bad command'], ['unit', 'unit'], Array.from({ length: 21 }, (_, index) => `test-${index}`), 'unit']) {
      await assert.rejects(store.update(state => { state.runs[0].results![0].requiredTestIds = requiredTestIds as string[]; }));
    }
    for (const projectRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      await assert.rejects(store.update(state => { state.runs[0].results![0].projectRevision = projectRevision as number; }));
    }
    await assert.rejects(store.update(state => { state.project!.allowEdits = 'yes' as unknown as boolean; }));
    await store.flush();
    const reopened = await StateStore.open(filePath);
    assert.deepEqual(reopened.get().project, store.get().project);
    assert.deepEqual(reopened.get().runs[0].results![0], result);
  } finally { await item.cleanup(); }
});
