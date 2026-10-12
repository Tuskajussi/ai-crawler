import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from './store';

test('a failed durable commit leaves memory unchanged and later queued changes use committed state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-store-failure-'));
  let failure: 'backup' | 'primary' | undefined;
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: phase => {
    if (phase === failure) { failure = undefined; throw Object.assign(new Error('Injected disk write failure'), { code: 'EIO' }); }
  } });
  try {
    const original = store.get().workflow.name;
    for (const phase of ['backup', 'primary'] as const) {
      const disk = await readFile(store.filePath, 'utf8');
      const memory = store.get();
      failure = phase;
      await assert.rejects(store.update(state => { state.workflow.name = 'Must not publish'; }), /disk write failure/);
      assert.deepEqual(store.get(), memory);
      assert.equal(await readFile(store.filePath, 'utf8'), disk);
    }
    failure = 'primary';
    const rejected = store.update(state => { state.workflow.name = 'Rejected mutation'; });
    const accepted = store.update(state => { state.workflow.name += ' — committed'; });
    const results = await Promise.allSettled([rejected, accepted]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(store.get().workflow.name, `${original} — committed`);
    assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).workflow.name, store.get().workflow.name);
    await store.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('queued mutations wait for the previous durable commit and unpublished state stays invisible', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-store-order-'));
  let pause = false;
  let entered!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = await StateStore.open(path.join(directory, 'state.json'), { beforeCommit: async phase => {
    if (pause && phase === 'primary') { pause = false; entered(); await gate; }
  } });
  try {
    const original = store.get().workflow.name;
    const mutations: number[] = [];
    pause = true;
    const first = store.update(state => { mutations.push(1); state.workflow.name += ' one'; });
    const second = store.update(state => { mutations.push(2); state.workflow.name += ' two'; });
    await paused;
    assert.deepEqual(mutations, [1]);
    assert.equal(store.get().workflow.name, original);
    assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).workflow.name, original);
    release();
    const [firstState, secondState] = await Promise.all([first, second]);
    assert.equal(firstState.workflow.name, `${original} one`);
    assert.equal(secondState.workflow.name, `${original} one two`);
    assert.deepEqual(mutations, [1, 2]);
  } finally { release(); await store.flush(); await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt or missing primary recovers only from a validated last-good backup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-store-recovery-'));
  const statePath = path.join(directory, 'state.json');
  try {
    const store = await StateStore.open(statePath);
    await store.update(state => { state.workflow.name = 'Last good'; });
    await store.update(state => { state.workflow.name = 'Latest'; });
    assert.equal(JSON.parse(await readFile(`${statePath}.bak`, 'utf8')).workflow.name, 'Last good');
    await writeFile(statePath, '{truncated');
    let recovered = await StateStore.open(statePath);
    assert.equal(recovered.get().workflow.name, 'Last good');
    assert.ok(recovered.get().messages.some(message => /last-good backup/.test(message.text)));
    const invalid = recovered.get();
    invalid.messages[0].type = 'invalid' as typeof invalid.messages[0]['type'];
    await writeFile(statePath, JSON.stringify(invalid));
    recovered = await StateStore.open(statePath);
    assert.equal(recovered.get().workflow.name, 'Last good');
    await rm(statePath);
    recovered = await StateStore.open(statePath);
    assert.equal(recovered.get().workflow.name, 'Last good');
    await writeFile(statePath, '{bad primary');
    await writeFile(`${statePath}.bak`, JSON.stringify({ workflow: {}, models: [], findings: [], messages: [], runs: [] }));
    await assert.rejects(StateStore.open(statePath), /could not be validated/);
    assert.equal(await readFile(statePath, 'utf8'), '{bad primary');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed active worker lists cannot replace a valid saved run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-store-workers-'));
  try {
    const store = await StateStore.open(path.join(directory, 'state.json'));
    await store.update(state => {
      state.runs.push({ id: 'parallel-run', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 1, activeNodeId: 'tester', activeNodeIds: ['tester', 'designer'] });
    });
    const saved = await readFile(store.filePath, 'utf8');
    const memory = store.get();
    for (const activeNodeIds of ['tester', null, ['tester', 'tester'], [''], [42], Array.from({ length: 101 }, (_, index) => `worker-${index}`)]) {
      await assert.rejects(store.update(state => { state.runs[0].activeNodeIds = activeNodeIds as string[]; }), /invalid runs/);
      assert.deepEqual(store.get(), memory, 'An invalid activity update must not reach workspace readers');
      assert.equal(await readFile(store.filePath, 'utf8'), saved, 'An invalid activity update must not overwrite the restart record');
    }
    await store.update(state => { state.runs[0].activeNodeIds = []; delete state.runs[0].activeNodeId; });
    await store.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restart stops every interrupted worker and clears plural and legacy activity durably', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-store-worker-restart-'));
  try {
    const statePath = path.join(directory, 'state.json');
    const store = await StateStore.open(statePath);
    await store.update(state => {
      const startedAt = new Date().toISOString();
      state.runs.push(
        { id: 'parallel-run', status: 'running', mode: 'pi', startedAt, cycle: 2, steps: 5, activeNodeId: 'tester', activeNodeIds: ['tester', 'designer'] },
        { id: 'legacy-run', status: 'running', mode: 'demo', startedAt, cycle: 1, steps: 1, activeNodeId: 'crawler' },
      );
      for (const node of state.workflow.nodes) if (['crawler', 'tester', 'designer'].includes(node.id)) node.data.status = 'running';
    });
    await store.flush();
    const reopened = await StateStore.open(statePath);
    const recovered = reopened.get();
    assert.equal(recovered.runs.length, 2);
    for (const run of recovered.runs) {
      assert.equal(run.status, 'stopped');
      assert.match(run.error ?? '', /server restarted/);
      assert.ok(run.finishedAt && Number.isFinite(Date.parse(run.finishedAt)));
      assert.equal('activeNodeIds' in run, false);
      assert.equal('activeNodeId' in run, false);
    }
    assert.ok(recovered.workflow.nodes.every(node => node.data.status === 'idle'));
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), recovered, 'The interrupted-worker reset must survive another process restart');
    const secondRestart = await StateStore.open(statePath);
    assert.deepEqual(secondRestart.get(), recovered);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
