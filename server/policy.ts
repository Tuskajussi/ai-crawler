import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { ModelConfig, RoutingSettings, Workflow, ProjectSettings } from '../shared/types';
import type { EmbeddingConfig } from '../shared/knowledge';
import type { ServerConfig } from './config';
import { InputError, localPreviewUrl, validateProjectSettings } from './validation';

function credentialAccess(name: string, config: ServerConfig): void {
  if (name && (/^CRAWLSPACE_/i.test(name) || !config.modelKeyNames.includes(name))) throw new InputError(`The host has not enabled credential ${name}. Choose an allowed model key.`);
}
function endpointAccess(origin: string, config: ServerConfig): void {
  if (!config.modelEndpointOrigins.includes(origin)) throw new InputError(`The host has not enabled model endpoint ${origin}. Ask the operator to add its origin.`);
}
export function validateRoutingAccess(routing: RoutingSettings | undefined, config: ServerConfig): void {
  if (!routing || routing.mode === 'off') return;
  credentialAccess(routing.apiKeyEnv, config); endpointAccess(new URL(routing.baseUrl).origin, config);
}
export function validateEmbeddingAccess(embedding: EmbeddingConfig, config: ServerConfig): void {
  credentialAccess(embedding.apiKeyEnv, config);
  const origin = embedding.provider === 'gemini' ? 'https://generativelanguage.googleapis.com'
    : embedding.provider === 'vertex' ? `https://${embedding.location === 'global' ? 'aiplatform.googleapis.com' : `aiplatform.${embedding.location}.rep.googleapis.com`}`
    : new URL(embedding.baseUrl).origin;
  // Approving a Vertex origin also approves use of the operator's ADC identity.
  endpointAccess(origin, config);
}

export function validateModelAccess(models: ModelConfig[], config: ServerConfig): void {
  for (const model of models.filter(item => item.enabled)) {
    credentialAccess(model.apiKeyEnv, config);
    const defaultUrl = model.provider === 'anthropic' ? 'https://api.anthropic.com' : model.provider === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11434/v1';
    const url = new URL(model.baseUrl || defaultUrl);
    const builtIn = (model.provider === 'anthropic' && url.origin === 'https://api.anthropic.com') || (model.provider === 'openai' && url.origin === 'https://api.openai.com');
    if (!builtIn && !config.modelEndpointOrigins.includes(url.origin)) throw new InputError(`The host has not enabled model endpoint ${url.origin}. Ask the operator to add its origin.`);
  }
}

export async function confineProject(projectPath: string, projectsRoot: string): Promise<string> {
  if (!projectPath || !path.isAbsolute(projectPath)) throw new InputError(`Choose an absolute project path inside ${projectsRoot}.`);
  let canonicalRoot: string, canonicalProject: string;
  try { canonicalRoot = await realpath(projectsRoot); canonicalProject = await realpath(projectPath); }
  catch { throw new InputError(`The project folder must exist inside ${projectsRoot}.`); }
  const relative = path.relative(canonicalRoot, canonicalProject);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new InputError(`Projects must stay inside your private projects folder: ${projectsRoot}.`);
  if (!(await stat(canonicalProject)).isDirectory()) throw new InputError('The project path must be a folder.');
  return canonicalProject;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function reservedProjectPath(projectPath: string): boolean {
  return projectPath.split(/[\\/]+/).some(component => ['.git', 'node_modules', '.crawlspace'].includes(component.toLowerCase()));
}

/** Explicit local project selection can use the owner's folders. Hosted accounts remain confined. */
export async function validateProjectAccess(project: ProjectSettings, projectsRoot: string, config: ServerConfig): Promise<string> {
  validateProjectSettings(project);
  if (config.hosted) {
    if (project.allowEdits || project.allowTests) throw new InputError('Code editing and test execution are available only in a local copy. Hosted projects are read-only.');
    return confineProject(project.path, projectsRoot);
  }
  if (!path.isAbsolute(project.path)) throw new InputError('Choose an absolute project folder path.');
  if (path.resolve(project.path) === path.parse(path.resolve(project.path)).root) throw new InputError('Choose a project folder inside the drive or filesystem root.');
  if (reservedProjectPath(project.path)) throw new InputError('Choose a project folder outside .git, node_modules, and .crawlspace.');
  let canonicalProject: string;
  try {
    canonicalProject = await realpath(project.path);
    if (!(await stat(canonicalProject)).isDirectory()) throw new InputError('The project path must be a folder.');
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('The project folder must exist on this machine.');
  }
  if (reservedProjectPath(canonicalProject)) throw new InputError('Choose a project folder outside .git, node_modules, and .crawlspace.');
  if (canonicalProject === path.parse(canonicalProject).root) throw new InputError('Choose a project folder inside the drive or filesystem root.');
  const canonicalData = await realpath(config.dataDir).catch(() => path.resolve(config.dataDir));
  if (contains(canonicalData, canonicalProject)) throw new InputError('Choose a project folder outside Crawlspace account and configuration data.');
  return canonicalProject;
}

export async function validateRunAccess(workflow: Workflow, models: ModelConfig[], projectsRoot: string, config: ServerConfig, projectSettings?: ProjectSettings): Promise<string> {
  validateModelAccess(models.filter(model => workflow.nodes.some(node => node.type === 'agent' && node.data.modelId === model.id) || model.id === workflow.settings.supervisorModelId), config);
  validateRoutingAccess(workflow.settings.routing, config);
  const project = projectSettings ? await validateProjectAccess(projectSettings, projectsRoot, config) : await confineProject(workflow.settings.projectPath, projectsRoot);
  const editAgents = workflow.nodes.some(node => node.type === 'agent' && node.data.tools.includes('edit'));
  const testAgents = workflow.nodes.some(node => node.type === 'agent' && node.data.tools.includes('test'));
  if (config.hosted && (editAgents || testAgents)) throw new InputError('Code editing and test execution are available only in a local copy. Hosted projects are read-only.');
  if (editAgents && !projectSettings?.allowEdits) throw new InputError('Enable code editing in Project settings before running agents with editing tools.');
  if (testAgents && !projectSettings?.allowTests) throw new InputError('Enable test execution in Project settings before running agents with test tools.');
  if (testAgents && !projectSettings?.testCommands.length) throw new InputError('Add an approved test command in Project settings before running test agents.');
  if (workflow.nodes.some(node => node.type === 'agent' && node.data.tools.includes('screenshot'))) {
    const preview = localPreviewUrl(projectSettings ? projectSettings.previewUrl : workflow.settings.previewUrl);
    if (config.hosted && !config.previewOrigins.includes(preview.origin)) throw new InputError('The host has not enabled this screenshot preview origin. Ask the operator to add it.');
  }
  return project;
}
