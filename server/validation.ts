import type { ModelConfig, Workflow, RoutingSettings, RoutingDecision } from '../shared/types';

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
const roles = new Set(['crawler', 'tester', 'designer', 'reviewer', 'coordinator', 'judge', 'custom']);
const modelFields = new Set(['id', 'name', 'provider', 'modelId', 'kind', 'baseUrl', 'apiKeyEnv', 'enabled', 'contextWindow', 'supportsImages', 'maxOutputTokens', 'timeoutSeconds', 'reasoningEffort', 'authMethod', 'chatgptProfileId', 'maxConcurrentRequests']);

function text(value: unknown, label: string, maximum = 20_000, allowEmpty = true): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new InputError(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maximum} characters.`);
  }
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new InputError(`${label} must use letters, numbers, dashes, or underscores (1–100 characters).`);
}

export function validateRoutingSettings(input: unknown): asserts input is RoutingSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Decision routing settings must be an object.');
  const settings = input as RoutingSettings;
  const fields = new Set(['mode', 'backend', 'baseUrl', 'modelId', 'apiKeyEnv', 'confidenceThreshold', 'timeoutSeconds', 'maxDecisionsPerCycle', 'maxDecisionsPerRun', 'maxConcurrentRequests', 'contextWindow', 'temperature']);
  if (Object.keys(settings).some(field => !fields.has(field))) throw new InputError('Decision routing contains an unsupported field. Use an API key environment variable name, never a raw key.');
  if (!['off', 'shadow', 'active'].includes(settings.mode) || !['system-one', 'llama-cpp'].includes(settings.backend)) throw new InputError('Choose a supported decision routing mode and API.');
  text(settings.modelId, 'Decision model ID', 300, settings.mode === 'off');
  text(settings.baseUrl, 'Decision endpoint URL', 2000, false);
  let url: URL;
  try { url = new URL(settings.baseUrl); } catch { throw new InputError('Decision endpoint must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InputError('Decision endpoint must use HTTP(S), without credentials, query strings, or fragments.');
  text(settings.apiKeyEnv, 'Decision key environment variable', 200);
  if (settings.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.apiKeyEnv)) throw new InputError('Decision API key must be an environment variable name, never the key itself.');
  if (!Number.isFinite(settings.confidenceThreshold) || settings.confidenceThreshold < 0.5 || settings.confidenceThreshold > 1) throw new InputError('Decision confidence threshold must be between 0.5 and 1.');
  for (const [field, label, minimum, maximum] of [
    ['timeoutSeconds', 'Decision timeout', 1, 120], ['maxDecisionsPerCycle', 'Decision allowance per cycle', 1, 100],
    ['maxDecisionsPerRun', 'Decision allowance per run', 1, 1000], ['maxConcurrentRequests', 'Decision endpoint slots', 1, 8],
    ['contextWindow', 'Decision context window', 4096, 64000],
  ] as const) {
    if (!Number.isInteger(settings[field]) || settings[field] < minimum || settings[field] > maximum) throw new InputError(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  if (!Number.isFinite(settings.temperature) || settings.temperature < 0.1 || settings.temperature > 10) throw new InputError('Decision temperature must be between 0.1 and 10.');
}

export function validateRoutingDecisions(input: unknown): asserts input is RoutingDecision[] {
  if (!Array.isArray(input) || input.length > 500) throw new InputError('A run can retain at most 500 routing decisions.');
  const choices = ['assigned', 'supervisor', 'review'];
  const seen = new Set<string>();
  for (const decision of input) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new InputError('Invalid saved routing decision.');
    id(decision.id, 'Routing decision ID'); id(decision.nodeId, 'Routing node ID');
    if (seen.has(decision.id)) throw new InputError('Duplicate saved routing decision ID.');
    seen.add(decision.id);
    if (!Number.isInteger(decision.cycle) || decision.cycle < 1 || !Number.isFinite(Date.parse(decision.createdAt))) throw new InputError('Invalid routing decision cycle or date.');
    text(decision.questionVersion, 'Routing question version', 100, false);
    text(decision.configuredModelId, 'Configured decision model', 300, false);
    if (!['shadow', 'active'].includes(decision.mode) || !['system-one', 'llama-cpp'].includes(decision.backend)
      || !['pending', 'completed', 'error', 'cancelled', 'budget'].includes(decision.status)) throw new InputError('Invalid routing decision mode, API or status.');
    if (!Number.isFinite(decision.threshold) || decision.threshold < 0.5 || decision.threshold > 1) throw new InputError('Invalid saved routing threshold.');
    for (const field of ['choice', 'recommendation']) if (decision[field] !== undefined && !choices.includes(decision[field])) throw new InputError('Invalid saved routing choice.');
    if (decision.confidence !== undefined && (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)) throw new InputError('Invalid saved routing confidence.');
    if (decision.probabilities !== undefined) {
      const values = decision.probabilities;
      if (!values || typeof values !== 'object' || Object.keys(values).length !== 3 || choices.some(choice => !Number.isFinite(values[choice]) || values[choice] < 0 || values[choice] > 1)
        || Math.abs(choices.reduce((sum, choice) => sum + values[choice], 0) - 1) > 0.0001) throw new InputError('Invalid saved routing probabilities.');
    }
    if (decision.modelId !== undefined) text(decision.modelId, 'Resolved decision model', 300, false);
    if (decision.selectedModelId !== undefined) id(decision.selectedModelId, 'Selected routing model');
    if (decision.reason !== undefined) text(decision.reason, 'Routing reason', 2000, false);
    if (decision.durationMs !== undefined && (!Number.isFinite(decision.durationMs) || decision.durationMs < 0)) throw new InputError('Invalid routing duration.');
    if (decision.inputTokens !== undefined && (!Number.isInteger(decision.inputTokens) || decision.inputTokens < 0)) throw new InputError('Invalid routing usage.');
  }
}

export function validateModels(input: unknown): asserts input is ModelConfig[] {
  if (!Array.isArray(input) || input.length > 100) throw new InputError('Models must be a list of at most 100 entries.');
  const seen = new Set<string>();
  for (const model of input) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new InputError('Each model must be an object.');
    if (Object.keys(model).some(field => !modelFields.has(field))) throw new InputError('Models contain an unsupported field. Store only model settings and an API key environment variable name, never a raw API key.');
    id(model.id, 'Model ID');
    if (seen.has(model.id)) throw new InputError(`Duplicate model ID: ${model.id}.`);
    seen.add(model.id);
    text(model.name, 'Model name', 200, false);
    text(model.modelId, 'Provider model ID', 300, false);
    text(model.baseUrl, 'Model base URL', 2000);
    text(model.apiKeyEnv, 'API key environment variable', 200);
    if (!['anthropic', 'openai', 'ollama', 'custom'].includes(model.provider)) throw new InputError('Unsupported model provider.');
    if (['ollama', 'custom'].includes(model.provider) && !model.baseUrl.trim()) throw new InputError('Ollama and compatible models require an explicit endpoint base URL.');
    if (!['local', 'cloud'].includes(model.kind) || typeof model.enabled !== 'boolean') throw new InputError('Invalid model kind or enabled flag.');
    if (model.supportsImages !== undefined && typeof model.supportsImages !== 'boolean') throw new InputError('Image support must be a boolean.');
    if (model.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) throw new InputError('API key must be an environment variable name, never the key itself.');
    if (model.baseUrl) {
      let url: URL;
      try { url = new URL(model.baseUrl); } catch { throw new InputError('Model base URL must be an absolute HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InputError('Model URLs must use HTTP(S), without credentials, query strings, or fragments.');
    }
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 10_000_000)) throw new InputError('Context window must be between 1,024 and 10,000,000 tokens.');
    if (model.maxOutputTokens !== undefined && (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 256 || model.maxOutputTokens > Math.min(32768, (model.contextWindow ?? 32768) - 256))) throw new InputError('Maximum output must be 256–32,768 tokens and leave at least 256 tokens within the context window.');
    if (model.timeoutSeconds !== undefined && (!Number.isInteger(model.timeoutSeconds) || model.timeoutSeconds < 15 || model.timeoutSeconds > 1800)) throw new InputError('Model timeout must be a whole number from 15 to 1,800 seconds.');
    if (model.maxConcurrentRequests !== undefined && (!Number.isInteger(model.maxConcurrentRequests) || model.maxConcurrentRequests < 1 || model.maxConcurrentRequests > 8)) throw new InputError('Endpoint request slots must be a whole number from 1 to 8.');
    if (model.reasoningEffort !== undefined && !['off', 'low', 'medium', 'high'].includes(model.reasoningEffort)) throw new InputError('Reasoning effort must be off, low, medium, or high.');
    if (model.authMethod !== undefined && (model.provider !== 'openai' || !['apiKey', 'chatgpt'].includes(model.authMethod))) throw new InputError('Authentication method is available only for OpenAI models.');
    if (model.chatgptProfileId !== undefined) {
      id(model.chatgptProfileId, 'ChatGPT profile ID');
      if (model.authMethod !== 'chatgpt') throw new InputError('A ChatGPT profile requires ChatGPT authentication.');
    }
    if (model.authMethod === 'chatgpt' && model.baseUrl && model.baseUrl.replace(/\/+$/, '') !== 'https://api.openai.com/v1') throw new InputError('ChatGPT authentication uses the official OpenAI endpoint. Leave the base URL blank.');
    if (model.authMethod === 'chatgpt' && model.kind !== 'cloud') throw new InputError('ChatGPT plan models run in the cloud.');
  }
}

export function traversalOrder(workflow: Workflow): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (edge.data?.loop === true) continue;
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
    if (data.judgeRubric !== undefined) text(data.judgeRubric, 'Judge rubric');
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
    if (edge.data !== undefined && (!edge.data || typeof edge.data !== 'object' || Array.isArray(edge.data)
      || (edge.data.loop !== undefined && typeof edge.data.loop !== 'boolean'))) throw new InputError(`Connection ${edge.id} must use a boolean loop flag.`);
  }
  const settings = workflow.settings;
  if (!settings || !['loop', 'once'].includes(settings.mode) || !['demo', 'pi'].includes(settings.executionMode)) throw new InputError('Invalid workflow execution settings.');
  if (settings.continuous !== undefined && typeof settings.continuous !== 'boolean') throw new InputError('Continuous crawling must be a boolean.');
  if (settings.codeMode !== undefined && typeof settings.codeMode !== 'boolean') throw new InputError('Code Mode must be a boolean.');
  if (settings.routing !== undefined) validateRoutingSettings(settings.routing);
  if (settings.maxParallelAgents !== undefined && (!Number.isInteger(settings.maxParallelAgents) || settings.maxParallelAgents < 1 || settings.maxParallelAgents > 8)) throw new InputError('Maximum parallel agents must be a whole number from 1 to 8.');
  if (settings.supervisorModelId !== undefined) {
    id(settings.supervisorModelId, 'Supervisor model ID');
    if (!models.some(model => model.id === settings.supervisorModelId && model.enabled)) throw new InputError('The supervisor needs an enabled model. Choose one in workflow settings.');
  }
  if (settings.maxEscalationsPerCycle !== undefined && (!Number.isInteger(settings.maxEscalationsPerCycle) || settings.maxEscalationsPerCycle < 1 || settings.maxEscalationsPerCycle > 10)) throw new InputError('Maximum supervisor visits per cycle must be a whole number from 1 to 10.');
  if (settings.maxEscalationsPerRun !== undefined && (!Number.isInteger(settings.maxEscalationsPerRun) || settings.maxEscalationsPerRun < 1 || settings.maxEscalationsPerRun > 100)) throw new InputError('Maximum supervisor visits per run must be a whole number from 1 to 100.');
  if (settings.maxParallel !== undefined && (!Number.isInteger(settings.maxParallel) || settings.maxParallel < 1 || settings.maxParallel > 8)) throw new InputError('Parallel agents must be an integer from 1 to 8.');
  if (!Number.isInteger(settings.maxCycles) || settings.maxCycles < 1 || settings.maxCycles > 1000) throw new InputError('Maximum cycles must be an integer from 1 to 1,000.');
  if (!Number.isFinite(settings.intervalSeconds) || settings.intervalSeconds < 0 || settings.intervalSeconds > 86400) throw new InputError('Cycle interval must be from 0 to 86,400 seconds.');
  if (!ids.has(settings.entryNodeId)) throw new InputError('Choose an entry agent that exists in the workflow.');
  text(settings.projectPath, 'Project path', 4000);
  text(settings.previewUrl, 'Preview URL', 2000);
  const reachable = new Set(traversalOrder(workflow));
  const disconnected = workflow.nodes.filter(node => !reachable.has(node.id));
  if (disconnected.length) throw new InputError(`Connect all agents to the entry agent. Unreachable: ${disconnected.map(node => node.data.label).join(', ')}.`);
  for (const judge of workflow.nodes.filter(node => node.data.role === 'judge')) {
    const normalEdges = workflow.edges.filter(edge => edge.data?.loop !== true && edge.target !== settings.entryNodeId);
    const parents = new Set(normalEdges.filter(edge => edge.target === judge.id).map(edge => edge.source));
    if (parents.size < 2) throw new InputError(`${judge.data.label} needs at least two distinct candidate agents connected as direct predecessors.`);
    const descendants = new Set<string>([judge.id]);
    const queue = [judge.id];
    for (let index = 0; index < queue.length; index++) for (const edge of normalEdges.filter(edge => edge.source === queue[index])) {
      if (!descendants.has(edge.target)) { descendants.add(edge.target); queue.push(edge.target); }
    }
    if ([...parents].some(parent => descendants.has(parent))) throw new InputError(`${judge.data.label}'s candidates must finish before judging. Mark cycle-return connections as Next cycle.`);
  }
}

export function localPreviewUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError('Screenshot agents need a valid local preview URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new InputError('Preview URL must use HTTP(S) on localhost, 127.0.0.1, or [::1], without credentials.');
  }
  return url;
}
