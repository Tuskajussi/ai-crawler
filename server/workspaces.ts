import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ServerConfig } from './config';
import type { AuthStore } from './auth';
import type { AppState } from '../shared/types';
import { StateStore } from './store';
import { WorkflowEngine } from './engine';
import { createPiExecutor } from './pi';
import { ChatgptService, type ChatgptOptions } from './chatgpt';
import { KnowledgeService } from './knowledge';
import { ReliabilityStore } from './reliability';
import { createEmbeddingExecutor } from './embedding-provider';
import { createRoutingExecutor } from './routing';
import { pruneScreenshots } from './screenshots';
import { InputError } from './validation';
import { validateEmbeddingAccess, validateRoutingAccess, validateRunAccess } from './policy';
import { migrateLegacyWorkspace } from './workspace-migration';

export interface Workspace {
  store: StateStore; engine: WorkflowEngine; directory: string; projectsRoot: string;
  chatgpt: ChatgptService; knowledge: KnowledgeService; reliability: ReliabilityStore;
  probeControllers: Set<AbortController>; probeTasks: Set<Promise<unknown>>;
  shutdownKnowledge: () => Promise<void>;
}
export interface WorkspaceOptions {
  legacyStatePath?: string; demoStepMs?: number; chatgptOptions?: ChatgptOptions;
  knowledgeOptions?: Parameters<typeof KnowledgeService.open>[1];
}

export class Workspaces {
  private readonly opened = new Map<string, Promise<Workspace>>();
  private closing = false;
  private shutdownTask?: Promise<void>;
  constructor(private readonly config: ServerConfig, private readonly auth: AuthStore, private readonly options: WorkspaceOptions = {}) {}

  get(userId: string): Promise<Workspace> {
    if (this.closing) return Promise.reject(new InputError('Crawlspace is shutting down.', 503));
    if (!/^[a-f0-9-]{36}$/.test(userId)) return Promise.reject(new Error('Invalid workspace identity.'));
    let opening = this.opened.get(userId);
    if (!opening) {
      opening = this.open(userId); this.opened.set(userId, opening);
      void opening.catch(() => this.opened.delete(userId));
    }
    return opening;
  }

  private async open(userId: string): Promise<Workspace> {
    const directory = path.join(this.config.dataDir, 'users', userId);
    const projectsRoot = path.join(directory, 'projects');
    await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
    const statePath = path.join(directory, 'state.json');
    const legacy = this.options.legacyStatePath ?? path.join(this.config.dataDir, 'state.json');
    const credentialDirectory = this.options.chatgptOptions?.credentialDirectory ? path.join(this.options.chatgptOptions.credentialDirectory, userId) : undefined;
    // Construction is lazy: browsing an account does not initialize credentials or call a provider.
    const chatgpt = new ChatgptService(directory, { ...this.options.chatgptOptions, credentialDirectory });
    if (userId === this.auth.firstUserId) {
      const oldChatgpt = new ChatgptService(path.dirname(legacy), this.options.chatgptOptions);
      await migrateLegacyWorkspace({ statePath: legacy, directory, oldCredentialDirectory: oldChatgpt.credentialDirectory, credentialDirectory: chatgpt.credentialDirectory });
    }
    const store = await StateStore.open(statePath);
    const reliability = await ReliabilityStore.open(path.join(directory, 'reliability.json'));
    const embed = this.options.knowledgeOptions?.embed ?? createEmbeddingExecutor();
    const knowledge = await KnowledgeService.open(path.join(directory, 'knowledge'), { ...this.options.knowledgeOptions,
      embed: async (embedding, input, options) => { validateEmbeddingAccess(embedding, this.config); return embed(embedding, input, options); } });
    let pendingScreenshots: () => string[] = () => [];
    const retainedScreenshots = () => [...store.get().findings.flatMap(finding => finding.screenshot ? [finding.screenshot] : []), ...pendingScreenshots()];
    try { await pruneScreenshots(path.join(directory, 'screenshots'), retainedScreenshots()); }
    catch (error) { await knowledge.dispose(); throw error; }
    const pi = createPiExecutor(directory, { chatgpt, retainedScreenshots, reliability, previewOrigins: this.config.hosted ? this.config.previewOrigins : undefined });
    const route = createRoutingExecutor();
    const engine = new WorkflowEngine(store, { demoStepMs: this.options.demoStepMs, routingExecutor: async context => {
      validateRoutingAccess(context.workflow.settings.routing, this.config); return route(context);
    }, piExecutor: async context => {
      const project = await validateRunAccess(context.workflow, context.models, projectsRoot, this.config);
      context.workflow.settings.projectPath = project; return pi(context);
    } });
    pendingScreenshots = () => engine.pendingScreenshots;
    return { directory, projectsRoot, store, engine, chatgpt, knowledge, reliability,
      probeControllers: new Set(), probeTasks: new Set(), shutdownKnowledge: () => knowledge.dispose() };
  }

  state(workspace: Workspace): AppState {
    return { ...workspace.store.get(), workspace: { projectsRoot: workspace.projectsRoot, hosted: this.config.hosted,
      modelKeyNames: this.config.modelKeyNames, modelEndpointOrigins: this.config.modelEndpointOrigins, previewOrigins: this.config.previewOrigins } };
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.closing = true;
    this.shutdownTask = (async () => {
      const opened = await Promise.allSettled(this.opened.values());
      const outcomes = await Promise.allSettled(opened.filter(item => item.status === 'fulfilled').map(async item => {
        if (item.status !== 'fulfilled') return;
        const workspace = item.value, errors: unknown[] = [];
        for (const controller of workspace.probeControllers) controller.abort();
        const knowledgeDrain = workspace.shutdownKnowledge().catch(error => { errors.push(error); });
        for (const drain of [() => workspace.engine.stop(), () => workspace.engine.waitForIdle(), () => knowledgeDrain,
          () => Promise.allSettled([...workspace.probeTasks]), () => workspace.chatgpt.dispose(), () => workspace.store.flush(), () => workspace.reliability.flush()]) {
          try { await drain(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'An account could not save all shutdown state.');
      }));
      const failures = outcomes.filter(item => item.status === 'rejected').flatMap(item => item.reason instanceof AggregateError ? item.reason.errors : [item.reason]);
      if (failures.length) throw new AggregateError(failures, 'Crawlspace could not save all shutdown state.');
    })();
    return this.shutdownTask;
  }
}
