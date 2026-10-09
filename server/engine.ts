import { randomUUID } from 'node:crypto';
import type { AppState, Finding, Message, ModelConfig, NodeResult, ReportFinding, Run, Workflow, WorkflowNode } from '../shared/types';
import { StateStore } from './store';
import { InputError, traversalOrder, validateModels, validateWorkflow } from './validation';

export interface AgentReport {
  output?: string;
  findings?: ReportFinding[];
  judgment?: NodeResult['judgment'];
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
  upstreamResults: NodeResult[];
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

/** Stop promptly even if a provider ignores cancellation; its late response is discarded. */
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('Run stopped.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(value => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) cancel(); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    if (signal.aborted) cancel();
  });
}

function demoReport(context: ExecutionContext): AgentReport {
  const { node, cycle, workflow, upstreamResults } = context;
  const next = workflow.edges.find(edge => edge.source === node.id && edge.data?.loop !== true)?.target;
  const examples: Partial<Record<WorkflowNode['data']['role'], AgentReport['findings']>> = {
    crawler: [{ title: 'Demo: unhandled empty result', description: 'Example finding for the demo board. A crawler could flag a list view that assumes a result is always present. No repository files were inspected.', severity: 'medium', demo: true }],
    tester: [{ title: 'Demo: missing boundary test', description: 'Example finding for the demo board. A test agent could request coverage for an empty response and retry behavior. No tests were run.', severity: 'low', demo: true }],
    designer: [{ title: 'Demo: low-contrast secondary text', description: 'Example visual observation for the demo board. A real UI inspection would attach a screenshot as evidence. No screenshot was taken in this demo.', severity: 'medium', demo: true }],
  };
  return {
    output: `Demo · cycle ${cycle}: ${node.data.label} (${node.data.modelId}) produced a simulated review of: ${node.data.prompt}`,
    findings: cycle === 1 ? examples[node.data.role] ?? [] : [],
    ...(node.data.role === 'judge' && upstreamResults.length ? { judgment: {
      winnerNodeId: upstreamResults[0].nodeId,
      reasoning: 'Demo comparison only. The first candidate is selected to illustrate a recorded decision; no model quality was evaluated.',
      scores: upstreamResults.map((result, index) => ({ nodeId: result.nodeId, score: 90 - index * 5, reasoning: 'Simulated score for the demo comparison.' })),
    } } : {}),
    messages: [{ to: 'all', text: `Demo · cycle ${cycle}: ${node.data.label} reviewed its simulated ${node.data.responsibilities[0]?.toLowerCase() || 'assignment'} task. Persona, prompt, and model selection are configured for a real Pi run.` }],
    assignments: next ? [{ to: next, text: `Demo handoff: continue from ${node.data.label}'s simulated review. Check the shared findings and verify evidence before reporting a real issue.` }] : [],
  };
}

class NodeExecutionError extends Error {
  constructor(public nodeId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Unexpected agent execution failure.', { cause });
  }
}

