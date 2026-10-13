import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initialState, makeAgent } from '../shared/defaults';
import type { AppState, NodeResult, WorkflowNode } from '../shared/types';
import { retainedScreenshotReferences } from './workspaces';
import { pruneScreenshots, saveScreenshot } from './screenshots';
import { StateStore } from './store';
import { WorkflowEngine } from './engine';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGJ0AAAAASUVORK5CYII=', 'base64');
function pendingApproval(screenshot: string): AppState {
  const state = structuredClone(initialState);
  const stamp = new Date().toISOString();
  const report: NodeResult = { nodeId: 'designer', nodeName: 'UI inspector', modelId: 'claude', cycle: 1, output: 'Verified the captured preview.',
    findings: [{ title: 'UI issue', description: 'Observed in the captured preview.', severity: 'low', screenshot }], completedAt: stamp };
  state.findings = [];
  state.runs = [{ id: 'run', status: 'running', mode: 'pi', startedAt: stamp, cycle: 1, steps: 2, results: [report],
    approval: { gateNodeId: 'gate', cycle: 1, status: 'pending', requestedAt: stamp, results: [report] } }];
  return state;
}

test('pruning preserves pending approval evidence after current findings and ordinary result history change', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-approval-images-'));
  try {
    const evidenceName = `${randomUUID()}.png`, staleName = `${randomUUID()}.png`, executingName = `${randomUUID()}.png`;
    for (const filename of [evidenceName, staleName, executingName]) {
      await writeFile(path.join(directory, filename), png);
      await utimes(path.join(directory, filename), 1, 1);
    }
    const evidenceUrl = `/api/screenshots/${evidenceName}`, executingUrl = `/api/screenshots/${executingName}`;
    const state = pendingApproval(evidenceUrl);
    // Parallel work can refresh the global board, and bounded run history can
    // discard this worker's original entry while the approval snapshot remains.
    state.findings = [];
    state.runs[0].results = [];
    const references = retainedScreenshotReferences(state, [executingUrl]);
    assert.ok(references.includes(evidenceUrl));
    assert.ok(references.includes(executingUrl));
    const first = await pruneScreenshots(directory, references);
    assert.equal(first.removed, 1);
    assert.deepEqual(await readFile(path.join(directory, evidenceName)), png);
    assert.deepEqual(await readFile(path.join(directory, executingName)), png);
    await assert.rejects(readFile(path.join(directory, staleName)), { code: 'ENOENT' });

    state.runs[0].approval!.status = 'approved';
    state.runs[0].approval!.resolvedAt = new Date().toISOString();
    assert.ok(!retainedScreenshotReferences(state, [executingUrl]).includes(evidenceUrl), 'Resolved approvals return to the existing evidence retention policy');
    const afterApproval = await pruneScreenshots(directory, retainedScreenshotReferences(state, [executingUrl]));
    assert.equal(afterApproval.removed, 1);
    await assert.rejects(readFile(path.join(directory, evidenceName)), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(directory, executingName)), png);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a parallel capture refuses full storage rather than deleting the image awaiting human approval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-approval-image-capacity-'));
  try {
    const filename = `${randomUUID()}.png`;
    await writeFile(path.join(directory, filename), png);
    await utimes(path.join(directory, filename), 1, 1);
    const state = pendingApproval(`/api/screenshots/${filename}`);
    state.runs[0].results = [];
    let published = false;
    await assert.rejects(saveScreenshot(directory, png, () => retainedScreenshotReferences(state), () => { published = true; },
      { maxFiles: 1, maxBytes: png.length * 2 }), /full of retained evidence/);
    assert.equal(published, false);
    assert.deepEqual(await readFile(path.join(directory, filename)), png);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a completed checked worker retains screenshot evidence while a sibling delays the gate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-gate-image-lease-'));
  let releaseSibling!: () => void;
  const siblingHeld = new Promise<void>(resolve => { releaseSibling = resolve; });
  let engine: WorkflowEngine | undefined;
  try {
    const filename = `${randomUUID()}.png`, screenshotUrl = `/api/screenshots/${filename}`;
    await writeFile(path.join(directory, filename), png);
    await utimes(path.join(directory, filename), 1, 1);
    const store = await StateStore.open(path.join(directory, 'state.json'));
    const node = (id: string, type: WorkflowNode['type'] = 'agent'): WorkflowNode => ({ id, type, position: { x: 0, y: 0 },
      data: { ...makeAgent('custom', 'qwen'), label: id,
        ...(type === 'check' ? { check: { requireOutput: true, requireFindingEvidence: true, requireJudgment: false, blockedSeverities: [] } } : {}),
        ...(type === 'gate' ? { gate: { maxCorrections: 0, approval: 'automatic', risk: 'contained' } } : {}),
      } });
    await store.update(state => {
      state.workflow.nodes = [node('entry'), node('worker'), node('sibling'), node('check', 'check'), node('gate', 'gate')];
      state.workflow.edges = [['entry', 'worker'], ['entry', 'sibling'], ['worker', 'check'], ['sibling', 'check'], ['check', 'gate']]
        .map(([source, target], index) => ({ id: `image-edge-${index}`, source, target }));
      state.workflow.settings = { ...state.workflow.settings, mode: 'once', maxCycles: 1, entryNodeId: 'entry', executionMode: 'pi', maxParallelAgents: 3 };
      state.models.find(model => model.id === 'qwen')!.maxConcurrentRequests = 3;
    });
    let siblingStarted = false;
    engine = new WorkflowEngine(store, { piExecutor: async context => {
      if (context.node.id === 'sibling') { siblingStarted = true; await siblingHeld; }
      if (context.node.id === 'worker') {
        context.onScreenshot?.(screenshotUrl);
        return { output: 'Verified the preview image.', findings: [{ title: 'Captured UI issue', description: 'A verified visual observation.', severity: 'low', screenshot: screenshotUrl }] };
      }
      return { output: 'Completed the assigned inspection.' };
    } });
    await engine.start('pi');
    const deadline = Date.now() + 10_000;
    while (!siblingStarted || !store.get().runs[0].results?.some(result => result.nodeId === 'worker')) {
      assert.ok(Date.now() < deadline, 'The checked worker must complete while the sibling remains active');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.get().runs[0].approval, undefined, 'The gate has not reached an approval request yet');
    assert.ok(engine.pendingScreenshots.includes(screenshotUrl), 'Checked report evidence needs a lease after the worker capture finishes');
    await store.update(state => { state.findings = []; });
    const pruned = await pruneScreenshots(directory, retainedScreenshotReferences(store.get(), engine.pendingScreenshots));
    assert.equal(pruned.removed, 0);
    assert.deepEqual(await readFile(path.join(directory, filename)), png);

    releaseSibling();
    await engine.waitForIdle();
    assert.equal(store.get().runs[0].status, 'completed');
    assert.equal(store.get().runs[0].results?.find(result => result.nodeId === 'gate')?.gate?.verdict, 'accepted');
    assert.ok(!engine.pendingScreenshots.includes(screenshotUrl), 'The gate decision releases this report evidence lease');
  } finally {
    releaseSibling();
    await engine?.stop();
    await engine?.waitForIdle();
    await rm(directory, { recursive: true, force: true });
  }
});
