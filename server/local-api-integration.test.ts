import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createApp, type AppOptions } from './index';
import { authenticatedFixture, fixtureRegistrationSecret } from './test-auth';
import type { AppState, ModelConfig, RuntimeStatus } from '../shared/types';

test('API persists messages and settings, validates recipients, and stops active runs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-api-'));
  const { app, engine, authHeaders, store } = await localApp({ statePath: path.join(directory, 'state.json'), demoStepMs: 60_000 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, method = 'GET', body?: unknown, origin?: string) => fetch(`${base}/api${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...authHeaders, ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
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

test('users can save their own compatible models without persisting credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-model-api-'));
  const statePath = path.join(directory, 'state.json');
  const { app, engine, authHeaders, store } = await localApp({ statePath });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...authHeaders }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const environmentName = 'TEST_MODEL_CREDENTIAL';
  const previous = process.env[environmentName];
  const credential = 'test-only-credential-must-stay-out-of-state';
  try {
    delete process.env[environmentName];
    const initial = await (await request('/state')).json() as AppState;
    const custom: ModelConfig = { id: 'my-model', name: 'My compatible model', provider: 'custom', modelId: 'my-own-model', kind: 'cloud', baseUrl: 'https://models.example.test/v1', apiKeyEnv: '', enabled: true };
    let models = [...initial.models, custom];
    const created = await request('/models', 'PUT', models);
    assert.equal(created.status, 200);
    assert.deepEqual((await created.json() as AppState).models.at(-1), custom);
    let runtime = await (await request('/runtime')).json() as RuntimeStatus;
    assert.equal(typeof runtime.piAvailable, 'boolean');
    assert.equal(runtime.models.find(model => model.id === custom.id)?.ready, true, 'Auth-free compatible endpoints do not require a cloud credential.');
    assert.match(runtime.models.find(model => model.id === custom.id)?.message ?? '', /not been tested/);

    models = [...initial.models, { ...custom, apiKeyEnv: environmentName }];
    assert.equal((await request('/models', 'PUT', models)).status, 200);
    runtime = await (await request('/runtime')).json() as RuntimeStatus;
    assert.equal(runtime.models.find(model => model.id === custom.id)?.ready, false);
    process.env[environmentName] = credential;
    const health = await (await request('/runtime')).text();
    assert.equal((JSON.parse(health) as RuntimeStatus).models.find(model => model.id === custom.id)?.ready, true);
    assert.ok(!health.includes(credential));

    const rawKey = await request('/models', 'PUT', [...initial.models, { ...custom, apiKey: credential }]);
    assert.equal(rawKey.status, 400);
    assert.ok(!(await rawKey.text()).includes(credential));
    assert.equal((await request('/models', 'PUT', [...initial.models, { ...custom, unexpected: true }])).status, 400);
    for (const provider of ['custom', 'ollama'] as const) {
      assert.equal((await request('/models', 'PUT', [...initial.models, { ...custom, provider, baseUrl: '' }])).status, 400);
    }
    const persisted = await readFile(store.filePath, 'utf8');
    assert.ok(!persisted.includes(credential));
    assert.deepEqual((await (await request('/state')).json() as AppState).models, models, 'Rejected edits must leave the saved model library intact.');

    models = [...initial.models, { ...custom, name: 'Updated compatible model' }];
    assert.equal((await request('/models', 'PUT', models)).status, 200);
    assert.equal((await (await request('/state')).json() as AppState).models.at(-1)?.name, 'Updated compatible model');
    assert.equal((await request('/models', 'PUT', initial.models)).status, 200);
    assert.deepEqual((await (await request('/state')).json() as AppState).models, initial.models);
  } finally {
    if (previous === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previous;
    await engine.stop();
    await engine.waitForIdle();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('subscription status stays read-only and probe routes enforce readiness and run locks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-account-api-'));
  const credentials = path.join(directory, 'credentials');
  const { app, engine, chatgpt, authHeaders, store } = await localApp({ statePath: path.join(directory, 'state.json'), demoStepMs: 60_000, chatgptOptions: { credentialDirectory: credentials, fetch: async () => { throw new Error('This test must never contact an external server.'); } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...authHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.deepEqual(await (await request('/chatgpt/status')).json(), { profiles: [] });
    assert.equal((await request('/runtime')).status, 200);
    await assert.rejects(stat(credentials), { code: 'ENOENT' }, 'Viewing health/status must not initialize credential storage.');
    assert.equal((await request('/models/missing/probe', 'POST', {})).status, 404);
    const state = await (await request('/state')).json() as AppState;
    const subscription: ModelConfig = { id: 'subscription', name: 'Optional stronger review', provider: 'openai', modelId: 'test-model', kind: 'cloud', baseUrl: '', apiKeyEnv: '', enabled: true, authMethod: 'chatgpt' };
    assert.equal((await request('/models', 'PUT', [...state.models, subscription])).status, 200);
    const probe = await request('/models/subscription/probe', 'POST', {});
    assert.equal(probe.status, 200);
    const result = await probe.json();
    assert.equal(result.ready, false);
    assert.match(result.message, /connect|ChatGPT/);
    await assert.rejects(stat(credentials), { code: 'ENOENT' });
    assert.equal((await request('/runs', 'POST', { mode: 'demo' })).status, 202);
    assert.equal((await request('/models/subscription/probe', 'POST', {})).status, 409);
    for (const action of ['login', 'select', 'logout', 'cancel']) assert.equal((await request(`/chatgpt/${action}`, 'POST', {})).status, 409);
    assert.equal((await request('/runs/stop', 'POST', {})).status, 200);
    assert.equal((await request('/chatgpt/select', 'POST', {})).status, 400);
    assert.equal((await request('/chatgpt/logout', 'POST', { profileId: '<invalid>' })).status, 400);
  } finally {
    await engine.stop(); await engine.waitForIdle(); await chatgpt.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown rejects new work immediately and drains the active run safely on duplicate calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-shutdown-api-'));
  const { app, engine, store, shutdown, authHeaders } = await localApp({ statePath: path.join(directory, 'state.json'), demoStepMs: 60_000,
    chatgptOptions: { credentialDirectory: path.join(directory, 'credentials'), fetch: async () => { throw new Error('Shutdown must not start an external request.'); } },
  });
  // Keep HTTP listening to verify the shutdown guard even on existing connections.
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (route: string, method = 'POST', body: unknown = {}) => fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(body) });
  try {
    assert.equal((await request('/runs', 'POST', { mode: 'demo' })).status, 202);
    assert.equal(engine.isRunning, true);
    let slow!: ReturnType<typeof httpRequest>;
    const accepted = new Promise<void>(resolve => server.once('request', () => resolve()));
    const slowResponse = new Promise<number>((resolve, reject) => {
      slow = httpRequest(`${base}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode!));
      });
      slow.once('error', reject);
      slow.write('{"mode":');
    });
    await accepted;
    const stopping = shutdown();
    const duplicate = shutdown();
    slow.end('"demo"}');
    assert.equal(await slowResponse, 503, 'A request accepted before shutdown must recheck after its slow body is parsed.');
    const state = store.get();
    const results = await Promise.all([
      request('/runs', 'POST', { mode: 'demo' }),
      request('/models', 'PUT', state.models),
      request('/models/qwen/probe'),
      request('/chatgpt/login'),
    ]);
    for (const response of results) {
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /shut|stop/i);
    }
    await Promise.all([stopping, duplicate, shutdown()]);
    assert.equal(engine.isRunning, false);
    assert.equal(store.get().runs.length, 1, 'Shutdown must never accept a replacement run.');
    assert.equal(store.get().runs[0].status, 'stopped');
    assert.equal(store.get().findings.length, 0);
    const persisted = JSON.parse(await readFile(store.filePath, 'utf8')) as AppState;
    assert.equal(persisted.runs[0].status, 'stopped');
  } finally {
    await shutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown drains credentials after a failed stop save and keeps new work blocked', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-shutdown-save-failure-'));
  const { app, engine, store, chatgpt, shutdown, authHeaders } = await localApp({ statePath: path.join(directory, 'state.json'), demoStepMs: 60_000,
    chatgptOptions: { credentialDirectory: path.join(directory, 'credentials'), fetch: async () => { throw new Error('Shutdown must not start an external request.'); } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const update = store.update.bind(store);
  const dispose = chatgpt.dispose.bind(chatgpt);
  let disposed = false;
  chatgpt.dispose = async () => { await dispose(); await new Promise(resolve => setTimeout(resolve, 20)); disposed = true; };
  try {
    await engine.start('demo');
    for (let attempt = 0; !store.get().runs[0].activeNodeId && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(store.get().runs[0].activeNodeId, 'The demo must be in an active step before injecting its stop-save failure.');
    store.update = async () => { throw new Error('Injected shutdown stop save failure'); };
    await assert.rejects(shutdown(), error => error instanceof AggregateError && error.errors.some(item => /shutdown stop save failure/.test(String(item))));
    assert.equal(disposed, true, 'An unsuccessful stop commit must still await credential rotation cleanup.');
    assert.equal(engine.isRunning, true, 'The failed durable stop must remain locked.');
    assert.equal(store.get().runs[0].status, 'running');
    for (const route of ['/runs', '/models/qwen/probe', '/chatgpt/login']) {
      const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: '{}' });
      assert.equal(response.status, 503);
      await response.text();
    }
    await assert.rejects(shutdown(), AggregateError, 'Repeated shutdown must retain the failure rather than restart resources.');
  } finally {
    store.update = update; chatgpt.dispose = dispose;
    await engine.stop(); await engine.waitForIdle(); await chatgpt.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
async function localApp(options: AppOptions) {
  return authenticatedFixture(await createApp({ ...options, registrationSecret: fixtureRegistrationSecret,
    config: { ...options.config, modelKeyNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TEST_MODEL_CREDENTIAL"], modelEndpointOrigins: ["http://127.0.0.1:11434", "http://localhost:11434", "https://models.example.test"] } }));
}
