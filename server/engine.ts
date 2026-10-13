import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { AppState, Finding, Message, ModelConfig, Run, Workflow, WorkflowNode, RoutingAnswer, RoutingDecision, RoutingChoice, NodeResult, ReportFinding, ProjectSettings, ProjectChange, TestExecution } from '../shared/types';
import { StateStore } from './store';
import { InputError, validateModels, validateWorkflow } from './validation';
import { isEscalatableError } from './execution-errors';
import { setMaxListeners } from 'node:events';
import { EndpointLimiter, planWorkflow, type VisitComponent } from './scheduler';
import { ROUTING_QUESTION_VERSION, routingModel, validateRoutingAnswer } from './routing';
import { evaluateCheck } from './checks';

const projectRuns = new Map<string, { writer?: string; readers: Set<string> }>();

export interface AgentReport {
  output?: string;
  judgment?: NodeResult['judgment'];
  findings?: ReportFinding[];
  messages?: { to: string; text: string }[];
  assignments?: { to: string; text: string }[];
  escalation?: { reason: string };
  execution?: { modelId: string; attempts: number; requests: number; durationMs: number; inputTokens: number; outputTokens: number };
  tests?: TestExecution[];
  changes?: ProjectChange[];
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
  escalation?: { reason: string; originalModelId: string; primaryOutput?: string };
  correction?: { attempt: number; gateNodeId: string; reasons: string[]; previousOutput: string };
  onScreenshot?: (url: string) => void;
  project?: ProjectSettings;
  onProjectActivity?: (activity: { change?: ProjectChange; test?: TestExecution }) => Promise<void>;
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
      scores: upstreamResults.map((result, index) => ({ nodeId: result.nodeId, score: Math.max(0, 90 - index * 5), reasoning: 'Simulated score for the demo comparison.' })),
    } } : {}),
    messages: [{ to: 'all', text: `Demo · cycle ${cycle}: ${node.data.label} reviewed its simulated ${node.data.responsibilities[0]?.toLowerCase() || 'assignment'} task. Persona, prompt, and model selection are configured for a real Pi run.` }],
    assignments: next ? [{ to: next, text: `Demo handoff: continue from ${node.data.label}'s simulated review. Check the shared findings and verify evidence before reporting a real issue.` }] : [],
  };
}

export class WorkflowEngine {
  private active: { id: string; controller: AbortController; task?: Promise<void>; stopping: boolean } | null = null;
  private pending = new Set<Promise<void>>();
  private lifecycle: Promise<void> = Promise.resolve();
  private screenshots = new Set<string>();
  private gatedScreenshots = new Map<string, Set<string>>();
  private runProject?: ProjectSettings;
  private releaseProject?: () => void;
  private projectRevision = 0;
  private approvalWaiter: { runId: string; gateNodeId: string; cycle: number; requestedAt: string; resolve: (decision: 'approve' | 'reject') => void } | null = null;

  constructor(
    private store: StateStore,
    private options: { piExecutor?: AgentExecutor; demoStepMs?: number; routingExecutor?: (context: ExecutionContext) => Promise<RoutingAnswer> } = {},
  ) {}

