import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import type { AppState } from '../shared/types';

/** A single writer prevents overlapping requests from replacing newer state. */
export class StateStore {
  private state: AppState;
  private writes: Promise<void> = Promise.resolve();
  readonly filePath: string;

  private constructor(filePath: string, state: AppState) {
    this.filePath = filePath;
    this.state = state;
  }

  static async open(filePath = path.resolve('.crawlspace/state.json')): Promise<StateStore> {
    let state = structuredClone(initialState);
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('workflow' in parsed)
        || !Array.isArray((parsed as AppState).models)
        || !Array.isArray((parsed as AppState).findings)
        || !Array.isArray((parsed as AppState).messages)
        || !Array.isArray((parsed as AppState).runs)) {
        throw new Error('Saved state has an unsupported format. Back up or repair .crawlspace/state.json.');
      }
      state = parsed as AppState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A process restart cannot resume an in-flight model request safely.
    for (const run of state.runs) {
      if (run.status === 'running') {
        run.status = 'stopped';
        run.finishedAt = new Date().toISOString();
        run.error = 'The server restarted. Start a new run to continue.';
        delete run.activeNodeId; delete run.activeNodeIds;
      }
    }
    for (const node of state.workflow.nodes) node.data.status = 'idle';
    const store = new StateStore(filePath, state);
    await store.update(() => {});
    return store;
  }

  get(): AppState {
    return structuredClone(this.state);
  }

  async update(mutate: (state: AppState) => void): Promise<AppState> {
    // Clone first so a validation/mutation error cannot leave half an update.
    const next = structuredClone(this.state);
    mutate(next);
    this.state = next;
    const contents = JSON.stringify(next, null, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writes = write;
    await write;
    return this.get();
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
