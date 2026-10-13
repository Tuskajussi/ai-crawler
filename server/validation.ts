import type { ModelConfig, Workflow, RoutingSettings, RoutingDecision, CheckSettings, GateSettings, CheckOutcome, GateOutcome, UnitOutcome, GateApproval, ProjectSettings, TestExecution, ProjectChange } from '../shared/types';

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
const roles = new Set(['crawler', 'tester', 'designer', 'reviewer', 'coordinator', 'judge', 'custom']);
const modelFields = new Set(['id', 'name', 'provider', 'modelId', 'kind', 'baseUrl', 'apiKeyEnv', 'enabled', 'contextWindow', 'supportsImages', 'maxOutputTokens', 'timeoutSeconds', 'reasoningEffort', 'authMethod', 'chatgptProfileId', 'maxConcurrentRequests']);
const severities = ['critical', 'high', 'medium', 'low'];

function object(value: unknown, label: string, fields?: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${label} must be an object.`);
  if (fields && Object.keys(value).some(field => !fields.includes(field))) throw new InputError(`${label} contains an unsupported field.`);
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new InputError(`${label} must be a whole number from 1 to ${maximum}.`);
}

function savedDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value))) throw new InputError(`${label} must be a valid date.`);
}

function reasons(value: unknown, passed: boolean): void {
  if (!Array.isArray(value) || value.length > 30 || (passed ? value.length !== 0 : value.length < 1)) throw new InputError('Acceptance reasons must be empty for accepted work, or contain 1–30 reasons for rejected work.');
  value.forEach(reason => text(reason, 'Acceptance reason', 1000, false));
}

export function validateCheckSettings(input: unknown): asserts input is CheckSettings {
  object(input, 'Check settings', ['requireOutput', 'requireFindingEvidence', 'requireJudgment', 'requireTests', 'blockedSeverities']);
  for (const field of ['requireOutput', 'requireFindingEvidence', 'requireJudgment']) if (typeof input[field] !== 'boolean') throw new InputError(`${field} must be a boolean in check settings.`);
  if (input.requireTests !== undefined && typeof input.requireTests !== 'boolean') throw new InputError('requireTests must be a boolean in check settings.');
  if (!Array.isArray(input.blockedSeverities) || input.blockedSeverities.length > 4 || new Set(input.blockedSeverities).size !== input.blockedSeverities.length
    || input.blockedSeverities.some(severity => !severities.includes(severity))) throw new InputError('Blocked severities must be a unique list of critical, high, medium, or low.');
  if (!input.requireOutput && !input.requireFindingEvidence && !input.requireJudgment && !input.requireTests && !input.blockedSeverities.length) throw new InputError('Enable at least one acceptance criterion in the check.');
}

export function validateProjectSettings(input: unknown): asserts input is ProjectSettings {
  object(input, 'Project settings', ['path', 'previewUrl', 'allowEdits', 'allowTests', 'testCommands']);
  text(input.path, 'Project path', 4000, false);
  text(input.previewUrl, 'Preview URL', 2000);
  if (input.path.includes('\0')) throw new InputError('Project path cannot contain a null character.');
  if (input.previewUrl) localPreviewUrl(input.previewUrl);
  if (typeof input.allowEdits !== 'boolean' || typeof input.allowTests !== 'boolean') throw new InputError('Project editing and test permissions must be booleans.');
  if (!Array.isArray(input.testCommands) || input.testCommands.length > 20) throw new InputError('A project can have at most 20 approved test commands.');
  const commands = new Set<string>();
  for (const command of input.testCommands) {
    object(command, 'Project test command', ['id', 'name', 'command', 'timeoutSeconds']);
    id(command.id, 'Test command ID');
    if (commands.has(command.id)) throw new InputError(`Duplicate test command ID: ${command.id}.`);
    commands.add(command.id);
    text(command.name, 'Test command name', 100, false);
    text(command.command, 'Test command', 2000, false);
    if (command.command.includes('\0')) throw new InputError('Test commands cannot contain a null character.');
    positiveInteger(command.timeoutSeconds, 'Test command timeout', 600);
  }
}

export function validateTestExecutions(input: unknown): asserts input is TestExecution[] {
  if (!Array.isArray(input) || input.length > 20) throw new InputError('A node can retain at most 20 test executions.');
  for (const execution of input) {
    object(execution, 'Saved test execution', ['commandId', 'name', 'exitCode', 'passed', 'timedOut', 'durationMs', 'output', 'projectRevision']);
    id(execution.commandId, 'Executed test command ID');
    text(execution.name, 'Executed test command name', 100, false);
    if (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) throw new InputError('Saved test exit code must be a whole number or null.');
    if (typeof execution.passed !== 'boolean' || typeof execution.timedOut !== 'boolean'
      || execution.passed !== (execution.exitCode === 0 && !execution.timedOut)) throw new InputError('Saved test verdict must match its exit code and timeout status.');
    if (!Number.isFinite(execution.durationMs) || (execution.durationMs as number) < 0) throw new InputError('Saved test duration must be a finite nonnegative number.');
    text(execution.output, 'Saved test output', 16_000);
    if (execution.projectRevision !== undefined) validateProjectRevision(execution.projectRevision);
  }
}

export function validateProjectRevision(input: unknown): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw new InputError('Saved project revision must be a nonnegative safe integer.');
}

export function validateProjectChanges(input: unknown): asserts input is ProjectChange[] {
  if (!Array.isArray(input) || input.length > 100) throw new InputError('A node can retain at most 100 project changes.');
  for (const change of input) {
    object(change, 'Saved project change', ['path', 'action']);
    text(change.path, 'Changed file path', 4000, false);
    if (!['created', 'edited'].includes(change.action as string)) throw new InputError('Saved project change must be created or edited.');
  }
}

export function validateRequiredTestIds(input: unknown): asserts input is string[] {
  if (!Array.isArray(input) || input.length > 20 || new Set(input).size !== input.length) throw new InputError('Saved required test commands must contain at most 20 distinct command IDs.');
  input.forEach(commandId => id(commandId, 'Required test command ID'));
}

export function validateGateSettings(input: unknown): asserts input is GateSettings {
  object(input, 'Gate settings', ['maxCorrections', 'approval', 'risk']);
  if (!Number.isInteger(input.maxCorrections) || (input.maxCorrections as number) < 0 || (input.maxCorrections as number) > 3) throw new InputError('Gate corrections must be a whole number from 0 to 3.');
  if (!['automatic', 'human'].includes(input.approval as string) || !['contained', 'wide', 'high-impact'].includes(input.risk as string)) throw new InputError('Choose a supported gate approval policy and risk level.');
  if (input.risk === 'high-impact' && input.approval !== 'human') throw new InputError('High-impact gates require human approval. Change the gate approval policy to Human.');
}

export function validateCheckOutcome(input: unknown): asserts input is CheckOutcome {
  object(input, 'Saved check outcome', ['passed', 'units']);
  if (typeof input.passed !== 'boolean' || !Array.isArray(input.units) || input.units.length > 100) throw new InputError('Saved check outcome needs a boolean verdict and at most 100 units.');
  const seen = new Set<string>();
  for (const unit of input.units) {
    object(unit, 'Saved check unit', ['nodeId', 'passed', 'retryable', 'reasons']);
    id(unit.nodeId, 'Checked agent ID');
    if (seen.has(unit.nodeId)) throw new InputError('A saved check must evaluate each agent once.');
    seen.add(unit.nodeId);
    if (typeof unit.passed !== 'boolean' || typeof unit.retryable !== 'boolean' || (unit.passed && unit.retryable)) throw new InputError('Saved check unit has an invalid verdict or correction policy.');
    reasons(unit.reasons, unit.passed);
  }
  if (input.passed !== (input.units.length > 0 && input.units.every(unit => unit.passed))) throw new InputError('Saved check verdict must match all of its units; empty checks must fail.');
}

export function validateGateOutcome(input: unknown): asserts input is GateOutcome {
  object(input, 'Saved gate outcome', ['verdict', 'checkNodeIds', 'corrections', 'risk', 'approvedByHuman']);
  if (!['accepted', 'rejected'].includes(input.verdict as string) || !['contained', 'wide', 'high-impact'].includes(input.risk as string)) throw new InputError('Saved gate has an invalid verdict or risk level.');
  if (!Array.isArray(input.checkNodeIds) || input.checkNodeIds.length < 1 || input.checkNodeIds.length > 100 || new Set(input.checkNodeIds).size !== input.checkNodeIds.length) throw new InputError('Saved gate needs 1–100 distinct check IDs.');
  input.checkNodeIds.forEach(nodeId => id(nodeId, 'Gate check ID'));
  if (!Number.isInteger(input.corrections) || (input.corrections as number) < 0 || (input.corrections as number) > 3) throw new InputError('Saved gate corrections must be from 0 to 3.');
  if (input.approvedByHuman !== undefined && typeof input.approvedByHuman !== 'boolean') throw new InputError('Saved human approval must be a boolean.');
  if (input.risk === 'high-impact' && input.verdict === 'accepted' && input.approvedByHuman !== true) throw new InputError('An accepted high-impact gate requires recorded human approval.');
}

export function validateUnitOutcomes(input: unknown): asserts input is UnitOutcome[] {
  if (!Array.isArray(input) || input.length > 500) throw new InputError('A run can retain at most 500 acceptance outcomes.');
  const seen = new Set<string>();
  for (const outcome of input) {
    object(outcome, 'Saved acceptance outcome', ['id', 'nodeId', 'gateNodeId', 'cycle', 'attempt', 'verdict', 'reasons', 'modelId', 'createdAt']);
    id(outcome.id, 'Acceptance outcome ID'); id(outcome.nodeId, 'Acceptance agent ID'); id(outcome.gateNodeId, 'Acceptance gate ID');
    if (seen.has(outcome.id)) throw new InputError('Duplicate saved acceptance outcome ID.');
    seen.add(outcome.id);
    positiveInteger(outcome.cycle, 'Acceptance cycle'); positiveInteger(outcome.attempt, 'Acceptance attempt', 4);
    if (!['accepted', 'rejected'].includes(outcome.verdict as string)) throw new InputError('Saved acceptance outcome has an invalid verdict.');
    reasons(outcome.reasons, outcome.verdict === 'accepted');
    text(outcome.modelId, 'Acceptance model ID', 300, false); savedDate(outcome.createdAt, 'Acceptance date');
  }
}

export function validateGateApproval(input: unknown): asserts input is GateApproval {
  object(input, 'Saved gate approval', ['gateNodeId', 'cycle', 'status', 'requestedAt', 'resolvedAt', 'results']);
  id(input.gateNodeId, 'Approval gate ID'); positiveInteger(input.cycle, 'Approval cycle');
  if (!['pending', 'approved', 'rejected'].includes(input.status as string)) throw new InputError('Saved gate approval has an invalid status.');
  savedDate(input.requestedAt, 'Approval request date');
  if (input.status === 'pending') {
    if (input.resolvedAt !== undefined) throw new InputError('A pending gate approval cannot have a resolution date.');
  } else {
    savedDate(input.resolvedAt, 'Approval resolution date');
    if (Date.parse(input.resolvedAt) < Date.parse(input.requestedAt)) throw new InputError('Gate approval cannot resolve before it was requested.');
  }
}

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
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length < 1 || workflow.nodes.length > 100) throw new InputError('A workflow needs 1–100 nodes.');
  if (!Array.isArray(workflow.edges) || workflow.edges.length > 1000) throw new InputError('Workflow edges must be a list of at most 1,000 connections.');
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new InputError('Each workflow node must be an object.');
    id(node.id, 'Node ID');
    if (ids.has(node.id)) throw new InputError(`Duplicate node ID: ${node.id}.`);
    ids.add(node.id);
    if (!['agent', 'check', 'gate'].includes(node.type) || !node.data || typeof node.data !== 'object' || Array.isArray(node.data)
      || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new InputError(`Invalid workflow node: ${node.id}.`);
    const data = node.data;
    text(data.label, 'Node name', 200, false);
    text(data.color, 'Node color', 50, false);
    if (node.type === 'check') { validateCheckSettings(data.check); continue; }
    if (node.type === 'gate') { validateGateSettings(data.gate); continue; }
    text(data.description, 'Agent description', 5000);
    text(data.persona, 'Agent persona');
    text(data.prompt, 'Agent prompt');
    if (data.judgeRubric !== undefined) text(data.judgeRubric, 'Judge rubric');
    if (!roles.has(data.role)) throw new InputError(`Unsupported role on ${data.label}.`);
    if (!Array.isArray(data.tools) || data.tools.some(tool => !['read', 'screenshot', 'edit', 'test'].includes(tool))) throw new InputError(`Invalid tools on ${data.label}.`);
    if (data.tools.includes('edit') && !data.tools.includes('read')) throw new InputError(`${data.label} needs project reading enabled before it can edit code.`);
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
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new InputError(`Connection ${edge.id} points to a missing agent or control node.`);
    if (edge.label !== undefined) text(edge.label, 'Connection label', 200);
    if (edge.data !== undefined && (!edge.data || typeof edge.data !== 'object' || Array.isArray(edge.data)
      || (edge.data.loop !== undefined && typeof edge.data.loop !== 'boolean'))) throw new InputError(`Connection ${edge.id} must use a boolean loop flag.`);
  }
  const settings = workflow.settings;
  if (!settings || !['loop', 'once'].includes(settings.mode) || !['demo', 'pi'].includes(settings.executionMode)) throw new InputError('Invalid workflow execution settings.');
  if (settings.continuous !== undefined && typeof settings.continuous !== 'boolean') throw new InputError('Continuous crawling must be a boolean.');
  if (settings.codeMode !== undefined && typeof settings.codeMode !== 'boolean') throw new InputError('Code Mode must be a boolean.');
  if (settings.routing !== undefined) validateRoutingSettings(settings.routing);
  if (settings.lessons !== undefined) {
    if (!Array.isArray(settings.lessons) || settings.lessons.length > 100) throw new InputError('Workflow lessons must be a list of at most 100 entries.');
    const lessons = new Set<string>();
    for (const lesson of settings.lessons) {
      object(lesson, 'Workflow lesson', ['id', 'text', 'nodeIds', 'enabled']);
      id(lesson.id, 'Lesson ID');
      if (lessons.has(lesson.id)) throw new InputError(`Duplicate lesson ID: ${lesson.id}.`);
      lessons.add(lesson.id);
      text(lesson.text, 'Lesson text', 2000, false);
      if (typeof lesson.enabled !== 'boolean') throw new InputError('A lesson enabled flag must be a boolean.');
      if (!Array.isArray(lesson.nodeIds) || lesson.nodeIds.length > 100 || new Set(lesson.nodeIds).size !== lesson.nodeIds.length) throw new InputError('Lesson scope must contain at most 100 distinct agent IDs, or be empty for all agents.');
      for (const nodeId of lesson.nodeIds) if (!workflow.nodes.some(node => node.id === nodeId && node.type === 'agent')) throw new InputError('A lesson can refer only to existing agents. Update its scope after removing an agent.');
    }
  }
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
  if (!workflow.nodes.some(node => node.id === settings.entryNodeId && node.type === 'agent')) throw new InputError('Choose an entry agent that exists in the workflow. Checks and gates cannot be entry nodes.');
  text(settings.projectPath, 'Project path', 4000);
  text(settings.previewUrl, 'Preview URL', 2000);
  const reachable = new Set(traversalOrder(workflow));
  const disconnected = workflow.nodes.filter(node => !reachable.has(node.id));
  if (disconnected.length) throw new InputError(`Connect all nodes to the entry agent. Unreachable: ${disconnected.map(node => node.data.label).join(', ')}.`);
  if (workflow.nodes.some(node => node.type !== 'agent')) validateAcceptanceGraph(workflow);
  for (const judge of workflow.nodes.filter(node => node.type === 'agent' && node.data.role === 'judge')) {
    const normalEdges = workflow.edges.filter(edge => edge.data?.loop !== true && edge.target !== settings.entryNodeId);
    const parents = new Set(normalEdges.filter(edge => edge.target === judge.id).map(edge => edge.source));
    if (parents.size < 2 || [...parents].some(parent => !workflow.nodes.some(node => node.id === parent && node.type === 'agent'))) throw new InputError(`${judge.data.label} needs at least two distinct candidate agents connected as direct predecessors.`);
    const descendants = new Set<string>([judge.id]);
    const queue = [judge.id];
    for (let index = 0; index < queue.length; index++) for (const edge of normalEdges.filter(edge => edge.source === queue[index])) {
      if (!descendants.has(edge.target)) { descendants.add(edge.target); queue.push(edge.target); }
    }
    if ([...parents].some(parent => descendants.has(parent))) throw new InputError(`${judge.data.label}'s candidates must finish before judging. Mark cycle-return connections as Next cycle.`);
  }
}

