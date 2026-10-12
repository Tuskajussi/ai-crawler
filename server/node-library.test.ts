import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, roleMeta } from '../shared/defaults';
import {
  compatibleTemplateModels, instantiateNodeTemplate, nodeTemplateCategories,
  nodeTemplates, suggestedTemplateModel,
} from '../shared/node-library';
import type { NodeTemplate } from '../shared/node-library';
import type { ModelConfig } from '../shared/types';
import { validateModels, validateWorkflow } from './validation';

function template(id: string): NodeTemplate {
  const result = nodeTemplates.find(item => item.id === id);
  assert.ok(result, `Missing library preset ${id}`);
  return result;
}

const cloud: ModelConfig = { ...initialState.models[0], id: 'cloud', supportsImages: true };
const local: ModelConfig = { ...initialState.models[1], id: 'local', supportsImages: false };
const localVision: ModelConfig = { ...local, id: 'local-vision', supportsImages: true };
const disabled: ModelConfig = { ...cloud, id: 'disabled', enabled: false };

test('the curated catalogue has unique usable identities and covers each category', () => {
  assert.ok(nodeTemplates.length >= 12 && nodeTemplates.length <= 18);
  assert.equal(new Set(nodeTemplates.map(item => item.id)).size, nodeTemplates.length);
  assert.equal(new Set(nodeTemplates.map(item => item.name)).size, nodeTemplates.length);
  assert.deepEqual(nodeTemplateCategories.map(item => item.label), ['Discover', 'Review', 'Visual', 'Coordinate']);
  for (const category of nodeTemplateCategories) {
    assert.ok(nodeTemplates.some(item => item.category === category.id));
  }
  const custom = template('custom-agent');
  assert.equal(custom.name, 'Custom agent');
  assert.equal(custom.description, 'Your role. Your instructions.');
  assert.equal(custom.role, 'custom');
});

test('all presets instantiate into one connected workflow accepted by the real validator', () => {
  const workflow = structuredClone(initialState.workflow);
  const models = structuredClone(initialState.models);
  workflow.settings.supervisorModelId = 'claude';
  workflow.nodes = nodeTemplates.map((item, index) => {
    const model = suggestedTemplateModel(item, models, workflow.settings.supervisorModelId);
    assert.ok(model, `No compatible model for ${item.name}`);
    const data = instantiateNodeTemplate(item, model);
    assert.equal(data.status, 'idle');
    assert.equal(data.color, roleMeta[item.role].color);
    assert.equal(data.label, item.name);
    assert.equal(data.modelId, model.id);
    assert.ok(data.persona.trim());
    assert.ok(data.prompt.trim());
    assert.ok(data.responsibilities.length > 0);
    assert.ok(item.tags.length > 0);
    return { id: item.id, type: 'agent', position: { x: index * 100, y: 0 }, data };
  });
  workflow.settings.entryNodeId = workflow.nodes[0].id;
  workflow.edges = workflow.nodes.slice(1).map((node, index) => ({
    id: `library-edge-${index}`, source: workflow.nodes[index].id, target: node.id,
  }));
  validateModels(models);
  validateWorkflow(workflow, models);
});

test('regular presets filter disabled models and prefer an enabled local worker', () => {
  const preset = template('code-scout');
  const models = [disabled, cloud, local];
  assert.deepEqual(compatibleTemplateModels(preset, models).map(model => model.id), ['cloud', 'local']);
  assert.equal(suggestedTemplateModel(preset, models)?.id, 'local');
  assert.equal(suggestedTemplateModel(preset, [disabled, cloud])?.id, 'cloud');
  assert.equal(suggestedTemplateModel(preset, [disabled]), undefined);
  assert.deepEqual(compatibleTemplateModels(preset, []), []);
  for (const ordinary of nodeTemplates.filter(item => item.category !== 'visual' && item.id !== 'senior-reviewer')) {
    assert.equal(ordinary.modelPreference, 'local', ordinary.name);
    assert.equal(suggestedTemplateModel(ordinary, models, cloud.id)?.id, local.id);
  }
});

test('visual presets require explicit image support and prefer a compatible local model', () => {
  const absentCapability = { ...local, id: 'unknown-images', supportsImages: undefined };
  const models = [disabled, cloud, local, absentCapability, localVision];
  for (const preset of nodeTemplates.filter(item => item.category === 'visual')) {
    assert.ok(preset.tools.includes('screenshot'));
    assert.equal(preset.modelPreference, 'vision');
    assert.deepEqual(compatibleTemplateModels(preset, models).map(model => model.id), ['cloud', 'local-vision']);
    assert.equal(suggestedTemplateModel(preset, models)?.id, 'local-vision');
    assert.equal(suggestedTemplateModel(preset, [local, absentCapability, cloud])?.id, 'cloud');
    assert.equal(suggestedTemplateModel(preset, [local, absentCapability, disabled]), undefined);
    assert.throws(() => instantiateNodeTemplate(preset, local), /image input/);
    assert.throws(() => instantiateNodeTemplate(preset, absentCapability), /image input/);
  }
});

test('supervisor suggestions honor configured enabled models, then cloud, then local fallback', () => {
  const preset = template('senior-reviewer');
  assert.equal(preset.modelPreference, 'supervisor');
  const supervisor = { ...cloud, id: 'configured-supervisor' };
  const models = [local, cloud, disabled, supervisor];
  assert.equal(suggestedTemplateModel(preset, models, supervisor.id)?.id, supervisor.id);
  assert.equal(suggestedTemplateModel(preset, models, local.id)?.id, local.id);
  assert.equal(suggestedTemplateModel(preset, models, disabled.id)?.id, cloud.id);
  assert.equal(suggestedTemplateModel(preset, models, 'missing-supervisor')?.id, cloud.id);
  assert.equal(suggestedTemplateModel(preset, [local, disabled])?.id, local.id);
  assert.equal(suggestedTemplateModel(preset, [disabled], disabled.id), undefined);
});

test('a supervisor preference never overrides screenshot capability requirements', () => {
  const preset: NodeTemplate = { ...template('ui-inspector'), modelPreference: 'supervisor' };
  const models = [local, cloud, disabled, localVision];
  assert.equal(suggestedTemplateModel(preset, models, local.id)?.id, cloud.id);
  assert.equal(suggestedTemplateModel(preset, models, localVision.id)?.id, localVision.id);
  assert.equal(suggestedTemplateModel(preset, [local, disabled], local.id), undefined);
});

test('editing an instantiated agent does not mutate another node, the template, or model inputs', () => {
  const models = structuredClone([cloud, localVision, local]);
  const originalModels = structuredClone(models);
  for (const preset of nodeTemplates) {
    const original = structuredClone(preset);
    const model = suggestedTemplateModel(preset, models)!;
    const first = instantiateNodeTemplate(preset, model);
    const second = instantiateNodeTemplate(preset, model);
    first.label = 'Edited node';
    first.persona = 'Edited persona';
    first.prompt = 'Edited assignment';
    first.responsibilities.push('One node only');
    first.tools.splice(0, first.tools.length);
    first.status = 'running';
    assert.equal(second.label, preset.name);
    assert.equal(second.status, 'idle');
    assert.deepEqual(second.responsibilities, preset.responsibilities);
    assert.deepEqual(second.tools, preset.tools);
    assert.deepEqual(preset, original);
  }
  compatibleTemplateModels(template('code-reviewer'), models).reverse();
  assert.deepEqual(models, originalModels);
});

test('disabled models cannot instantiate even a non-visual preset', () => {
  assert.throws(() => instantiateNodeTemplate(template('code-reviewer'), disabled), /Enable the selected model/);
});