  get isRunning(): boolean { return this.active !== null; }
  get pendingScreenshots(): string[] { return [...new Set([...this.screenshots, ...[...this.gatedScreenshots.values()].flatMap(urls => [...urls])])]; }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => {}, () => {});
    return result;
  }

  whenIdle<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(() => {
      if (this.active) throw new InputError('Stop the active run before changing configuration.', 409);
      return operation();
    });
  }

  start(mode?: 'demo' | 'pi'): Promise<Run> { return this.serialize(() => this.startRun(mode)); }

  approve(runId: string, gateNodeId: string, decision: 'approve' | 'reject', cycle: number, requestedAt: string): Promise<void> {
    return this.serialize(async () => {
      const waiter = this.approvalWaiter;
      if (!['approve', 'reject'].includes(decision)) throw new InputError('Choose approve or reject.');
      if (!waiter || waiter.runId !== runId || waiter.gateNodeId !== gateNodeId || waiter.cycle !== cycle || waiter.requestedAt !== requestedAt
        || this.active?.id !== runId || this.active.stopping || this.active.controller.signal.aborted) {
        throw new InputError('This gate is no longer waiting for your approval.', 409);
      }
      await this.store.update(state => {
        const approval = state.runs.find(run => run.id === runId)?.approval;
        if (this.active?.id !== runId || this.active.stopping || this.active.controller.signal.aborted
          || !approval || approval.status !== 'pending' || approval.gateNodeId !== gateNodeId || approval.cycle !== cycle || approval.requestedAt !== requestedAt) {
          throw new InputError('This gate is no longer waiting for your approval.', 409);
        }
        approval.status = decision === 'approve' ? 'approved' : 'rejected';
        approval.resolvedAt = new Date().toISOString();
        this.message(state, runId, 'you', gateNodeId, decision === 'approve' ? 'Gate approved. Continue with the accepted reports.' : 'Gate rejected. The run will stop before downstream work.');
      });
      waiter.resolve(decision);
    });
  }

  private async startRun(mode?: 'demo' | 'pi'): Promise<Run> {
    if (this.active) throw new InputError('A run is already active. Stop it before starting another.', 409);
    const state = this.store.get();
    validateModels(state.models);
    validateWorkflow(state.workflow, state.models);
    this.runProject = state.project ? structuredClone(state.project) : undefined;
    this.projectRevision = 0;
    const executionMode = mode ?? state.workflow.settings.executionMode;
    if (!['demo', 'pi'].includes(executionMode)) throw new InputError('Execution mode must be demo or pi.');
    const controller = new AbortController();
    const run: Run = { id: randomUUID(), status: 'running', mode: executionMode, startedAt: new Date().toISOString(), cycle: 0, steps: 0, escalations: 0, activeNodeIds: [], results: [] };
    if (executionMode === 'pi' && this.runProject) {
      const resolved = await realpath(this.runProject.path);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      const mutating = state.workflow.nodes.some(node => node.type === 'agent' && (node.data.tools.includes('edit') || node.data.tools.includes('test')));
      const leases = projectRuns.get(key) ?? { readers: new Set<string>() };
      if (leases.writer || mutating && leases.readers.size) throw new InputError('Another workflow is using this project. Stop it before starting editing or tests in the same folder.', 409);
      if (mutating) leases.writer = run.id; else leases.readers.add(run.id);
      projectRuns.set(key, leases);
      this.releaseProject = () => { if (leases.writer === run.id) delete leases.writer; leases.readers.delete(run.id); if (!leases.writer && !leases.readers.size) projectRuns.delete(key); };
    }
    const active = { id: run.id, controller, stopping: false, task: undefined as Promise<void> | undefined };
    this.active = active;
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
      this.releaseProject?.(); this.releaseProject = undefined;
      throw error;
    }
    const workflow = structuredClone(state.workflow);
    if (this.runProject) { workflow.settings.projectPath = this.runProject.path; workflow.settings.previewUrl = this.runProject.previewUrl; }
    const task = this.execute(workflow, structuredClone(state.models), run, controller.signal);
    active.task = task;
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), error => {
      this.pending.delete(task);
      console.error('Could not persist workflow execution state:', error);
    });
    return structuredClone(run);
  }

  stop(): Promise<void> {
    // Abort immediately even while a prior start/stop operation is committing state.
    if (this.active) { this.active.stopping = true; this.active.controller.abort(); }
    return this.serialize(() => this.stopRun());
  }

  private async stopRun(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.stopping = true;
    active.controller.abort();
    // A replacement run must never overlap the executor's asynchronous cleanup.
    // A failed persistence operation must not prevent a later stop commit from recovering.
    await active.task?.catch(() => {});
    await this.store.update(state => {
      const run = state.runs.find(item => item.id === active.id);
      if (run?.status === 'running') {
        run.status = 'stopped';
        run.finishedAt = new Date().toISOString();
        delete run.activeNodeId;
        run.activeNodeIds = [];
      }
      for (const decision of run?.decisions ?? []) if (decision.status === 'pending') {
        decision.status = 'cancelled'; decision.reason = 'The run stopped before the routing outcome could be saved.';
      }
      if (run?.approval?.status === 'pending') { run.approval.status = 'rejected'; run.approval.resolvedAt = new Date().toISOString(); }
      state.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
      this.message(state, active.id, 'system', 'all', 'Run stopped. Pending agent work and cycle timers have been cancelled.');
    });
    if (this.active === active) this.active = null;
    this.releaseProject?.(); this.releaseProject = undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.lifecycle;
    await Promise.all([...this.pending]);
  }

  private message(state: AppState, runId: string, from: string, to: string, text: string, type: Message['type'] = 'system'): void {
    state.messages.push({ id: randomUUID(), runId, from, to, text, type, createdAt: new Date().toISOString() });
    state.messages = state.messages.slice(-2000);
  }

  private async execute(workflow: Workflow, models: ModelConfig[], run: Run, signal: AbortSignal): Promise<void> {
    const mutating = workflow.nodes.some(node => node.type === 'agent' && (node.data.tools.includes('edit') || node.data.tools.includes('test')));
    const workers = mutating ? 1 : workflow.settings.maxParallelAgents ?? workflow.settings.maxParallel ?? 1;
    const routing = workflow.settings.routing;
    const limiter = new EndpointLimiter([...models, ...(routing && routing.mode !== 'off' ? [routingModel(routing)] : [])], workers);
    const plan = planWorkflow(workflow);
    const continuous = workflow.settings.mode === 'loop' && workflow.settings.continuous === true;
    const cycles = workflow.settings.mode === 'once' ? 1 : workflow.settings.maxCycles;
    let failedNodeId: string | undefined;
    try {
      for (let cycle = 1; continuous || cycle <= cycles; cycle++) {
        aborted(signal);
        await this.store.update(state => {
          aborted(signal);
          const current = state.runs.find(item => item.id === run.id)!;
          current.cycle = cycle;
          delete current.activeNodeId;
          current.activeNodeIds = [];
          delete current.approval;
          state.workflow.nodes.forEach(node => { node.data.status = 'idle'; });
          this.message(state, run.id, 'system', 'all', continuous
            ? `Cycle ${cycle} started. Continuous crawling stays active until you stop the run. Each reachable node starts once; acceptance gates may request bounded corrections.`
            : `Cycle ${cycle} of ${cycles} started. Each reachable node starts once; acceptance gates may request bounded corrections.`);
        });
        await this.executeCycle(plan, workflow, models, run, cycle, limiter, signal, id => { failedNodeId = id; });
        if (continuous || cycle < cycles) {
          await this.store.update(state => {
            aborted(signal);
            delete state.runs.find(item => item.id === run.id)!.activeNodeId;
            state.runs.find(item => item.id === run.id)!.activeNodeIds = [];
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
        current.activeNodeIds = [];
        this.message(state, run.id, 'system', 'all', `Run completed after ${cycles} cycle${cycles === 1 ? '' : 's'} and ${current.steps} workflow steps.`);
      });
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message.slice(0, 10_000) : 'Unexpected agent execution failure.';
        try {
          await this.store.update(state => {
            const current = state.runs.find(item => item.id === run.id)!;
            current.status = 'failed';
            current.error = message;
            current.finishedAt = new Date().toISOString();
            for (const decision of current.decisions ?? []) if (decision.status === 'pending') {
              decision.status = 'cancelled'; decision.reason = 'The run failed before the routing outcome could be saved.';
            }
            if (current.approval?.status === 'pending') { current.approval.status = 'rejected'; current.approval.resolvedAt = new Date().toISOString(); }
            state.workflow.nodes.forEach(item => { if (item.data.status === 'running') item.data.status = 'idle'; });
            const node = state.workflow.nodes.find(item => item.id === failedNodeId);
            if (node) node.data.status = 'error';
            delete current.activeNodeId;
            current.activeNodeIds = [];
            this.message(state, run.id, 'system', 'all', `Run failed: ${message}`);
          });
        } catch (storageError) {
          // Keep edits/restarts locked until Stop can durably close the still-running record.
          if (this.active?.id === run.id) this.active.stopping = true;
          throw storageError;
        }
      }
    } finally {
      this.gatedScreenshots.clear();
      if (!this.active?.stopping) { this.releaseProject?.(); this.releaseProject = undefined; }
      if (this.active?.id === run.id && !this.active.stopping) this.active = null;
    }
  }

  private async executeCycle(plan: VisitComponent[], workflow: Workflow, models: ModelConfig[], run: Run, cycle: number, limiter: EndpointLimiter, runSignal: AbortSignal, failed: (id: string) => void): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([runSignal, controller.signal]);
    // A validated workflow can have 100 queued nodes plus active SDK listeners.
    setMaxListeners(256, signal);
    const completed = new Set<string>();
    const results = new Map<string, NodeResult>();
    const visits = new Map<string, { snapshot: AppState; upstream: NodeResult[] }>();
    const launched = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const allowance = { used: 0, decisions: 0 };
    let failure: { error: unknown } | undefined;
    const fail = (id: string, error: unknown) => {
      if (failure || runSignal.aborted) return;
      failure = { error };
      failed(id);
      controller.abort();
    };
    const inputsFor = (id: string) => [...new Map(workflow.edges
      .filter(edge => edge.target === id && edge.data?.loop !== true && id !== workflow.settings.entryNodeId)
      .map(edge => results.get(edge.source)).filter((result): result is NodeResult => Boolean(result))
      .map(result => [result.nodeId, result])).values()];
    const checkNode = async (node: WorkflowNode): Promise<NodeResult> => {
      aborted(signal);
      const check = evaluateCheck(node, inputsFor(node.id), this.projectRevision);
      const result: NodeResult = {
        nodeId: node.id, nodeName: node.data.label, modelId: 'deterministic', cycle, findings: [], check,
        output: check.passed ? 'All configured report checks passed. This verifies the selected criteria, not overall correctness.'
          : check.units.map(unit => `${unit.nodeId}: ${unit.reasons.join('; ') || 'passed'}`).join('\n').slice(0, 30_000),
        completedAt: new Date().toISOString(), projectRevision: this.projectRevision,
      };
      await this.commitControlResult(run.id, result, signal);
      results.set(node.id, result);
      return result;
    };
    const gateNode = async (node: WorkflowNode): Promise<NodeResult> => {
      const settings = node.data.gate!;
      const checkNodes = inputsFor(node.id).map(result => workflow.nodes.find(item => item.id === result.nodeId)!);
      await this.store.update(state => { aborted(signal); this.setNodeActive(state, run.id, node.id, true); });
      let corrections = 0;
      let changed: Set<string> | undefined;
      let approvedByHuman = false;
      const finish = async (verdict: 'accepted' | 'rejected', reason?: string): Promise<NodeResult> => {
        const reports = [...new Set(checkNodes.flatMap(check => inputsFor(check.id).map(result => result.nodeId)))].map(id => results.get(id)!);
        const perReport = Math.max(100, Math.floor(24_000 / Math.max(1, reports.length)));
        const output = verdict === 'accepted'
          ? `Gate accepted ${reports.length} report(s) after ${corrections} correction round(s). ${run.mode === 'demo' ? 'SIMULATED DEMO; no real work was verified. ' : ''}Only the configured checks were verified.\n\nFinal accepted reports (bounded summaries):\n${reports.map(report => `${report.nodeName} [${report.nodeId}], model ${report.modelId}, attempt ${report.attempt ?? 1}:\n${report.output.slice(0, perReport)}${report.output.length > perReport ? '\n[Report shortened; see run history for the full output.]' : ''}`).join('\n\n')}`.slice(0, 30_000)
          : `Gate rejected: ${reason ?? 'The configured checks did not pass.'}`.slice(0, 30_000);
        const result: NodeResult = {
          nodeId: node.id, nodeName: node.data.label, modelId: 'deterministic', cycle, output,
          findings: verdict === 'accepted' ? reports.flatMap(report => report.findings).slice(0, 30) : [],
          gate: { verdict, checkNodeIds: checkNodes.map(check => check.id), corrections, risk: settings.risk, ...(approvedByHuman ? { approvedByHuman: true } : {}) },
          completedAt: new Date().toISOString(),
        };
        await this.commitControlResult(run.id, result, signal);
        await this.store.update(state => {
          aborted(signal);
          this.setNodeActive(state, run.id, node.id, false);
          state.workflow.nodes.find(item => item.id === node.id)!.data.status = verdict === 'accepted' ? 'done' : 'error';
          this.message(state, run.id, node.id, 'all', output.slice(0, 2000));
        });
        results.set(node.id, result);
        for (const report of reports) this.gatedScreenshots.delete(report.nodeId);
        return result;
      };
      while (true) {
        aborted(signal);
        // A later worker edit invalidates earlier test receipts even when that
        // worker's report already passed its first check.
        for (const check of checkNodes) if (check.data.check?.requireTests && results.get(check.id)?.projectRevision !== this.projectRevision) await checkNode(check);
        const units = new Map<string, { reasons: string[]; retryable: boolean }>();
        for (const check of checkNodes) {
          const outcome = results.get(check.id)?.check;
          if (!outcome || !outcome.units.length) throw new Error(`${node.data.label} has no check evidence. No approval is permitted.`);
          for (const unit of outcome.units) {
            const combined = units.get(unit.nodeId) ?? { reasons: [], retryable: true };
            combined.reasons = [...new Set([...combined.reasons, ...unit.reasons])].slice(0, 30);
            if (!unit.passed) combined.retryable &&= unit.retryable;
            units.set(unit.nodeId, combined);
          }
        }
        await this.store.update(state => {
          aborted(signal);
          const current = state.runs.find(item => item.id === run.id)!;
          for (const [id, unit] of units) {
            if (changed && !changed.has(id) && !unit.reasons.length) continue;
            const report = results.get(id)!;
            (current.outcomes ??= []).push({ id: randomUUID(), nodeId: id, gateNodeId: node.id, cycle,
              attempt: report.attempt ?? 1, verdict: unit.reasons.length ? 'rejected' : 'accepted', reasons: unit.reasons,
              modelId: report.modelId, createdAt: new Date().toISOString() });
          }
          current.outcomes = current.outcomes?.slice(-500);
        });
        const rejected = [...units].filter(([, unit]) => unit.reasons.length);
        if (!rejected.length) {
          if (settings.approval === 'human' || settings.risk === 'high-impact') {
            const approvalResults = [...new Map(checkNodes.flatMap(check => [...inputsFor(check.id), results.get(check.id)!]).map(result => [result.nodeId, result])).values()];
            const decision = await this.requestApproval(run, node, cycle, signal, approvalResults);
            if (decision === 'reject') { await finish('rejected', 'You rejected the final reports.'); throw new Error(`${node.data.label}: final approval rejected.`); }
            approvedByHuman = true;
          }
          return finish('accepted');
        }
        const reason = rejected.map(([id, unit]) => `${id}: ${unit.reasons.join('; ')}`).join('\n').slice(0, 10_000);
        if (rejected.some(([, unit]) => !unit.retryable) || corrections >= settings.maxCorrections) {
          await finish('rejected', reason);
          throw new Error(`${node.data.label} blocked downstream work. ${corrections >= settings.maxCorrections ? 'Correction allowance exhausted. ' : 'A non-correctable check failed. '}${reason}`);
        }
        corrections++;
        changed = new Set(rejected.map(([id]) => id));
        await this.store.update(state => {
          aborted(signal);
          this.message(state, run.id, node.id, 'all', `Correction round ${corrections}/${settings.maxCorrections}: returning only ${rejected.map(([id]) => id).join(', ')}. Accepted reports are preserved.`);
        });
        // Use each worker's original snapshot and inputs. A correction must not
        // leak the private answers of accepted sibling branches into its context.
        const corrected = await Promise.allSettled(rejected.map(async ([id, unit]) => {
          try {
            const original = visits.get(id);
            const worker = workflow.nodes.find(item => item.id === id)!;
            const previous = results.get(id)!;
            if (!original || worker.type !== 'agent') throw new Error('A correction can only return to a worker visited in this cycle.');
            const result = await this.executeNode(workflow, models, run, cycle, worker, limiter, allowance, signal,
              error => fail(node.id, error), original.snapshot, original.upstream,
              { attempt: (previous.attempt ?? 1) + 1, gateNodeId: node.id, reasons: unit.reasons, previousOutput: previous.output });
            results.set(id, result);
          } catch (error) { fail(node.id, error); throw error; }
        }));
        const correctionFailure = corrected.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (correctionFailure) throw correctionFailure.reason;
        // Re-evaluate checks using the final report map, never stale run history.
        for (const check of checkNodes) if (inputsFor(check.id).some(report => changed!.has(report.nodeId))) await checkNode(check);
      }
    };
    try {
      while (completed.size < plan.length) {
        aborted(runSignal);
        if (failure) break;
        // Freeze each ready sibling before any visit acquires an endpoint permit.
        // Queued candidates must never observe another candidate's private answer.
        const snapshot = this.store.get();
        for (const component of plan) {
          if (launched.has(component.id) || !component.dependencies.every(id => completed.has(id))) continue;
          launched.add(component.id);
          const task = (async () => {
            for (const [index, id] of component.nodeIds.entries()) {
              aborted(signal);
              try {
                const upstream = inputsFor(id);
                const node = workflow.nodes.find(node => node.id === id)!;
                const visitSnapshot = index ? this.store.get() : snapshot;
                if (node.type === 'agent') visits.set(id, { snapshot: visitSnapshot, upstream });
                const result = node.type === 'check' ? await checkNode(node)
                  : node.type === 'gate' ? await gateNode(node)
                  : await this.executeNode(workflow, models, run, cycle, node, limiter, allowance, signal, error => fail(id, error), visitSnapshot, upstream);
                results.set(id, result);
              } catch (error) { fail(id, error); throw error; }
            }
            completed.add(component.id);
          })().catch(() => {}).finally(() => { running.delete(component.id); });
          running.set(component.id, task);
        }
        if (!running.size) throw new Error('The workflow has no schedulable agents. Check its connections.');
        await Promise.race(running.values());
      }
    } finally {
      // Preserve the first failure and drain every sibling/queued visit before unlocking.
      if (failure || runSignal.aborted) controller.abort();
      await Promise.allSettled(running.values());
    }
    aborted(runSignal);
    if (failure) throw failure.error;
  }

  private setNodeActive(state: AppState, runId: string, nodeId: string, active: boolean): void {
    const run = state.runs.find(item => item.id === runId)!;
    const ids = run.activeNodeIds ?? (run.activeNodeId ? [run.activeNodeId] : []);
    run.activeNodeIds = active ? [...new Set([...ids, nodeId])] : ids.filter(id => id !== nodeId);
    if (run.activeNodeIds.length) run.activeNodeId = run.activeNodeIds[0];
    else { delete run.activeNodeId; run.activeNodeIds = []; }
    const node = state.workflow.nodes.find(item => item.id === nodeId)!;
    if (active) node.data.status = 'running';
    else if (node.data.status === 'running') node.data.status = 'idle';
  }

  private async commitControlResult(runId: string, result: NodeResult, signal: AbortSignal): Promise<void> {
    await this.store.update(state => {
      aborted(signal);
      const current = state.runs.find(item => item.id === runId)!;
      current.steps++;
      (current.results ??= []).push(result);
      current.results = current.results.slice(-200);
      state.workflow.nodes.find(node => node.id === result.nodeId)!.data.status = 'done';
    });
  }

  private async requestApproval(run: Run, node: WorkflowNode, cycle: number, signal: AbortSignal, results: NodeResult[]): Promise<'approve' | 'reject'> {
    aborted(signal);
    if (this.approvalWaiter) throw new Error('Another gate is already waiting for approval.');
    let resolve!: (decision: 'approve' | 'reject') => void;
    const decision = new Promise<'approve' | 'reject'>(done => { resolve = done; });
    const requestedAt = new Date().toISOString();
    const waiter = { runId: run.id, gateNodeId: node.id, cycle, requestedAt, resolve };
    this.approvalWaiter = waiter;
    try {
      await this.store.update(state => {
        aborted(signal);
        state.runs.find(item => item.id === run.id)!.approval = { gateNodeId: node.id, cycle, status: 'pending', requestedAt, results: structuredClone(results) };
        this.message(state, run.id, node.id, 'all', `${node.data.label}: configured checks passed. Review the reports and approve or reject this gate in Runs. Downstream work is waiting.`);
      });
      aborted(signal);
      return await new Promise<'approve' | 'reject'>((done, reject) => {
        const cancel = () => { signal.removeEventListener('abort', cancel); reject(new DOMException('Run stopped.', 'AbortError')); };
        signal.addEventListener('abort', cancel, { once: true });
        void decision.then(value => { signal.removeEventListener('abort', cancel); done(value); });
        if (signal.aborted) cancel();
      });
    } finally { if (this.approvalWaiter === waiter) this.approvalWaiter = null; }
  }

  private async routeNode(workflow: Workflow, models: ModelConfig[], run: Run, cycle: number, node: WorkflowNode, limiter: EndpointLimiter, allowance: { decisions: number }, signal: AbortSignal, fail: (error: unknown) => void, snapshot: AppState, upstreamResults: NodeResult[]): Promise<{ choice: 'assigned' | 'supervisor'; reason?: string }> {
    const settings = workflow.settings.routing;
    const assigned = models.find(model => model.id === node.data.modelId)!;
    if (run.mode !== 'pi' || !settings || settings.mode === 'off' || assigned.kind !== 'local' || node.data.modelId === workflow.settings.supervisorModelId) return { choice: 'assigned' };
    const supervisor = models.find(model => model.id === workflow.settings.supervisorModelId && model.enabled && model.id !== assigned.id);
    const decision: RoutingDecision = {
      id: randomUUID(), nodeId: node.id, cycle, createdAt: new Date().toISOString(), questionVersion: ROUTING_QUESTION_VERSION,
      mode: settings.mode, backend: settings.backend, configuredModelId: settings.modelId, threshold: settings.confidenceThreshold, status: 'pending',
    };
    let recommendation: RoutingChoice = 'review';
    let reason = '';
    await limiter.run(routingModel(settings), signal, async () => {
      try {
        let exhausted = false;
        await this.store.update(state => {
          aborted(signal);
          const current = state.runs.find(item => item.id === run.id)!;
          exhausted = allowance.decisions >= settings.maxDecisionsPerCycle || (current.decisionCount ?? 0) >= settings.maxDecisionsPerRun;
          if (exhausted) {
            decision.status = 'budget';
            decision.recommendation = 'review';
            decision.reason = 'The decision allowance is exhausted. No classifier request was made.';
            if (settings.mode === 'shadow') decision.selectedModelId = assigned.id;
          } else {
            allowance.decisions++;
            current.decisionCount = (current.decisionCount ?? 0) + 1;
          }
          current.decisions = [...(current.decisions ?? []), structuredClone(decision)].slice(-500);
        });
        if (exhausted) {
          reason = decision.reason!;
          if (settings.mode === 'active') throw new Error(`${reason} Human review is required before more routing.`);
          return;
        }
        let answer: RoutingAnswer | undefined;
        let routingError: unknown;
        const started = Date.now();
        try {
          if (!this.options.routingExecutor) throw new Error('Decision routing is unavailable. Configure a supported decision endpoint.');
          const state = structuredClone(snapshot);
          answer = await this.options.routingExecutor({ workflow: structuredClone(workflow), models: structuredClone(models), node: structuredClone(node), run: state.runs.find(item => item.id === run.id)!, cycle, messages: state.messages, findings: state.findings, upstreamResults: structuredClone(upstreamResults), signal });
          validateRoutingAnswer(answer);
          aborted(signal);
        } catch (error) { routingError = error; }
        if (signal.aborted) {
          decision.status = 'cancelled'; decision.reason = 'The run stopped before routing completed.';
        } else if (routingError) {
          decision.status = 'error';
          // Transport errors may contain user data or credentials; retain a controlled reason.
          decision.reason = 'The decision endpoint did not return a valid answer within its allowance.';
          recommendation = supervisor ? 'supervisor' : 'review';
        } else {
          decision.status = 'completed';
          decision.choice = answer!.choice; decision.probabilities = answer!.probabilities;
          decision.confidence = answer!.confidence; decision.modelId = answer!.modelId; decision.inputTokens = answer!.inputTokens;
          const confident = answer!.confidence >= settings.confidenceThreshold;
          recommendation = confident && answer!.choice === 'assigned' ? 'assigned' : supervisor ? 'supervisor' : 'review';
          decision.reason = confident && answer!.choice === 'assigned' ? 'The assigned worker meets the routing threshold.'
            : confident && answer!.choice === 'supervisor' ? 'The decision model recommends stronger review.'
            : 'The decision is uncertain or needs review; use the configured supervisor, otherwise request human review.';
        }
        decision.durationMs = Date.now() - started;
        if (decision.status !== 'cancelled') {
          decision.recommendation = recommendation;
          if (settings.mode === 'shadow' || recommendation === 'assigned') decision.selectedModelId = assigned.id;
        }
        reason = decision.reason!;
        await this.store.update(state => {
          const current = state.runs.find(item => item.id === run.id)!;
          const saved = current.decisions!.find(item => item.id === decision.id)!;
          Object.assign(saved, structuredClone(decision));
          this.message(state, run.id, 'system', 'all', `${settings.mode === 'shadow' ? 'Shadow routing' : 'Decision routing'} for ${node.data.label}: ${signal.aborted ? 'cancelled' : recommendation}. ${reason}${settings.mode === 'shadow' && !signal.aborted ? ' The assigned model stays in control.' : ''}`);
        });
        aborted(signal);
        if (settings.mode === 'active' && recommendation === 'review') throw new Error(`${reason} Human review is required; no model was called.`);
      } catch (error) { fail(error); throw error; }
    });
    return { choice: settings.mode === 'active' && (recommendation as RoutingChoice) === 'supervisor' ? 'supervisor' : 'assigned', reason };
  }

  private async executeNode(workflow: Workflow, models: ModelConfig[], run: Run, cycle: number, node: WorkflowNode, limiter: EndpointLimiter, allowance: { used: number; decisions: number }, signal: AbortSignal, fail: (error: unknown) => void, snapshot: AppState, upstreamResults: NodeResult[], correction?: ExecutionContext['correction']): Promise<NodeResult> {
    const captures = new Set<string>();
    const testRevisions = new Map<string, number>();
    const visit = async (visitNode: WorkflowNode, escalation?: ExecutionContext['escalation']): Promise<AgentReport> => {
      const model = models.find(item => item.id === visitNode.data.modelId && item.enabled)!;
      return limiter.run(model, signal, async () => {
        try {
          await this.store.update(state => { aborted(signal); this.setNodeActive(state, run.id, node.id, true); });
          const state = structuredClone(snapshot);
          if (escalation || correction) {
            // Carry this candidate's verified primary work into stronger review
            // while retaining its independent snapshot of the other branches.
            const latest = this.store.get();
            state.findings = [...latest.findings.filter(finding => finding.nodeId === node.id), ...state.findings.filter(finding => finding.nodeId !== node.id)];
            const seen = new Set(state.messages.map(message => message.id));
            state.messages.push(...latest.messages.filter(message => message.runId === run.id && message.from === node.id && !seen.has(message.id)));
          }
          const context: ExecutionContext = { workflow: structuredClone(workflow), models: structuredClone(models), node: structuredClone(visitNode), run: state.runs.find(item => item.id === run.id)!, cycle, messages: state.messages, findings: state.findings, upstreamResults: structuredClone(upstreamResults), signal, escalation, correction: correction ? structuredClone(correction) : undefined,
            project: this.runProject ? structuredClone(this.runProject) : undefined,
            onProjectActivity: activity => this.store.update(current => {
              if (activity.change) this.projectRevision++;
              if (activity.test) testRevisions.set(activity.test.commandId, this.projectRevision);
              // A completed physical edit remains auditable even if Stop was requested.
              const text = activity.change ? `Project file ${activity.change.action}: ${activity.change.path}`
                : activity.test ? `Test executed: ${activity.test.name} [${activity.test.commandId}] — ${activity.test.passed ? 'passed' : activity.test.timedOut ? 'timed out' : `failed (exit ${activity.test.exitCode ?? 'interrupted'})`}\n${activity.test.output}` : '';
              if (text) this.message(current, run.id, node.id, 'all', text.slice(0, 20_000));
            }).then(() => {}),
            onScreenshot: url => { captures.add(url); this.screenshots.add(url); },
          };
          if (run.mode === 'demo') { await delay(this.options.demoStepMs ?? 1100, signal); return demoReport(context); }
          if (!this.options.piExecutor) throw new Error('Pi execution is unavailable. Install @earendil-works/pi-coding-agent and configure a model, or choose demo mode.');
          return await this.options.piExecutor(context);
        } catch (error) {
          const supervisorId = workflow.settings.supervisorModelId;
          const canEscalate = !escalation && isEscalatableError(error) && supervisorId && supervisorId !== node.data.modelId && models.some(item => item.id === supervisorId && item.enabled);
          // Abort siblings before releasing a failed visit's permit to queued work.
          if (!canEscalate) fail(error);
          throw error;
        } finally {
          // Terminal Stop/failure commits clear all activity after the workers drain.
          if (!signal.aborted) {
            try { await this.store.update(state => { aborted(signal); this.setNodeActive(state, run.id, node.id, false); }); }
            catch (error) { fail(error); throw error; }
          }
        }
      });
    };
    try {
      const routing = await this.routeNode(workflow, models, run, cycle, node, limiter, allowance, signal, fail, snapshot, upstreamResults);
      let report: AgentReport;
      let escalationReason: string | undefined;
      let originalError: unknown;
      let executedModelId = node.data.modelId;
      try {
        if (routing.choice === 'supervisor') { report = { findings: [], messages: [], assignments: [] }; escalationReason = `Decision routing: ${routing.reason}`; }
        else { report = await visit(node); escalationReason = report.escalation?.reason; }
      }
      catch (error) {
        aborted(signal);
        if (!isEscalatableError(error)) throw error;
        originalError = error;
        escalationReason = error instanceof Error ? error.message.slice(0, 2000) : 'The assigned model could not complete this review.';
        report = { findings: [], messages: [], assignments: [] };
      }
      if (run.mode === 'pi' && escalationReason) {
        const supervisorId = workflow.settings.supervisorModelId;
        if (!supervisorId) {
          await this.store.update(state => { aborted(signal); this.message(state, run.id, 'system', 'all', `${node.data.label} requested stronger review: ${escalationReason}. No supervisor is configured; no additional model was called.`); });
          if (originalError) throw originalError;
        } else {
          const supervisor = models.find(model => model.id === supervisorId && model.enabled);
          const supervisorError = !supervisor ? 'The configured supervisor model is unavailable. Choose an enabled model in workflow settings.'
            : supervisorId === node.data.modelId ? 'The supervisor is already assigned to this agent; recursive escalation is not allowed.' : undefined;
          if (supervisorError) {
            await this.store.update(state => { aborted(signal); if (!originalError) this.applyReport(state, workflow, run, node, report, false); });
            throw new Error(supervisorError);
          }
          const maximum = workflow.settings.maxEscalationsPerCycle ?? 1;
          const maximumPerRun = workflow.settings.maxEscalationsPerRun ?? 10;
          let allowanceError: string | undefined;
          await this.store.update(state => {
            aborted(signal);
            const current = state.runs.find(item => item.id === run.id)!;
            if (!originalError) this.applyReport(state, workflow, run, node, report, false);
            if (allowance.used >= maximum) allowanceError = `The supervisor allowance of ${maximum} visit${maximum === 1 ? '' : 's'} per cycle is exhausted. Human review is required before further supervisor work.`;
            else if ((current.escalations ?? 0) >= maximumPerRun) allowanceError = `The supervisor allowance of ${maximumPerRun} visit${maximumPerRun === 1 ? '' : 's'} per run is exhausted. Human review is required before further supervisor work.`;
            if (allowanceError) { this.message(state, run.id, 'system', 'all', `${node.data.label} requested stronger review: ${escalationReason}. ${allowanceError}`); return; }
            allowance.used++;
            current.escalations = (current.escalations ?? 0) + 1;
            if (routing.choice === 'supervisor') {
              const decision = current.decisions?.slice().reverse().find(item => item.nodeId === node.id && item.cycle === cycle);
              if (decision) decision.selectedModelId = supervisorId;
            }
            this.message(state, run.id, 'system', 'all', `Escalating ${node.data.label} to ${supervisor!.name}: ${escalationReason}. Used ${allowance.used} of ${maximum} supervisor visits this cycle and ${current.escalations} of ${maximumPerRun} this run.`);
          });
          if (allowanceError) throw new Error(allowanceError);
          executedModelId = supervisorId;
          report = await visit({ ...node, data: { ...node.data, modelId: supervisorId } }, { reason: escalationReason, originalModelId: node.data.modelId, ...(report.output ? { primaryOutput: report.output } : {}) });
          if (report.escalation) throw new Error(`Supervisor ${supervisor!.name} requested further escalation: ${report.escalation.reason}. Further model calls are blocked; human review is required.`);
        }
      }
      const fallbackOutput = (report.findings?.length
        ? report.findings.map(finding => `${finding.title}: ${finding.description}`).join('\n\n')
        : report.messages?.map(message => message.text).join('\n\n') || 'Review completed with no verified findings.').slice(0, 30_000);
      const result: NodeResult = {
        nodeId: node.id, nodeName: node.data.label, modelId: executedModelId, cycle,
        output: report.output ?? (workflow.edges.some(edge => edge.source === node.id && !edge.data?.loop
          && workflow.nodes.some(item => item.id === edge.target && item.type === 'check' && item.data.check?.requireOutput)) ? '' : fallbackOutput), findings: structuredClone(report.findings ?? []),
        attempt: correction?.attempt ?? 1,
        ...(report.tests ? { tests: report.tests.map(test => ({ ...structuredClone(test), projectRevision: testRevisions.get(test.commandId) })) } : {}),
        ...(report.changes ? { changes: structuredClone(report.changes) } : {}),
        ...(node.data.tools.includes('test') && this.runProject ? { requiredTestIds: this.runProject.testCommands.map(command => command.id) } : {}),
        ...(report.judgment ? { judgment: structuredClone(report.judgment) } : {}), completedAt: new Date().toISOString(),
      };
      await this.store.update(state => {
        aborted(signal);
        const current = state.runs.find(item => item.id === run.id)!;
        current.steps++;
        (current.results ??= []).push(result);
        if (current.results.length > 200) {
          current.results = current.results.slice(-200);
          if (current.steps === 201) this.message(state, run.id, 'system', 'all', 'Older agent outputs are omitted from run history. The latest 200 outputs are retained; current-cycle handoffs remain complete.');
        }
        state.workflow.nodes.find(item => item.id === node.id)!.data.status = 'done';
        this.applyReport(state, workflow, run, node, report);
      });
      if (workflow.edges.some(edge => edge.source === node.id && !edge.data?.loop
        && workflow.nodes.some(item => item.id === edge.target && item.type === 'check'))) {
        const retained = this.gatedScreenshots.get(node.id) ?? new Set<string>();
        for (const finding of result.findings) if (finding.screenshot) retained.add(finding.screenshot);
        this.gatedScreenshots.set(node.id, retained);
      }
      return result;
    } finally { for (const url of captures) this.screenshots.delete(url); }
  }

  private applyReport(state: AppState, workflow: Workflow, run: Run, node: WorkflowNode, report: AgentReport, handoff = true): void {
    if (report.execution) {
      const execution = report.execution;
      this.message(state, run.id, 'system', 'all', `Model ${execution.modelId} completed ${node.data.label}: ${execution.attempts} attempt(s), ${execution.requests} request(s), ${Math.round(execution.durationMs)}ms, ${execution.inputTokens} input and ${execution.outputTokens} output tokens.`);
    }
    for (const finding of report.findings ?? []) {
      // A recurring observation refreshes its evidence and reopens a resolved finding.
      const existing = state.findings.find(item => item.nodeId === node.id && item.title === finding.title
        && item.file === finding.file && Boolean(item.demo) === (run.mode === 'demo'));
      if (existing) {
        existing.description = finding.description;
        existing.severity = finding.severity;
        if (finding.line !== undefined) existing.line = finding.line;
        else delete existing.line;
        if (finding.screenshot !== undefined) existing.screenshot = finding.screenshot;
        else delete existing.screenshot;
        if (existing.status === 'resolved') existing.status = 'open';
        continue;
      }
      state.findings.unshift({ ...finding, id: randomUUID(), nodeId: node.id, status: 'open', createdAt: new Date().toISOString(), demo: run.mode === 'demo' });
    }
    for (const message of report.messages ?? []) this.message(state, run.id, node.id, message.to, message.text, 'message');
    for (const assignment of report.assignments ?? []) {
      this.message(state, run.id, node.id, assignment.to, assignment.text, 'assignment');
    }
    const assigned = new Set((report.assignments ?? []).map(item => item.to));
    for (const edge of handoff ? workflow.edges.filter(item => item.source === node.id && item.data?.loop !== true) : []) {
      if (!assigned.has(edge.target)) this.message(state, run.id, node.id, edge.target, `${node.data.label} completed its step. Continue with your responsibilities and the shared findings.`, 'assignment');
    }
    state.findings = state.findings.slice(0, 2000);
  }
}