function validateAcceptanceGraph(workflow: Workflow): void {
  const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
  const edges = workflow.edges.filter(edge => edge.data?.loop !== true);
  const parents = (nodeId: string) => [...new Set(edges.filter(edge => edge.target === nodeId).map(edge => edge.source))];
  const children = (nodeId: string) => [...new Set(edges.filter(edge => edge.source === nodeId).map(edge => edge.target))];
  const checks = workflow.nodes.filter(node => node.type === 'check');
  const gates = workflow.nodes.filter(node => node.type === 'gate');
  if (gates.filter(gate => gate.data.gate!.approval === 'human').length > 1) throw new InputError('Use at most one human approval gate per workflow. Combine the final checks into one approval gate.');
  for (const check of checks) {
    const predecessors = parents(check.id);
    if (!predecessors.length || predecessors.some(nodeId => nodes.get(nodeId)?.type !== 'agent')) throw new InputError(`${check.data.label} needs one or more direct agent predecessors. Connect agent reports to the check with normal connections.`);
    if (check.data.check!.requireJudgment && predecessors.some(nodeId => nodes.get(nodeId)?.data.role !== 'judge')) throw new InputError(`${check.data.label} requires a judgment, so all direct predecessors must be judge agents. Connect a judge or disable the judgment criterion.`);
    if (check.data.check!.requireTests && predecessors.some(nodeId => !nodes.get(nodeId)?.data.tools.includes('test'))) throw new InputError(`${check.data.label} requires test execution, so all direct predecessors must have test tools enabled.`);
    const successors = children(check.id);
    if (successors.length !== 1 || nodes.get(successors[0])?.type !== 'gate') throw new InputError(`${check.data.label} must connect to exactly one gate, so corrections cannot invalidate another branch.`);
  }
  for (const gate of gates) {
    const predecessors = parents(gate.id);
    if (!predecessors.length || predecessors.some(nodeId => nodes.get(nodeId)?.type !== 'check')) throw new InputError(`${gate.data.label} needs one or more direct check predecessors. Connect checks to the gate with normal connections.`);
    const ownedChecks = new Set(predecessors);
    const agents = new Set(predecessors.flatMap(checkId => parents(checkId)));
    for (const agentId of agents) if (children(agentId).some(nodeId => !ownedChecks.has(nodeId))) throw new InputError(`${nodes.get(agentId)!.data.label} is checked by ${gate.data.label} and must send its result only to checks owned by that gate. Move dependent work after the gate so correction cannot leave stale results.`);
  }
  const incoming = new Map(workflow.nodes.map(node => [node.id, 0]));
  for (const edge of edges) incoming.set(edge.target, incoming.get(edge.target)! + 1);
  const queue = workflow.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (let index = 0; index < queue.length; index++) for (const edge of edges.filter(edge => edge.source === queue[index])) {
    const count = incoming.get(edge.target)! - 1;
    incoming.set(edge.target, count);
    if (count === 0) queue.push(edge.target);
  }
  if (queue.length !== workflow.nodes.length) throw new InputError('Workflows with checks or gates must have no same-cycle cycles. Mark return connections as Next cycle.');
}

export function localPreviewUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError('Screenshot agents need a valid local preview URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new InputError('Preview URL must use HTTP(S) on localhost, 127.0.0.1, or [::1], without credentials.');
  }
  return url;
}
