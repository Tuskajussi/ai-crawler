import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelConfig } from '../shared/types';
import { initialState } from '../shared/defaults';
import { modelReadiness } from './pi';
import { validateModels, validateWorkflow } from './validation';

const compatible: ModelConfig = { id: 'mine', name: 'My model', provider: 'custom', modelId: 'own-model', kind: 'cloud', baseUrl: 'https://models.example.test/v1', apiKeyEnv: '', enabled: true };

test('model readiness checks configuration without requiring credentials for compatible endpoints', () => {
  assert.equal(modelReadiness(compatible, {}).ready, true);
  assert.match(modelReadiness(compatible, {}).message, /not been tested/);
  assert.equal(modelReadiness({ ...compatible, enabled: false }, {}).ready, false);
  assert.equal(modelReadiness({ ...compatible, baseUrl: '' }, {}).ready, false);
  assert.equal(modelReadiness({ ...compatible, provider: 'ollama', kind: 'local', baseUrl: '' }, {}).ready, false);
  assert.equal(modelReadiness({ ...compatible, provider: 'ollama', kind: 'local' }, {}).ready, true);
  for (const provider of ['anthropic', 'openai'] as const) {
    assert.equal(modelReadiness({ ...compatible, provider, baseUrl: '' }, {}).ready, false);
    assert.equal(modelReadiness({ ...compatible, provider, baseUrl: '', apiKeyEnv: 'MY_MODEL_KEY' }, { MY_MODEL_KEY: 'test-credential' }).ready, true);
  }
});

test('configured model credentials must exist and their values never appear in readiness', () => {
  const model = { ...compatible, apiKeyEnv: 'MY_MODEL_KEY' };
  for (const environment of [{}, { MY_MODEL_KEY: '' }]) {
    const readiness = modelReadiness(model, environment);
    assert.equal(readiness.ready, false);
    assert.match(readiness.message, /MY_MODEL_KEY/);
  }
  const credential = 'test-credential-must-not-appear-in-status';
  const readiness = modelReadiness(model, { MY_MODEL_KEY: credential });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.id, model.id);
  assert.ok(!JSON.stringify(readiness).includes(credential));
});

test('model limits remain optional and enforce timeout and context boundaries', () => {
  assert.doesNotThrow(() => validateModels([compatible]));
  assert.doesNotThrow(() => validateModels([{ ...compatible, contextWindow: 65536, maxOutputTokens: 32768, timeoutSeconds: 1800, reasoningEffort: 'high' }]));
  assert.doesNotThrow(() => validateModels([{ ...compatible, contextWindow: 1024, maxOutputTokens: 768, timeoutSeconds: 15, reasoningEffort: 'off' }]));
  for (const values of [{ maxOutputTokens: 255 }, { maxOutputTokens: 32769 }, { maxOutputTokens: 32768 }, { contextWindow: 1024, maxOutputTokens: 769 }, { timeoutSeconds: 14 }, { timeoutSeconds: 1801 }, { timeoutSeconds: 20.5 }, { reasoningEffort: 'unlimited' }]) {
    assert.throws(() => validateModels([{ ...compatible, ...values }]));
  }
});

test('endpoint request slots are optional for existing models and bounded for local servers', () => {
  assert.doesNotThrow(() => validateModels([compatible]));
  for (const maxConcurrentRequests of [1, 8]) assert.doesNotThrow(() => validateModels([{ ...compatible, maxConcurrentRequests }]));
  for (const maxConcurrentRequests of [0, 9, 1.5, NaN, '2', null]) {
    assert.throws(() => validateModels([{ ...compatible, maxConcurrentRequests }]), /request slots/);
  }
});

test('parallel workers remain optional for old workflows and cannot exceed the worker limit', () => {
  const workflow = structuredClone(initialState.workflow);
  delete workflow.settings.maxParallelAgents;
  assert.doesNotThrow(() => validateWorkflow(workflow, initialState.models));
  for (const maxParallelAgents of [1, 8]) assert.doesNotThrow(() => validateWorkflow({ ...workflow, settings: { ...workflow.settings, maxParallelAgents } }, initialState.models));
  for (const maxParallelAgents of [0, 9, 1.5, NaN, '2', null]) {
    assert.throws(() => validateWorkflow({ ...workflow, settings: { ...workflow.settings, maxParallelAgents } }, initialState.models), /parallel agents/);
  }
});

test('ChatGPT authentication is restricted to OpenAI and its official endpoint', () => {
  const model = { ...compatible, provider: 'openai', baseUrl: '', authMethod: 'chatgpt', chatgptProfileId: 'profile-1' };
  assert.doesNotThrow(() => validateModels([model]));
  assert.doesNotThrow(() => validateModels([{ ...model, baseUrl: 'https://api.openai.com/v1/' }]));
  for (const changes of [{ provider: 'custom' }, { kind: 'local' }, { baseUrl: 'https://models.example.test/v1' }, { authMethod: 'apiKey' }, { chatgptProfileId: 'bad/profile' }, { authMethod: 'unknown' }]) {
    assert.throws(() => validateModels([{ ...model, ...changes }]));
  }
  assert.throws(() => validateModels([{ ...compatible, rawToken: 'never-store-this' }]));
});

test('supervisor settings are opt-in, bounded, and reference an enabled model', () => {
  const workflow = structuredClone(initialState.workflow);
  assert.doesNotThrow(() => validateWorkflow(workflow, initialState.models));
  const legacy = structuredClone(workflow);
  delete legacy.settings.maxEscalationsPerCycle;
  delete legacy.settings.maxEscalationsPerRun;
  assert.doesNotThrow(() => validateWorkflow(legacy, initialState.models));
  workflow.settings.supervisorModelId = initialState.models[0].id;
  workflow.settings.maxEscalationsPerCycle = 10;
  workflow.settings.maxEscalationsPerRun = 100;
  assert.doesNotThrow(() => validateWorkflow(workflow, initialState.models));
  for (const limit of [0, 11, 1.5]) {
    workflow.settings.maxEscalationsPerCycle = limit;
    assert.throws(() => validateWorkflow(workflow, initialState.models), /supervisor visits/);
  }
  workflow.settings.maxEscalationsPerCycle = 1;
  for (const limit of [0, 101, 1.5]) {
    workflow.settings.maxEscalationsPerRun = limit;
    assert.throws(() => validateWorkflow(workflow, initialState.models), /supervisor visits/);
  }
  workflow.settings.maxEscalationsPerRun = 10;
  workflow.settings.supervisorModelId = 'missing';
  assert.throws(() => validateWorkflow(workflow, initialState.models), /supervisor/i);
  workflow.settings.supervisorModelId = compatible.id;
  assert.throws(() => validateWorkflow(workflow, [...initialState.models, { ...compatible, enabled: false }]), /supervisor/i);
});
