import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './index';
import { authenticatedFixture, fixtureRegistrationSecret } from './test-auth';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean, explanation: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(explanation);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-probe-admission-'));
  const credentials = path.join(directory, 'credentials');
  const runtime = await authenticatedFixture(await createApp({ registrationSecret: fixtureRegistrationSecret,
    statePath: path.join(directory, 'state.json'), demoStepMs: 60_000,
    chatgptOptions: { credentialDirectory: credentials, fetch: async () => { throw new Error('Admission tests must never contact an external service.'); } },
  }));
  await runtime.store.update(state => {
    const node = state.workflow.nodes[0];
    state.workflow.nodes = [node]; state.workflow.edges = [];
    state.workflow.settings = { ...state.workflow.settings, mode: 'once', entryNodeId: node.id };
    state.models.push({
      id: 'subscription-fixture', name: 'Admission fixture', provider: 'openai', modelId: 'fixture', kind: 'cloud',
      baseUrl: '', apiKeyEnv: '', enabled: true, authMethod: 'chatgpt', chatgptProfileId: 'fixture-profile',
    });
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (route: string, body: unknown = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...runtime.authHeaders }, body: JSON.stringify(body),
  });
  return {
    ...runtime, request, credentials,
    cleanup: async () => {
      await runtime.shutdown();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('concurrent connection probes serialize through readiness and finish before another probe enters', { timeout: 15000 }, async () => {
  const runtime = await fixture();
  const releases = [deferred(), deferred()];
  let checks = 0; let active = 0; let peak = 0; let admissions = 0;
  const whenIdle = runtime.engine.whenIdle.bind(runtime.engine);
  runtime.engine.whenIdle = <T>(operation: () => Promise<T>) => { admissions++; return whenIdle(operation); };
  runtime.chatgpt.profileReadiness = async profileId => {
    assert.equal(profileId, 'fixture-profile');
    const index = checks++;
    active++; peak = Math.max(peak, active);
    await releases[index].promise;
    active--;
    return { ready: false, message: `Fixture readiness result ${index + 1}.` };
  };
  try {
    const first = runtime.request('/models/subscription-fixture/probe');
    await until(() => checks === 1, 'The first probe must enter readiness.');
    const second = runtime.request('/models/subscription-fixture/probe');
    await until(() => admissions === 2, 'The second probe must reach lifecycle admission.');
    assert.equal(checks, 1, 'A second request must wait through the complete first probe.');
    assert.equal(runtime.engine.isRunning, false);
    releases[0].resolve();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.deepEqual((await firstResponse.json()).message, 'Fixture readiness result 1.');
    await until(() => checks === 2, 'The second probe should enter after the first probe finishes.');
    assert.equal(active, 1);
    releases[1].resolve();
    const secondResponse = await second;
    assert.equal(secondResponse.status, 200); assert.equal((await secondResponse.json()).message, 'Fixture readiness result 2.');
    assert.equal(peak, 1); assert.equal(runtime.store.get().runs.length, 0);
    await assert.rejects(stat(runtime.credentials), { code: 'ENOENT' }, 'The fake readiness checks must not create credentials.');
  } finally { releases.forEach(release => release.resolve()); await runtime.cleanup(); }
});

test('a run waits for an admitted probe and a probe queued behind that run is rejected before readiness', { timeout: 15000 }, async () => {
  const runtime = await fixture();
  const release = deferred();
  let checks = 0; let admissions = 0; let starts = 0;
  const whenIdle = runtime.engine.whenIdle.bind(runtime.engine);
  runtime.engine.whenIdle = <T>(operation: () => Promise<T>) => { admissions++; return whenIdle(operation); };
  const start = runtime.engine.start.bind(runtime.engine);
  runtime.engine.start = mode => { starts++; return start(mode); };
  runtime.chatgpt.profileReadiness = async () => {
    checks++; await release.promise;
    return { ready: false, message: 'Fixture readiness completed.' };
  };
  try {
    const probing = runtime.request('/models/subscription-fixture/probe');
    await until(() => checks === 1, 'The first probe must hold lifecycle admission.');
    const starting = runtime.request('/runs', { mode: 'demo' });
    await until(() => starts === 1, 'The start request must reach the engine while readiness is blocked.');
    assert.equal(runtime.engine.isRunning, false, 'A run cannot start while a probe owns lifecycle admission.');
    assert.equal(runtime.store.get().runs.length, 0);
    const queuedProbe = runtime.request('/models/subscription-fixture/probe');
    await until(() => admissions === 2, 'The second probe must be queued behind the run, before the first probe is released.');
    assert.equal(checks, 1);
    release.resolve();
    const probeResponse = await probing;
    assert.equal(probeResponse.status, 200); assert.equal((await probeResponse.json()).ready, false);
    const runResponse = await starting;
    assert.equal(runResponse.status, 202); await runResponse.json();
    const rejected = await queuedProbe;
    assert.equal(rejected.status, 409); assert.match((await rejected.json()).error, /Stop the active run/);
    assert.equal(checks, 1, 'A queued probe must recheck the active run before readiness or inference.');
    assert.equal(runtime.engine.isRunning, true); assert.equal(runtime.store.get().runs.length, 1);
    const whileRunning = await runtime.request('/models/subscription-fixture/probe');
    assert.equal(whileRunning.status, 409); await whileRunning.json();
    assert.equal(checks, 1);
    await assert.rejects(stat(runtime.credentials), { code: 'ENOENT' });
  } finally { release.resolve(); await runtime.cleanup(); }
});