type StepOutcome = { nodeId: string; result: NodeResult } | { nodeId: string; error: unknown };

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
    const run: Run = { id: randomUUID(), status: 'running', mode: executionMode, startedAt: new Date().toISOString(), cycle: 0, steps: 0, activeNodeIds: [], results: [] };
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
    const task = this.execute(structuredClone(state.workflow), structuredClone(state.models), run, controller);
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
        this.clearActive(run);
      }
      state.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
      this.message(state, active.id, 'system', 'all', 'Run stopped. Pending agent work and cycle timers have been cancelled.');
    });
  }

  async waitForIdle(): Promise<void> { await Promise.all([...this.pending]); }

  private clearActive(run: Run): void {
    delete run.activeNodeId;
    run.activeNodeIds = [];
  }

  private message(state: AppState, runId: string, from: string, to: string, text: string, type: Message['type'] = 'system'): void {
    state.messages.push({ id: randomUUID(), runId, from, to, text, type, createdAt: new Date().toISOString() });
    state.messages = state.messages.slice(-2000);
  }

  private async execute(workflow: Workflow, models: ModelConfig[], run: Run, controller: AbortController): Promise<void> {
    const { signal } = controller;
    const continuous = workflow.settings.mode === 'loop' && workflow.settings.continuous === true;
    const cycles = workflow.settings.mode === 'once' ? 1 : workflow.settings.maxCycles;
    try {
      for (let cycle = 1; continuous || cycle <= cycles; cycle++) {
        aborted(signal);
        await this.store.update(state => {
          aborted(signal);
          const current = state.runs.find(item => item.id === run.id)!;
          current.cycle = cycle;
          this.clearActive(current);
          state.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
          this.message(state, run.id, 'system', 'all', continuous
            ? `Cycle ${cycle} started. Continuous crawling stays active until you stop the run. Each reachable agent runs once in this cycle.`
            : `Cycle ${cycle} of ${cycles} started. Each reachable agent runs once in this cycle.`);
        });
        await this.executeCycle(workflow, models, run, cycle, signal);
        if (continuous || cycle < cycles) {
          await this.store.update(state => {
            aborted(signal);
            this.clearActive(state.runs.find(item => item.id === run.id)!);
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
        this.clearActive(current);
        this.message(state, run.id, 'system', 'all', `Run completed after ${cycles} cycle${cycles === 1 ? '' : 's'} and ${current.steps} agent steps.`);
      });
    } catch (error) {
      if (!signal.aborted) {
        controller.abort();
        const message = error instanceof Error ? error.message : 'Unexpected agent execution failure.';
        await this.store.update(state => {
          const current = state.runs.find(item => item.id === run.id)!;
          if (current.status !== 'running') return;
          current.status = 'failed';
          current.error = message;
          current.finishedAt = new Date().toISOString();
          state.workflow.nodes.forEach(node => {
            if (node.data.status === 'running') node.data.status = 'idle';
            if (error instanceof NodeExecutionError && error.nodeId === node.id) node.data.status = 'error';
          });
          this.clearActive(current);
          this.message(state, run.id, 'system', 'all', `Run failed: ${message}`);
        });
      }
    } finally {
      if (this.active?.id === run.id) this.active = null;
    }
  }

  private async executeCycle(workflow: Workflow, models: ModelConfig[], run: Run, cycle: number, signal: AbortSignal): Promise<void> {
    const order = traversalOrder(workflow);
    const predecessors = new Map(order.map(nodeId => [nodeId, new Set<string>()]));
    for (const edge of workflow.edges) {
      if (edge.data?.loop !== true) predecessors.get(edge.target)!.add(edge.source);
    }
    const scheduled = new Set<string>();
    const completed = new Map<string, NodeResult>();
    const queued: ExecutionContext[] = [];
    const running = new Map<string, Promise<StepOutcome>>();
    const parallel = workflow.settings.maxParallel ?? 3;
    while (completed.size < order.length) {
      aborted(signal);
      const ready = order.filter(nodeId => !scheduled.has(nodeId)
        && [...predecessors.get(nodeId)!].every(parent => completed.has(parent)));
      if (ready.length) {
        // Capture every ready sibling before any starts, including siblings waiting
        // for capacity. Their prompts cannot observe another candidate's response.
        const snapshot = this.store.get();
        for (const nodeId of ready) {
          scheduled.add(nodeId);
          queued.push({
            workflow: structuredClone(workflow), models: structuredClone(models),
            node: structuredClone(workflow.nodes.find(item => item.id === nodeId)!),
            run: structuredClone(snapshot.runs.find(item => item.id === run.id)!), cycle,
            messages: structuredClone(snapshot.messages), findings: structuredClone(snapshot.findings),
            upstreamResults: structuredClone([...predecessors.get(nodeId)!].map(parent => completed.get(parent)!)), signal,
          });
        }
      }
      const launch = queued.splice(0, Math.max(0, parallel - running.size));
      if (launch.length) {
        await this.store.update(state => {
          aborted(signal);
          const current = state.runs.find(item => item.id === run.id)!;
          current.activeNodeIds = [...(current.activeNodeIds ?? []), ...launch.map(context => context.node.id)];
          current.activeNodeId = current.activeNodeIds[0];
          for (const context of launch) state.workflow.nodes.find(item => item.id === context.node.id)!.data.status = 'running';
        });
        for (const context of launch) {
          const task = this.executeNode(context).then(
            result => ({ nodeId: context.node.id, result }),
            error => ({ nodeId: context.node.id, error }),
          );
          running.set(context.node.id, task);
        }
      }
      if (!running.size) throw new Error('Workflow cannot continue. Check normal connections for an unmarked cycle.');
      const outcome = await Promise.race(running.values());
      running.delete(outcome.nodeId);
      if ('error' in outcome) throw new NodeExecutionError(outcome.nodeId, outcome.error);
      completed.set(outcome.nodeId, outcome.result);
    }
  }

  private async executeNode(context: ExecutionContext): Promise<NodeResult> {
    const { workflow, node, run, cycle, signal } = context;
    aborted(signal);
    let report: AgentReport;
    if (run.mode === 'demo') {
      await delay(this.options.demoStepMs ?? 1100, signal);
      report = demoReport(context);
    } else {
      if (!this.options.piExecutor) throw new Error('Pi execution is unavailable. Install @earendil-works/pi-coding-agent and configure a model, or choose demo mode.');
      report = await cancellable(this.options.piExecutor(context), signal);
    }
    aborted(signal);
    const result: NodeResult = {
      nodeId: node.id, nodeName: node.data.label, modelId: node.data.modelId, cycle,
      output: report.output ?? '', findings: structuredClone(report.findings ?? []),
      ...(report.judgment ? { judgment: structuredClone(report.judgment) } : {}), completedAt: new Date().toISOString(),
    };
    await this.store.update(state => {
      aborted(signal);
      const current = state.runs.find(item => item.id === run.id)!;
      if (current.status !== 'running') throw new DOMException('Run stopped.', 'AbortError');
      current.steps++;
      (current.results ??= []).push(result);
      if (current.results.length > 200) {
        current.results = current.results.slice(-200);
        if (current.steps === 201) this.message(state, run.id, 'system', 'all', 'Older agent outputs are omitted from run history. The latest 200 outputs are retained; current-cycle handoffs remain complete.');
      }
      current.activeNodeIds = (current.activeNodeIds ?? []).filter(nodeId => nodeId !== node.id);
      current.activeNodeId = current.activeNodeIds[0];
      if (!current.activeNodeId) delete current.activeNodeId;
      state.workflow.nodes.find(item => item.id === node.id)!.data.status = 'done';
      this.applyReport(state, workflow, run, node, report);
    });
    return result;
  }

  private applyReport(state: AppState, workflow: Workflow, run: Run, node: WorkflowNode, report: AgentReport): void {
    for (const finding of report.findings ?? []) {
      const existing = state.findings.find(item => item.nodeId === node.id && item.title === finding.title
        && item.file === finding.file && Boolean(item.demo) === (run.mode === 'demo'));
      if (existing) continue;
      state.findings.unshift({ ...finding, id: randomUUID(), nodeId: node.id, status: 'open', createdAt: new Date().toISOString(), demo: run.mode === 'demo' });
    }
    for (const message of report.messages ?? []) this.message(state, run.id, node.id, message.to, message.text, 'message');
    for (const assignment of report.assignments ?? []) this.message(state, run.id, node.id, assignment.to, assignment.text, 'assignment');
    const assigned = new Set((report.assignments ?? []).map(item => item.to));
    for (const edge of workflow.edges.filter(item => item.source === node.id && item.data?.loop !== true)) {
      if (!assigned.has(edge.target)) this.message(state, run.id, node.id, edge.target, `${node.data.label} completed its step. Continue with your responsibilities and the shared findings.`, 'assignment');
    }
    state.findings = state.findings.slice(0, 2000);
  }
}
