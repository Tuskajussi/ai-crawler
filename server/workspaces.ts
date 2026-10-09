import path from 'node:path';
import { copyFile, mkdir, readdir, lstat } from 'node:fs/promises';
import type { ServerConfig } from './config';
import type { AuthStore } from './auth';
import type { AppState } from '../shared/types';
import { StateStore } from './store';
import { WorkflowEngine } from './engine';
import { createPiExecutor } from './pi';
import { validateRunAccess } from './policy';

export interface Workspace { store: StateStore; engine: WorkflowEngine; directory: string; projectsRoot: string; }

export class Workspaces {
  private readonly opened = new Map<string, Promise<Workspace>>();
  constructor(private readonly config: ServerConfig, private readonly auth: AuthStore, private readonly options: {legacyStatePath?: string; demoStepMs?: number} = {}) {}

  get(userId: string): Promise<Workspace> {
    if (!/^[a-f0-9-]{36}$/.test(userId)) throw new Error('Invalid workspace identity.');
    let opening = this.opened.get(userId);
    if (!opening) {
      opening = this.open(userId);
      this.opened.set(userId, opening);
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
    if (userId === this.auth.firstUserId && path.resolve(legacy) !== path.resolve(statePath)) {
      try {
        // Existing local workspace belongs only to the first registered account.
        if (!(await lstat(legacy)).isFile()) throw new Error('Legacy state is not a regular file.');
        await copyFile(legacy, statePath, 1); // COPYFILE_EXCL: never overwrite account data.
        const screenshots = path.join(path.dirname(legacy), 'screenshots');
        await mkdir(path.join(directory, 'screenshots'), { recursive: true, mode: 0o700 });
        for (const file of await readdir(screenshots).catch(() => [])) {
          if (!/^[a-f0-9-]{36}\.png$/.test(file)) continue;
          const source = path.join(screenshots, file);
          if ((await lstat(source)).isFile()) await copyFile(source, path.join(directory, 'screenshots', file), 1).catch(error => { if (error.code !== 'EEXIST') throw error; });
        }
      } catch (error) { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    }
    const store = await StateStore.open(statePath);
    const pi = createPiExecutor(directory);
    const engine = new WorkflowEngine(store, { demoStepMs: this.options.demoStepMs, piExecutor: async context => {
      // Recheck at each node, including saved workflows and filesystem changes.
      const project = await validateRunAccess(context.workflow, context.models, projectsRoot, this.config);
      context.workflow.settings.projectPath = project;
      return pi(context);
    } });
    return { directory, projectsRoot, store, engine };
  }

  state(workspace: Workspace): AppState {
    return { ...workspace.store.get(), workspace: {projectsRoot: workspace.projectsRoot, hosted: this.config.hosted, modelKeyNames: this.config.modelKeyNames, modelEndpointOrigins: this.config.modelEndpointOrigins, previewOrigins: this.config.previewOrigins} };
  }

  async shutdown(): Promise<void> {
    const workspaces = await Promise.allSettled(this.opened.values());
    await Promise.all(workspaces.filter(item => item.status === 'fulfilled').map(async item => {
      if (item.status !== 'fulfilled') return;
      await item.value.engine.stop();
      await item.value.engine.waitForIdle();
      await item.value.store.flush();
    }));
  }
}