import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './index';

test('API persists messages and settings, validates recipients, and stops active runs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-api-'));
  const { app, engine } = await createApp({ statePath: path.join(directory, 'state.json'), demoStepMs: 60_000 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, method = 'GET', body?: unknown, origin?: string) => fetch(`${base}/api${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const stateResponse = await request('/state');
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal((await request('/messages', 'POST', { from: 'you', to: 'missing', text: 'hello', type: 'message' })).status, 400);
    const sent = await request('/messages', 'POST', { from: 'you', to: 'tester', text: 'Review empty responses.', type: 'assignment' });
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).messages.at(-1).to, 'tester');
    assert.equal((await request('/state', 'GET', undefined, 'https://untrusted.example')).status, 403);
    state.workflow.settings.mode = 'once';
    assert.equal((await request('/workflow', 'PUT', state.workflow)).status, 200);
    assert.equal((await request('/runs', 'POST', { mode: 'demo' })).status, 202);
    assert.equal((await request('/runs', 'POST', { mode: 'demo' })).status, 409);
    assert.equal((await request('/workflow', 'PUT', state.workflow)).status, 409);
    const stopped = await request('/runs/stop', 'POST', {});
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).runs[0].status, 'stopped');
    await engine.waitForIdle();
    assert.equal((await request('/findings/missing', 'PATCH', { status: 'resolved' })).status, 404);
  } finally {
    await engine.stop();
    await engine.waitForIdle();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
