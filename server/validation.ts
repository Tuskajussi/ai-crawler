import type { ModelConfig, Workflow } from '../shared/types';

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
const roles = new Set(['crawler', 'tester', 'designer', 'reviewer', 'coordinator', 'custom']);

function text(value: unknown, label: string, maximum = 20_000, allowEmpty = true): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new InputError(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maximum} characters.`);
  }
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new InputError(`${label} must use letters, numbers, dashes, or underscores (1–100 characters).`);
}

export function validateModels(input: unknown): asserts input is ModelConfig[] {
  if (!Array.isArray(input) || input.length > 100) throw new InputError('Models must be a list of at most 100 entries.');
  const seen = new Set<string>();
  for (const model of input) {
    if (!model || typeof model !== 'object') throw new InputError('Each model must be an object.');
    id(model.id, 'Model ID');
    if (seen.has(model.id)) throw new InputError(`Duplicate model ID: ${model.id}.`);
    seen.add(model.id);
    text(model.name, 'Model name', 200, false);
    text(model.modelId, 'Provider model ID', 300, false);
    text(model.baseUrl, 'Model base URL', 2000);
    text(model.apiKeyEnv, 'API key environment variable', 200);
    if (!['anthropic', 'openai', 'ollama', 'custom'].includes(model.provider)) throw new InputError('Unsupported model provider.');
    if (!['local', 'cloud'].includes(model.kind) || typeof model.enabled !== 'boolean') throw new InputError('Invalid model kind or enabled flag.');
    if (model.supportsImages !== undefined && typeof model.supportsImages !== 'boolean') throw new InputError('Image support must be a boolean.');
    if (model.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) throw new InputError('API key must be an environment variable name, never the key itself.');
    if (model.baseUrl) {
      let url: URL;
      try { url = new URL(model.baseUrl); } catch { throw new InputError('Model base URL must be an absolute HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InputError('Model URLs must use HTTP(S), without credentials, query strings, or fragments.');
    }
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 10_000_000)) throw new InputError('Context window must be between 1,024 and 10,000,000 tokens.');
  }
}

export function traversalOrder(workflow: Workflow): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const queue = [workflow.settings.entryNodeId];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const nodeId = queue[index];
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    queue.push(...(outgoing.get(nodeId) ?? []));
  }
  return [...visited];
}

export function validateWorkflow(input: unknown, models: ModelConfig[]): asserts input is Workflow {
  if (!input || typeof input !== 'object') throw new InputError('Workflow must be an object.');
  const workflow = input as Workflow;
  id(workflow.id, 'Workflow ID');
  text(workflow.name, 'Workflow name', 200, false);
  text(workflow.description, 'Workflow description', 5000);
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length < 1 || workflow.nodes.length > 100) throw new InputError('A workflow needs 1–100 agents.');
  if (!Array.isArray(workflow.edges) || workflow.edges.length > 1000) throw new InputError('Workflow edges must be a list of at most 1,000 connections.');
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (!node || typeof node !== 'object') throw new InputError('Each agent must be an object.');
    id(node.id, 'Agent ID');
    if (ids.has(node.id)) throw new InputError(`Duplicate agent ID: ${node.id}.`);
    ids.add(node.id);
    if (node.type !== 'agent' || !node.data || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new InputError(`Invalid agent: ${node.id}.`);
    const data = node.data;
    text(data.label, 'Agent name', 200, false);
    text(data.description, 'Agent description', 5000);
    text(data.persona, 'Agent persona');
    text(data.prompt, 'Agent prompt');
    text(data.color, 'Agent color', 50, false);
    if (!roles.has(data.role)) throw new InputError(`Unsupported role on ${data.label}.`);
    if (!Array.isArray(data.tools) || data.tools.some(tool => !['read', 'screenshot'].includes(tool))) throw new InputError(`Invalid tools on ${data.label}.`);
    if (!Array.isArray(data.responsibilities) || data.responsibilities.length > 50) throw new InputError('Agent responsibilities must be a list of at most 50 items.');
    data.responsibilities.forEach(item => text(item, 'Responsibility', 2000));
    if (!models.some(model => model.id === data.modelId && model.enabled)) throw new InputError(`${data.label} needs an enabled model. Choose one in agent settings.`);
  }
  const edgeIds = new Set<string>();
  for (const edge of workflow.edges) {
    if (!edge || typeof edge !== 'object') throw new InputError('Each connection must be an object.');
    id(edge.id, 'Connection ID');
    if (edgeIds.has(edge.id)) throw new InputError(`Duplicate connection ID: ${edge.id}.`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new InputError(`Connection ${edge.id} points to a missing agent.`);
    if (edge.label !== undefined) text(edge.label, 'Connection label', 200);
  }
  const settings = workflow.settings;
  if (!settings || !['loop', 'once'].includes(settings.mode) || !['demo', 'pi'].includes(settings.executionMode)) throw new InputError('Invalid workflow execution settings.');
  if (settings.continuous !== undefined && typeof settings.continuous !== 'boolean') throw new InputError('Continuous crawling must be a boolean.');
  if (!Number.isInteger(settings.maxCycles) || settings.maxCycles < 1 || settings.maxCycles > 1000) throw new InputError('Maximum cycles must be an integer from 1 to 1,000.');
  if (!Number.isFinite(settings.intervalSeconds) || settings.intervalSeconds < 0 || settings.intervalSeconds > 86400) throw new InputError('Cycle interval must be from 0 to 86,400 seconds.');
  if (!ids.has(settings.entryNodeId)) throw new InputError('Choose an entry agent that exists in the workflow.');
  text(settings.projectPath, 'Project path', 4000);
  text(settings.previewUrl, 'Preview URL', 2000);
  const reachable = new Set(traversalOrder(workflow));
  const disconnected = workflow.nodes.filter(node => !reachable.has(node.id));
  if (disconnected.length) throw new InputError(`Connect all agents to the entry agent. Unreachable: ${disconnected.map(node => node.data.label).join(', ')}.`);
}

export function localPreviewUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError('Screenshot agents need a valid local preview URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new InputError('Preview URL must use HTTP(S) on localhost, 127.0.0.1, or [::1], without credentials.');
  }
  return url;
}
