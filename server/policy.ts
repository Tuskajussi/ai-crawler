import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { ModelConfig, Workflow } from '../shared/types';
import type { ServerConfig } from './config';
import { InputError, localPreviewUrl } from './validation';

export function validateModelAccess(models: ModelConfig[], config: ServerConfig): void {
  for (const model of models.filter(item => item.enabled)) {
    if (model.apiKeyEnv && (/^CRAWLSPACE_/i.test(model.apiKeyEnv) || !config.modelKeyNames.includes(model.apiKeyEnv))) throw new InputError(`The host has not enabled credential ${model.apiKeyEnv}. Choose an allowed model key.`);
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

export async function validateRunAccess(workflow: Workflow, models: ModelConfig[], projectsRoot: string, config: ServerConfig): Promise<string> {
  validateModelAccess(models.filter(model => workflow.nodes.some(node => node.data.modelId === model.id)), config);
  const project = await confineProject(workflow.settings.projectPath, projectsRoot);
  if (workflow.nodes.some(node => node.data.tools.includes('screenshot'))) {
    const preview = localPreviewUrl(workflow.settings.previewUrl);
    if (config.hosted && !config.previewOrigins.includes(preview.origin)) throw new InputError('The host has not enabled this screenshot preview origin. Ask the operator to add it.');
  }
  return project;
}