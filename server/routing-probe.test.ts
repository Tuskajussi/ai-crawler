import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRoutingSettings } from '../shared/defaults';
import { createApp } from './index';

test('decision probes use a synthetic assignment, validate native protocol, and share the active run lock', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-routing-probe-'));
  let calls = 0;
  const requests: unknown[] = [];
  const inference = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw)); calls++;
    const body = JSON.parse(raw);
    const key = Object.keys(body.questions)[0];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'self-hosted-decision-v1', answers: { [key]: { type: 'choice', choice: 'assigned', probabilities: { assigned: 0.99, supervisor: 0.005, review: 0.005 }, confidence: 0.98 } }, usage: { input_tokens: 40, output_tokens: 0 } }));
  });
  await new Promise<void>(resolve => inference.listen(0, '127.0.0.1', resolve));
  const runtime = await createApp({ statePath: path.join(directory, 'state.json'), demoStepMs: 60_000, chatgptOptions: { credentialDirectory: path.join(directory, 'credentials') } });
  await runtime.store.update(state => { state.workflow.nodes[0].data.prompt = 'PRIVATE_PROBE_PROJECT_PROMPT'; state.messages[0].text = 'PRIVATE_PROBE_SHARED_EVIDENCE'; });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const routing = { ...defaultRoutingSettings, mode: 'shadow', baseUrl: `http://127.0.0.1:${(inference.address() as { port: number }).port}/v1`, modelId: 'self-hosted-decision-v1', apiKeyEnv: '' };
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let response = await post('/routing/probe', routing);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ready, true); assert.equal(result.answer.modelId, 'self-hosted-decision-v1');
    assert.equal(result.answer.choice, 'assigned'); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_PROBE/);
    assert.equal(runtime.store.get().workflow.settings.routing, undefined, 'Testing unsaved settings must not activate routing.');
    response = await post('/routing/probe', { ...routing, apiKey: 'never-persist-a-secret' });
    assert.equal(response.status, 400); await response.json(); assert.equal(calls, 1);
    response = await post('/runs', { mode: 'demo' }); assert.equal(response.status, 202); await response.json();
    response = await post('/routing/probe', routing); assert.equal(response.status, 409); await response.json();
    assert.equal(calls, 1);
  } finally {
    await runtime.shutdown();
    server.closeAllConnections(); inference.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => inference.close(() => resolve()))]);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
