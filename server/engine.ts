import { randomUUID } from 'node:crypto';
import type { AppState, Finding, Message, ModelConfig, Run, Workflow, WorkflowNode } from '../shared/types';
import { StateStore } from './store';
import { InputError, traversalOrder, validateModels, validateWorkflow } from './validation';

export interface AgentReport {
  findings?: { title: string; description: string; severity: Finding['severity']; file?: string; line?: number; screenshot?: string; demo?: boolean }[];
  messages?: { to: string; text: string }[];
  assignments?: { to: string; text: string }[];
}
export interface ExecutionContext {
  workflow: Workflow;
  models: ModelConfig[];
  node: WorkflowNode;
  run: Run;
  cycle: number;
  messages: Message[];
  findings: Finding[];
  signal: AbortSignal;
}
export type AgentExecutor = (context: ExecutionContext) => Promise<AgentReport>;

export function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Run stopped.', 'AbortError');
}

export function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new DOMException('Run stopped.', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function demoReport(context: ExecutionContext): AgentReport {
  const { node, cycle, workflow } = context;
  const next = workflow.edges.find(edge => edge.source === node.id)?.target;
  const examples: Partial<Record<WorkflowNode['data']['role'], AgentReport['findings']>> = {
    crawler: [{ title: 'Demo: unhandled empty result', description: 'Example finding for the demo board. A crawler could flag a list view that assumes a result is always present. No repository files were inspected.', severity: 'medium', demo: true }],
    tester: [{ title: 'Demo: missing boundary test', description: 'Example finding for the demo board. A test agent could request coverage for an empty response and retry behavior. No tests were run.', severity: 'low', demo: true }],
    designer: [{ title: 'Demo: low-contrast secondary text', description: 'Example visual observation for the demo board. A real UI inspection would attach a screenshot as evidence. No screenshot was taken in this demo.', severity: 'medium', demo: true }],
  };
  return {
    findings: cycle === 1 ? examples[node.data.role] ?? [] : [],
    messages: [{ to: 'all', text: `Demo · cycle ${cycle}: ${node.data.label} reviewed its simulated ${node.data.responsibilities[0]?.toLowerCase() || 'assignment'} task. Persona, prompt, and model selection are configured for a real Pi run.` }],
    assignments: next ? [{ to: next, text: `Demo handoff: continue from ${node.data.label}'s simulated review. Check the shared findings and verify evidence before reporting a real issue.` }] : [],
  };
}

export class WorkflowEngine {
  private active: { id: string; controller: AbortController } | null = null;
  private pending = new Set<Promise<void>>();

  constructor(
    private store: StateStore,
    private options: { piExecutor?: AgentExecutor; demoStepMs?: number } = {},
  ) {}

  get isRunning(): boolean { return this.active !== null; }

  async start(mode?: 'demo' | 'pi'): Promise<Run> {
    if (this.active) throw new InputError('A run is already active. Stop it before starting another.', 409);
    const state = this.store.get();
    validateModels(state.models);
    validateWorkflow(state.workflow, state.models);
    const executionMode = mode ?? state.workflow.settings.executionMode;
    if (!['demo', 'pi'].includes(executionMode)) throw new InputError('Execution mode must be demo or pi.');
    const controller = new AbortController();
    const run: Run = { id: randomUUID(), status: 'running', mode: executionMode, startedAt: new Date().toISOString(), cycle: 0, steps: 0 };
    this.active = { id: run.id, controller };
    try {
      await this.store.update(current => {
        current.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
        current.runs.unshift(run);
        current.runs = current.runs.slice(0, 100);
        this.message(current, run.id, 'system', 'all', executionMode === 'demo'
          ? 'Demo started. Agents will share clearly labeled example findings; no code or UI is being inspected.'
          : 'Pi run started. Agents will inspect the selected project with their configured models and read-only tools.');
      });
    } catch (error) {
      this.active = null;
      throw error;
    }
    const task = this.execute(structuredClone(state.workflow), structuredClone(state.models), run, controller.signal);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), error => {
      this.pending.delete(task);
      console.error('Could not persist workflow execution state:', error);
    });
    return structuredClone(run);
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    this.active = null;
    await this.store.update(state => {
      const run = state.runs.find(item => item.id === active.id);
      if (run?.status === 'running') {
        run.status = 'stopped';
        run.finishedAt = new Date().toISOString();
        delete run.activeNodeId;
      }
      state.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
      this.message(state, active.id, 'system', 'all', 'Run stopped. Pending agent work and cycle timers have been cancelled.');
    });
  }

  async waitForIdle(): Promise<void> { await Promise.all([...this.pending]); }

  private message(state: AppState, runId: string, from: string, to: string, text: string, type: Message['type'] = 'system'): void {
    state.messages.push({ id: randomUUID(), runId, from, to, text, type, createdAt: new Date().toISOString() });
    state.messages = state.messages.slice(-2000);
  }

  private async execute(workflow: Workflow, models: ModelConfig[], run: Run, signal: AbortSignal): Promise<void> {
    const order = traversalOrder(workflow);
    const continuous = workflow.settings.mode === 'loop' && workflow.settings.continuous === true;
    const cycles = workflow.settings.mode === 'once' ? 1 : workflow.settings.maxCycles;
    try {
      for (let cycle = 1; continuous || cycle <= cycles; cycle++) {
        aborted(signal);
        await this.store.update(state => {
          aborted(signal);
          const current = state.runs.find(item => item.id === run.id)!;
          current.cycle = cycle;
          state.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
          this.message(state, run.id, 'system', 'all', continuous
            ? `Cycle ${cycle} started. Continuous crawling stays active until you stop the run. Each reachable agent runs once in this cycle.`
            : `Cycle ${cycle} of ${cycles} started. Each reachable agent runs once in this cycle.`);
        });
        for (const nodeId of order) {
          aborted(signal);
          const node = workflow.nodes.find(item => item.id === nodeId)!;
          await this.store.update(state => {
            aborted(signal);
            state.runs.find(item => item.id === run.id)!.activeNodeId = node.id;
            state.workflow.nodes.find(item => item.id === node.id)!.data.status = 'running';
          });
          const state = this.store.get();
          const context: ExecutionContext = { workflow, models, node, run, cycle, messages: state.messages, findings: state.findings, signal };
          let report: AgentReport;
          if (run.mode === 'demo') {
            await delay(this.options.demoStepMs ?? 1100, signal);
            report = demoReport(context);
          } else {
            if (!this.options.piExecutor) throw new Error('Pi execution is unavailable. Install @earendil-works/pi-coding-agent and configure a model, or choose demo mode.');
            report = await this.options.piExecutor(context);
          }
          aborted(signal);
          await this.store.update(current => {
            aborted(signal);
            const currentRun = current.runs.find(item => item.id === run.id)!;
            currentRun.steps++;
            current.workflow.nodes.find(item => item.id === node.id)!.data.status = 'done';
            this.applyReport(current, workflow, run, node, report);
          });
        }
        if (continuous || cycle < cycles) {
          await this.store.update(state => {
            aborted(signal);
            delete state.runs.find(item => item.id === run.id)!.activeNodeId;
            this.message(state, run.id, 'system', 'all', `Cycle ${cycle} finished. Next cycle starts in ${workflow.settings.intervalSeconds}s.`);
          });
          await delay(workflow.settings.intervalSeconds * 1000, signal);
        }
      }
      aborted(signal);
      await this.store.update(state => {
        aborted(signal);
        const current = state.runs.find(item => item.id === run.id)!;
        current.status = 'completed';
        current.finishedAt = new Date().toISOString();
        delete current.activeNodeId;
        this.message(state, run.id, 'system', 'all', `Run completed after ${cycles} cycle${cycles === 1 ? '' : 's'} and ${current.steps} agent steps.`);
      });
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : 'Unexpected agent execution failure.';
        await this.store.update(state => {
          const current = state.runs.find(item => item.id === run.id)!;
          current.status = 'failed';
          current.error = message;
          current.finishedAt = new Date().toISOString();
          const node = state.workflow.nodes.find(item => item.id === current.activeNodeId);
          if (node) node.data.status = 'error';
          delete current.activeNodeId;
          this.message(state, run.id, 'system', 'all', `Run failed: ${message}`);
        });
      }
    } finally {
      if (this.active?.id === run.id) this.active = null;
    }
  }

  private applyReport(state: AppState, workflow: Workflow, run: Run, node: WorkflowNode, report: AgentReport): void {
    for (const finding of report.findings ?? []) {
      // Repeated passes update the board only when there is a new observation.
      const existing = state.findings.find(item => item.nodeId === node.id && item.title === finding.title
        && item.file === finding.file && Boolean(item.demo) === (run.mode === 'demo'));
      if (existing) continue;
      state.findings.unshift({ ...finding, id: randomUUID(), nodeId: node.id, status: 'open', createdAt: new Date().toISOString(), demo: run.mode === 'demo' });
    }
    for (const message of report.messages ?? []) this.message(state, run.id, node.id, message.to, message.text, 'message');
    for (const assignment of report.assignments ?? []) {
      this.message(state, run.id, node.id, assignment.to, assignment.text, 'assignment');
    }
    const assigned = new Set((report.assignments ?? []).map(item => item.to));
    for (const edge of workflow.edges.filter(item => item.source === node.id)) {
      if (!assigned.has(edge.target)) this.message(state, run.id, node.id, edge.target, `${node.data.label} completed its step. Continue with your responsibilities and the shared findings.`, 'assignment');
    }
    state.findings = state.findings.slice(0, 2000);
  }
}
