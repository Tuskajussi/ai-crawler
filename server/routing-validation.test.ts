import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRoutingSettings, initialState } from '../shared/defaults';
import type { RoutingDecision } from '../shared/types';
import { validateRoutingSettings, validateWorkflow } from './validation';
import { StateStore } from './store';

test('routing is optional and settings support cloud and self-hosted decision APIs with bounded policies', () => {
  assert.doesNotThrow(() => validateWorkflow(initialState.workflow, initialState.models));
  for (const backend of ['system-one', 'llama-cpp']) for (const mode of ['off', 'shadow', 'active']) {
    assert.doesNotThrow(() => validateRoutingSettings({ ...defaultRoutingSettings, backend, mode, baseUrl: 'http://private-machine:8080/v1', apiKeyEnv: '' }));
  }
  for (const invalid of [
    null, [], { ...defaultRoutingSettings, mode: 'automatic' }, { ...defaultRoutingSettings, backend: 'chat-json' },
    { ...defaultRoutingSettings, apiKey: 'raw-credential' }, { ...defaultRoutingSettings, apiKeyEnv: 'raw-key-value' },
    { ...defaultRoutingSettings, mode: 'shadow', modelId: '' }, { ...defaultRoutingSettings, baseUrl: 'https://user:secret@example.test' },
    { ...defaultRoutingSettings, baseUrl: 'https://example.test/?key=secret' }, { ...defaultRoutingSettings, baseUrl: 'file:///tmp/model' },
    ...['confidenceThreshold', 'timeoutSeconds', 'maxDecisionsPerCycle', 'maxDecisionsPerRun', 'maxConcurrentRequests', 'contextWindow', 'temperature'].flatMap(field => [null, NaN, -1, '1'].map(value => ({ ...defaultRoutingSettings, [field]: value }))),
    ...[{ confidenceThreshold: 0.49 }, { confidenceThreshold: 1.01 }, { timeoutSeconds: 121 }, { maxDecisionsPerCycle: 101 }, { maxDecisionsPerRun: 1001 }, { maxConcurrentRequests: 9 }, { contextWindow: 4095 }, { contextWindow: 64001 }, { temperature: 0 }, { temperature: 11 }].map(value => ({ ...defaultRoutingSettings, ...value })),
  ]) assert.throws(() => validateRoutingSettings(invalid));
});

test('routing records are validated before publication and interrupted pending decisions become cancelled on restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-routing-store-'));
  const record: RoutingDecision = { id: 'decision-1', nodeId: 'crawler', cycle: 1, createdAt: new Date().toISOString(), questionVersion: 'worker-route-v1', mode: 'shadow', backend: 'system-one', configuredModelId: 'jev-1.13.0', threshold: 0.95, status: 'pending' };
  try {
    const store = await StateStore.open(path.join(directory, 'state.json'));
    await store.update(state => { state.runs = [{ id: 'run-1', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0, decisionCount: 1, decisions: [record] }]; });
    const saved = await readFile(store.filePath, 'utf8'); const memory = store.get();
    for (const bad of [{ confidence: 1.1 }, { probabilities: { assigned: 0.6, supervisor: 0.6, review: 0 } }, { choice: 'unlisted' }, { status: 'invented' }, { inputTokens: -1 }, { threshold: 0 }]) {
      await assert.rejects(store.update(state => { Object.assign(state.runs[0].decisions![0], bad); }));
      assert.deepEqual(store.get(), memory); assert.equal(await readFile(store.filePath, 'utf8'), saved);
    }
    const recovered = await StateStore.open(store.filePath);
    assert.equal(recovered.get().runs[0].status, 'stopped');
    assert.equal(recovered.get().runs[0].decisions![0].status, 'cancelled');
    assert.equal(recovered.get().runs[0].decisionCount, 1);
    assert.deepEqual(JSON.parse(await readFile(store.filePath, 'utf8')), recovered.get());
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
