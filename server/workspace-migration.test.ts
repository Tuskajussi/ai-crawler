import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import { StateStore } from './store';
import { migrateLegacyWorkspace } from './workspace-migration';
import { InputError } from './validation';

async function fixture(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-migration-'));
  try { await operation(directory); }
  finally { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); }
}

test('first-owner migration copies durable Knowledge media, reliability and credential association once without overwriting or deleting originals', () => fixture(async directory => {
  const legacy = path.join(directory, 'legacy'), target = path.join(directory, 'owner');
  const oldCredentialDirectory = path.join(directory, 'old-credentials'), credentialDirectory = path.join(directory, 'new-credentials');
  const source = `source-${randomUUID()}`;
  await mkdir(path.join(legacy, 'knowledge', source), { recursive: true }); await mkdir(oldCredentialDirectory);
  const files = [ ['state.json', 'legacy state'], ['state.json.bak', 'legacy backup'], ['knowledge/index.json', 'legacy index'],
    ['knowledge/index.json.bak', 'legacy index backup'], [`knowledge/${source}/chunk-0.bin`, 'private media'], ['reliability.json', 'history'], ['reliability.json.bak', 'history backup'] ];
  for (const [name, data] of files) await writeFile(path.join(legacy, name), data);
  await writeFile(path.join(oldCredentialDirectory, 'credentials.json'), 'encrypted fixture envelope');
  const options = { statePath: path.join(legacy, 'state.json'), directory: target, oldCredentialDirectory, credentialDirectory };
  await migrateLegacyWorkspace(options);
  for (const [name, data] of files) { assert.equal(await readFile(path.join(target, name), 'utf8'), data); assert.equal(await readFile(path.join(legacy, name), 'utf8'), data); }
  assert.equal(await readFile(path.join(credentialDirectory, 'credentials.json'), 'utf8'), 'encrypted fixture envelope');
  await writeFile(path.join(target, 'state.json'), 'owner edit');
  await rm(path.join(target, 'knowledge', source), { recursive: true });
  await migrateLegacyWorkspace(options);
  assert.equal(await readFile(path.join(target, 'state.json'), 'utf8'), 'owner edit');
  await assert.rejects(readFile(path.join(target, 'knowledge', source, 'chunk-0.bin')), { code: 'ENOENT' }, 'Restart never resurrects a source the owner deleted.');
}));

test('legacy migration refuses a symlinked credential file without copying its target', async context => fixture(async directory => {
  const oldCredentialDirectory = path.join(directory, 'old'), credentialDirectory = path.join(directory, 'new');
  await mkdir(oldCredentialDirectory); const privateFile = path.join(directory, 'unrelated-private.txt'); await writeFile(privateFile, 'private unrelated data');
  try { await symlink(privateFile, path.join(oldCredentialDirectory, 'credentials.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Host does not permit file symlinks.'); return; } throw error; }
  await assert.rejects(migrateLegacyWorkspace({ statePath: path.join(directory, 'missing-state.json'), directory: path.join(directory, 'owner'), oldCredentialDirectory, credentialDirectory }), /unsupported file/);
  await assert.rejects(readFile(path.join(credentialDirectory, 'credentials.json')), { code: 'ENOENT' });
}));

test('stored parallel alias migrates and historical results survive deleted agent identities while malformed results fail', () => fixture(async directory => {
  const statePath = path.join(directory, 'state.json'), state = structuredClone(initialState);
  delete state.workflow.settings.maxParallelAgents; state.workflow.settings.maxParallel = 4;
  const result = { nodeId: 'deleted-agent', nodeName: 'Historical candidate', modelId: 'historical-model', cycle: 1, output: 'Historical answer.', findings: [], completedAt: new Date().toISOString(),
    judgment: { winnerNodeId: 'deleted-agent', reasoning: 'Historical result.', scores: [{ nodeId: 'deleted-agent', score: 80, reasoning: 'Historical score.' }] } };
  state.runs = [{ id: randomUUID(), status: 'completed', mode: 'demo', startedAt: result.completedAt, cycle: 1, steps: 1, results: [result] }];
  await writeFile(statePath, JSON.stringify(state));
  const store = await StateStore.open(statePath);
  assert.equal(store.get().workflow.settings.maxParallelAgents, 4); assert.equal(store.get().workflow.settings.maxParallel, undefined);
  assert.deepEqual(store.get().runs[0].results, [result]);
  for (const change of [(value: any) => { value.output = 'x'.repeat(30_001); }, (value: any) => { value.cycle = 0; },
    (value: any) => { value.findings = [{}]; }, (value: any) => { value.judgment.scores[0].score = 101; }, (value: any) => { value.judgment.winnerNodeId = 'missing-score'; }]) {
    const malformed = structuredClone(store.get()); change(malformed.runs[0].results![0]);
    await writeFile(statePath, JSON.stringify(malformed)); await writeFile(`${statePath}.bak`, JSON.stringify(malformed));
    await assert.rejects(StateStore.open(statePath), /could not be validated/);
  }
}));

test('rejected input never poisons shutdown flush while a durable write failure stays observable', () => fixture(async directory => {
  let fail = false;
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: () => {
    if (fail) throw Object.assign(new Error('Fixture durable write failed.'), { code: 'EIO' });
  } });
  const original = store.get();
  await assert.rejects(store.update(() => { throw new InputError('Finding not found.', 404); }), { status: 404 });
  await store.flush();
  assert.deepEqual(store.get(), original);
  fail = true;
  await assert.rejects(store.update(state => { state.workflow.name = 'Never committed'; }), /durable write failed/);
  await assert.rejects(store.flush(), /durable write failed/);
  assert.deepEqual(store.get(), original);
}));
