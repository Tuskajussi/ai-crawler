import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import type { AppState } from '../shared/types';
import { validateModels, validateWorkflow, validateRoutingDecisions } from './validation';

type StoreOptions = { beforeCommit?: (phase: 'backup' | 'primary') => void | Promise<void> };

function savedState(input: unknown): AppState {
  if (!input || typeof input !== 'object') throw new Error('Saved workspace must be an object.');
  const state = input as AppState;
  validateModels(state.models);
  validateWorkflow(state.workflow, state.models);
  const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (state.workflow.nodes.some(node => !['idle', 'running', 'done', 'error'].includes(node.data.status))) throw new Error('Saved workspace has an invalid agent status.');
  if (!Array.isArray(state.findings) || state.findings.length > 2000 || state.findings.some(finding => !finding
    || !text(finding.id, 100) || !text(finding.nodeId, 100) || !text(finding.title, 300) || !text(finding.description, 10_000)
    || !['critical', 'high', 'medium', 'low'].includes(finding.severity) || !['open', 'in_progress', 'resolved'].includes(finding.status)
    || !date(finding.createdAt) || (finding.file !== undefined && !text(finding.file, 4000))
    || (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1))
    || (finding.screenshot !== undefined && !text(finding.screenshot, 2000)) || (finding.demo !== undefined && typeof finding.demo !== 'boolean'))) throw new Error('Saved workspace has invalid findings.');
  if (!Array.isArray(state.messages) || state.messages.length > 2000 || state.messages.some(message => !message
    || !text(message.id, 100) || !text(message.from, 100) || !text(message.to, 100) || !text(message.text, 20_000)
    || !['message', 'assignment', 'system'].includes(message.type) || !date(message.createdAt)
    || (message.runId !== undefined && !text(message.runId, 100)))) throw new Error('Saved workspace has invalid messages.');
  if (!Array.isArray(state.runs) || state.runs.length > 100 || state.runs.some(run => !run
    || !text(run.id, 100) || !['running', 'completed', 'stopped', 'failed'].includes(run.status) || !['demo', 'pi'].includes(run.mode)
    || !date(run.startedAt) || (run.finishedAt !== undefined && !date(run.finishedAt))
    || !Number.isInteger(run.cycle) || run.cycle < 0 || !Number.isInteger(run.steps) || run.steps < 0
    || (run.error !== undefined && !text(run.error, 20_000)) || (run.activeNodeId !== undefined && !text(run.activeNodeId, 100))
    || (run.activeNodeIds !== undefined && (!Array.isArray(run.activeNodeIds) || run.activeNodeIds.length > 100 || new Set(run.activeNodeIds).size !== run.activeNodeIds.length || run.activeNodeIds.some(id => !text(id, 100))))
    || (run.decisionCount !== undefined && (!Number.isSafeInteger(run.decisionCount) || run.decisionCount < 0))
    || (run.escalations !== undefined && (!Number.isInteger(run.escalations) || run.escalations < 0)))) throw new Error('Saved workspace has invalid runs.');
  for (const run of state.runs) if (run.decisions !== undefined) validateRoutingDecisions(run.decisions);
  return state;
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.tmp`;
  const handle = await open(temporary, 'w');
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filePath);
}

/** A single writer prevents overlapping requests from replacing newer state. */
export class StateStore {
  private state: AppState;
  private writes: Promise<void> = Promise.resolve();
  readonly filePath: string;

  private constructor(filePath: string, state: AppState, private options: StoreOptions) {
    this.filePath = filePath;
    this.state = state;
  }

  static async open(filePath = path.resolve('.crawlspace/state.json'), options: StoreOptions = {}): Promise<StateStore> {
    let state = structuredClone(initialState);
    let recovered = false;
    try {
      state = savedState(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (primaryError) {
      try {
        state = savedState(JSON.parse(await readFile(`${filePath}.bak`, 'utf8')));
        recovered = true;
      } catch (backupError) {
        if ((primaryError as NodeJS.ErrnoException).code !== 'ENOENT' || (backupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('Saved workspace and its backup could not be validated. Restore a valid state.json or state.json.bak before restarting.');
        }
      }
    }
    // A process restart cannot resume an in-flight model request safely.
    for (const run of state.runs) {
      if (run.status === 'running') {
        run.status = 'stopped';
        run.finishedAt = new Date().toISOString();
        run.error = 'The server restarted. Start a new run to continue.';
        delete run.activeNodeId;
        delete run.activeNodeIds;
        for (const decision of run.decisions ?? []) if (decision.status === 'pending') {
          decision.status = 'cancelled'; decision.reason = 'The controller restarted before this decision completed.';
        }
      }
    }
    for (const node of state.workflow.nodes) node.data.status = 'idle';
    if (recovered) {
      state.messages.push({ id: randomUUID(), from: 'system', to: 'all', type: 'system', createdAt: new Date().toISOString(), text: 'Recovered the saved workspace from its last-good backup. The most recent update may need to be repeated.' });
      state.messages = state.messages.slice(-2000);
    }
    const store = new StateStore(filePath, state, options);
    await store.update(() => {});
    return store;
  }

  get(): AppState {
    return structuredClone(this.state);
  }

  async update(mutate: (state: AppState) => void): Promise<AppState> {
    // Mutate only after earlier commits finish; publish only after the durable replacement.
    let committed!: AppState;
    const write = this.writes.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      mutate(next);
      savedState(next);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await this.options.beforeCommit?.('backup');
      await atomicWrite(`${this.filePath}.bak`, JSON.stringify(this.state, null, 2));
      await this.options.beforeCommit?.('primary');
      await atomicWrite(this.filePath, JSON.stringify(next, null, 2));
      this.state = next;
      committed = structuredClone(next);
    });
    this.writes = write;
    await write;
    return committed;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
