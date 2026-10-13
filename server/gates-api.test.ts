import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeAgent } from '../shared/defaults';
import type { AppState, Workflow } from '../shared/types';
import { createApp } from './index';

const SECRET = 'gate-integration-registration-secret-at-least-32-characters';
const PASSWORD = 'gate integration test password sufficiently long';

async function withServer(run: (context: { instance: Awaited<ReturnType<typeof createApp>>; base: string }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-gates-api-'));
  try {
    const instance = await createApp({ dataDir: path.join(directory, 'data'), registrationSecret: SECRET, demoStepMs: 0 });
    const server = instance.app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      await run({ instance, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` });
    } finally {
      try { await instance.shutdown(); }
      finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('crawlspace-gates-api-'));
    await rm(directory, { recursive: true, force: true });
  }
}

function browser(base: string) {
  let cookie = '';
  let csrfToken = '';
  const request = async (route: string, method = 'GET', body?: unknown, options: { csrf?: boolean; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
        ...(csrfToken && options.csrf !== false && method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  return { request, register: async (username: string) => {
    const response = await request('/auth/register', 'POST', { username, password: PASSWORD, registrationSecret: SECRET });
    const session = await response.json();
    assert.equal(response.status, 201, JSON.stringify(session));
    csrfToken = session.csrfToken;
    return session as { user: { id: string }; csrfToken: string };
  } };
}

function gatedWorkflow(original: Workflow, blockedDemo = false): Workflow {
  const workflow = structuredClone(original);
  workflow.settings = { ...workflow.settings, entryNodeId: 'worker', mode: 'once', executionMode: 'demo' };
  workflow.nodes = [
    { id: 'worker', type: 'agent', position: { x: 0, y: 0 }, data: makeAgent(blockedDemo ? 'crawler' : 'custom') },
    { id: 'check', type: 'check', position: { x: 200, y: 0 }, data: { ...makeAgent('custom'), label: 'Report check',
      check: { requireOutput: true, requireFindingEvidence: blockedDemo, requireJudgment: false, blockedSeverities: [] } } },
    { id: 'gate', type: 'gate', position: { x: 400, y: 0 }, data: { ...makeAgent('custom'), label: 'Final approval',
      gate: { maxCorrections: 0, approval: 'human', risk: 'contained' } } },
    { id: 'after', type: 'agent', position: { x: 600, y: 0 }, data: makeAgent('custom') },
  ];
  workflow.edges = [
    { id: 'report', source: 'worker', target: 'check' },
    { id: 'criteria', source: 'check', target: 'gate' },
    { id: 'approved', source: 'gate', target: 'after' },
  ];
  return workflow;
}

async function state(client: ReturnType<typeof browser>): Promise<AppState> {
  const response = await client.request('/state');
  assert.equal(response.status, 200);
  return response.json();
}

async function pending(client: ReturnType<typeof browser>): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = (await state(client)).runs[0];
    assert.equal(run.status, 'running', run.error);
    if (run.approval?.status === 'pending') return run.id;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The workflow did not reach a durable human approval.');
}

async function approvalBody(client: ReturnType<typeof browser>, decision: 'approve' | 'reject' = 'approve') {
  const approval = (await state(client)).runs[0].approval;
  assert.ok(approval, 'a live approval token must be returned to the signed-in user');
  return { gateNodeId: approval.gateNodeId, decision, cycle: approval.cycle, requestedAt: approval.requestedAt };
}

test('approval API requires authentication and CSRF and cannot affect another account run', async () => {
  await withServer(async ({ instance, base }) => {
    const alice = browser(base), bob = browser(base), anonymous = browser(base);
    const aliceSession = await alice.register('alice-gate');
    const bobSession = await bob.register('bob-gate');
    for (const client of [alice, bob]) {
      const workflow = gatedWorkflow((await state(client)).workflow);
      assert.equal((await client.request('/workflow', 'PUT', workflow)).status, 200);
      assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 202);
    }
    const aliceRun = await pending(alice), bobRun = await pending(bob);
    assert.notEqual(aliceRun, bobRun);
    const decision = await approvalBody(alice);
    assert.equal((await anonymous.request(`/runs/${aliceRun}/approval`, 'POST', decision)).status, 401);
    assert.equal((await alice.request(`/runs/${aliceRun}/approval`, 'POST', decision, { csrf: false })).status, 403);
    assert.equal((await alice.request(`/runs/${aliceRun}/approval`, 'POST', decision, { headers: { 'X-CSRF-Token': bobSession.csrfToken } })).status, 403);
    assert.equal((await bob.request(`/runs/${aliceRun}/approval`, 'POST', decision)).status, 409);
    assert.equal((await state(alice)).runs[0].approval?.status, 'pending');
    assert.equal((await state(bob)).runs[0].approval?.status, 'pending');
    const approved = await alice.request(`/runs/${aliceRun}/approval`, 'POST', decision);
    assert.equal(approved.status, 200);
    const body = await approved.json() as AppState;
    assert.equal(body.runs.some(run => run.id === bobRun), false, 'approval response contains only the signed-in workspace');
    const aliceWorkspace = await instance.workspaces.get(aliceSession.user.id);
    await aliceWorkspace.engine.waitForIdle();
    const aliceFinal = (await state(alice)).runs[0];
    assert.equal(aliceFinal.status, 'completed');
    assert.equal(aliceFinal.approval?.status, 'approved');
    assert.ok(aliceFinal.results?.some(result => result.nodeId === 'after'));
    const bobPending = (await state(bob)).runs[0];
    assert.equal(bobPending.approval?.status, 'pending');
    assert.equal(bobPending.results?.some(result => result.nodeId === 'after'), false);
    assert.equal((await alice.request(`/runs/${aliceRun}/approval`, 'POST', decision)).status, 409);
    assert.equal((await bob.request(`/runs/${bobRun}/approval`, 'POST', await approvalBody(bob, 'reject'))).status, 200);
    await (await instance.workspaces.get(bobSession.user.id)).engine.waitForIdle();
    assert.equal((await state(bob)).runs[0].status, 'failed');
  });
});

test('approval API validates decisions and records rejection without releasing downstream work', async () => {
  await withServer(async ({ instance, base }) => {
    const client = browser(base);
    const session = await client.register('reject-gate');
    assert.equal((await client.request('/workflow', 'PUT', gatedWorkflow((await state(client)).workflow))).status, 200);
    assert.equal((await client.request('/runs/not-running/approval', 'POST', { gateNodeId: 'gate', decision: 'approve', cycle: 1, requestedAt: new Date().toISOString() })).status, 409);
    assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 202);
    const runId = await pending(client);
    const decision = await approvalBody(client);
    for (const body of [null, {}, { decision: 'approve' }, { ...decision, decision: 'accept' }, { ...decision, gateNodeId: 7 },
      { gateNodeId: 'gate', decision: 'approve' }, { ...decision, cycle: undefined }, { ...decision, requestedAt: undefined }]) {
      assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', body)).status, 400);
    }
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', { ...decision, gateNodeId: 'wrong-gate' })).status, 409);
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', { ...decision, requestedAt: new Date(0).toISOString() })).status, 409);
    assert.equal((await state(client)).runs[0].approval?.status, 'pending');
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', { ...decision, decision: 'reject' })).status, 200);
    await (await instance.workspaces.get(session.user.id)).engine.waitForIdle();
    const rejected = (await state(client)).runs[0];
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.approval?.status, 'rejected');
    assert.equal(rejected.results?.filter(result => result.nodeId === 'gate').at(-1)?.gate?.verdict, 'rejected');
    assert.equal(rejected.results?.some(result => result.nodeId === 'after'), false);
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', decision)).status, 409);
  });
});

test('approval API cannot override failed report checks or accept simulated evidence as real', async () => {
  await withServer(async ({ instance, base }) => {
    const client = browser(base);
    const session = await client.register('blocked-gate');
    assert.equal((await client.request('/workflow', 'PUT', gatedWorkflow((await state(client)).workflow, true))).status, 200);
    assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 202);
    await (await instance.workspaces.get(session.user.id)).engine.waitForIdle();
    const blocked = (await state(client)).runs[0];
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.approval, undefined);
    assert.equal(blocked.results?.some(result => result.nodeId === 'after'), false);
    assert.equal((await client.request(`/runs/${blocked.id}/approval`, 'POST', { gateNodeId: 'gate', decision: 'approve', cycle: 1, requestedAt: new Date().toISOString() })).status, 409);
  });
});

test('approval API rejects a prior cycle token when the same run waits at the same gate again', async () => {
  await withServer(async ({ instance, base }) => {
    const client = browser(base);
    const session = await client.register('cycle-gate');
    const workflow = gatedWorkflow((await state(client)).workflow);
    workflow.settings.mode = 'loop';
    workflow.settings.maxCycles = 2;
    workflow.settings.intervalSeconds = 0;
    assert.equal((await client.request('/workflow', 'PUT', workflow)).status, 200);
    assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 202);
    const runId = await pending(client);
    const first = await approvalBody(client);
    assert.equal(first.cycle, 1);
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', first)).status, 200);
    assert.equal(await pending(client), runId);
    const second = await approvalBody(client);
    assert.equal(second.cycle, 2);
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', first)).status, 409);
    const waiting = (await state(client)).runs[0];
    assert.equal(waiting.approval?.status, 'pending');
    assert.equal(waiting.results?.filter(result => result.nodeId === 'after').length, 1);
    assert.equal((await client.request(`/runs/${runId}/approval`, 'POST', second)).status, 200);
    await (await instance.workspaces.get(session.user.id)).engine.waitForIdle();
    const completed = (await state(client)).runs[0];
    assert.equal(completed.status, 'completed');
    assert.equal(completed.results?.filter(result => result.nodeId === 'after').length, 2);
  });
});
