import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ModelConfig } from '../shared/types';
import { reliabilityOutcomes, reliabilityToolNames, type ModelReliabilitySummary, type ReliabilityFailure, type ReliabilityModel, type ReliabilityOutcome, type ReliabilitySnapshot, type ReliabilityToolCall, type ReliabilityToolName, type ReliabilityToolSummary, type ReliabilityVisit, type ReliabilityVisitStatus } from '../shared/reliability';

const maxVisits = 1000;
const maxCalls = 256;
const maxFileBytes = 32 * 1024 * 1024;
const statuses: ReliabilityVisitStatus[] = ['success', 'failed', 'cancelled', 'interrupted'];
const failures: ReliabilityFailure[] = ['transient', 'report', 'configuration', 'timeout'];
const incomplete = new Set<ReliabilityOutcome>(['blocked', 'cancelled', 'interrupted']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const recordFields = (value: unknown, names: readonly string[]) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const date = (value: unknown) => typeof value === 'string' && value.length <= 30 && Number.isFinite(Date.parse(value));

function normalizedEndpoint(config: ModelConfig): string {
  const fallback = config.provider === 'anthropic' ? 'https://api.anthropic.com' : config.provider === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11434/v1';
  try {
    const url = new URL(config.baseUrl.trim() || fallback);
    if (!['http:', 'https:'].includes(url.protocol)) return '[invalid endpoint]';
    // Defensive even though model configuration validation disallows these fields.
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch { return '[invalid endpoint]'; }
}

function fingerprint(model: Omit<ReliabilityModel, 'fingerprint'>): string {
  return hash(JSON.stringify({ configId: model.configId, provider: model.provider, kind: model.kind, modelId: model.modelId, endpoint: model.endpoint,
    authMethod: model.authMethod, chatgptProfileId: model.chatgptProfileId ?? null, reasoningEffort: model.reasoningEffort,
    contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, timeoutSeconds: model.timeoutSeconds,
    maxConcurrentRequests: model.maxConcurrentRequests, supportsImages: model.supportsImages }));
}

function modelIdentity(config: ModelConfig): ReliabilityModel {
  const contextWindow = config.contextWindow ?? 32768;
  const model: Omit<ReliabilityModel, 'fingerprint'> = { configId: config.id, name: config.name, provider: config.provider, kind: config.kind,
    modelId: config.modelId, endpoint: normalizedEndpoint(config), authMethod: config.authMethod ?? 'apiKey',
    ...(config.authMethod === 'chatgpt' && config.chatgptProfileId ? { chatgptProfileId: config.chatgptProfileId } : {}),
    reasoningEffort: config.reasoningEffort ?? 'off', contextWindow,
    maxOutputTokens: config.maxOutputTokens ?? Math.min(8192, Math.floor(contextWindow / 4)),
    timeoutSeconds: config.timeoutSeconds ?? 180, maxConcurrentRequests: config.maxConcurrentRequests ?? 1, supportsImages: config.supportsImages ?? false };
  return { ...model, fingerprint: fingerprint(model) };
}

interface PendingCall { tool: ReliabilityToolName; started: number; executed: boolean; blocked: boolean }

/** Keeps only classifications and timings. SDK argument/result content is inspected transiently, never retained. */
export class ReliabilityVisitTracker {
  private readonly model: ReliabilityModel;
  private readonly started: number;
  private readonly pending = new Map<string, PendingCall>();
  private readonly calls: ReliabilityToolCall[] = [];
  private attempts = 0;
  private requests = 0;
  private providerFailures = 0;
  private reportRejections = 0;
  private reportRepairs = 0;
  private omittedCalls = 0;
  private finished?: ReliabilityVisit;
  constructor(config: ModelConfig, private readonly metadata: { runId: string; nodeId: string; cycle: number; codeMode: boolean; source?: 'workflow' | 'probe' }, private readonly now: () => number = Date.now) {
    this.model = modelIdentity(config);
    this.started = now();
  }
  observe(event: any, cancelled = false): void {
    if (this.finished || !event || typeof event.toolCallId !== 'string') return;
    const id = hash(event.toolCallId);
    if (event.type === 'tool_execution_start') {
      if (this.pending.has(id)) return;
      if (this.calls.length + this.pending.size >= maxCalls) { this.omittedCalls++; return; }
      const tool: ReliabilityToolName = reliabilityToolNames.includes(event.toolName) ? event.toolName : '[unknown tool]';
      this.pending.set(id, { tool, started: this.now(), executed: false, blocked: false });
    } else if (event.type === 'tool_execution_end') {
      const call = this.pending.get(id);
      if (!call) return; // Duplicate completion events cannot create extra calls.
      this.pending.delete(id); // IDs can be reused in a subsequent request or retry.
      let outcome: ReliabilityOutcome = 'success';
      if (call.blocked) outcome = 'blocked';
      else if (event.isError === true || event.result?.isError === true) {
        const message = Array.isArray(event.result?.content) ? event.result.content
          .filter((item: any) => item?.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n') : '';
        if (cancelled || /^(?:Operation aborted\b|AbortError\b|Aborted\b|Run stopped\b)|\bScript aborted:/i.test(message)) outcome = 'cancelled';
        else if (!call.executed && message.includes('response hit the output token limit')) outcome = 'truncated';
        else if (!call.executed && message.startsWith('Validation failed for tool')) outcome = 'invalid_arguments';
        else if (!call.executed && /^Tool [\s\S]+ not found$/.test(message)) outcome = 'unknown_tool';
        else outcome = call.tool === 'codemode' ? 'code_error' : 'execution_error';
      }
      const milliseconds = duration(event.durationMs) ? event.durationMs : Math.max(0, this.now() - call.started);
      this.calls.push({ tool: call.tool, outcome, durationMs: milliseconds });
    }
  }
  nextAttempt(): void {
    if (this.finished) return;
    this.settlePending('interrupted');
    this.attempts++;
  }
  request(): void { if (!this.finished) this.requests++; }
  reportRejected(): void { if (!this.finished) this.reportRejections++; }
  reportRepair(): void { if (!this.finished) this.reportRepairs++; }
  providerFailure(): void { if (!this.finished) this.providerFailures++; }
  executed(toolCallId: string): void { const call = this.pending.get(hash(toolCallId)); if (call) call.executed = true; }
  blocked(toolCallId: string): void { const call = this.pending.get(hash(toolCallId)); if (call) call.blocked = true; }
  private settlePending(outcome: 'cancelled' | 'interrupted'): void {
    const now = this.now();
    for (const call of this.pending.values()) this.calls.push({ tool: call.tool, outcome, durationMs: Math.max(0, now - call.started) });
    this.pending.clear();
  }
  finish(status: ReliabilityVisitStatus, failure?: ReliabilityFailure): ReliabilityVisit {
    if (!this.finished) {
      this.settlePending(status === 'cancelled' ? 'cancelled' : 'interrupted');
      const finished = this.now();
      this.finished = { id: randomUUID(), model: this.model, runId: this.metadata.runId, nodeId: this.metadata.nodeId,
        cycle: this.metadata.cycle, source: this.metadata.source ?? 'workflow', codeMode: this.metadata.codeMode, status,
        ...(status === 'failed' && failure ? { failure } : {}), startedAt: new Date(this.started).toISOString(),
        finishedAt: new Date(finished).toISOString(), durationMs: Math.max(0, finished - this.started),
        retryAttempts: Math.max(0, this.attempts - 1), requests: this.requests, providerFailures: this.providerFailures,
        reportRejections: this.reportRejections, reportRepairs: this.reportRepairs, calls: this.calls, omittedCalls: this.omittedCalls };
    }
    return structuredClone(this.finished);
  }
}

interface ReliabilityData { version: 1; visits: ReliabilityVisit[]; updatedAt: string }

function validateVisit(value: unknown): asserts value is ReliabilityVisit {
  const visit = value as ReliabilityVisit;
  const model = visit?.model;
  if (!recordFields(visit, ['id', 'model', 'runId', 'nodeId', 'cycle', 'source', 'codeMode', 'status', 'failure', 'startedAt', 'finishedAt', 'durationMs', 'retryAttempts', 'requests', 'providerFailures', 'reportRejections', 'reportRepairs', 'calls', 'omittedCalls'])
    || !text(visit.id, 100) || !text(visit.runId, 100) || !text(visit.nodeId, 100) || !count(visit.cycle)
    || !['workflow', 'probe'].includes(visit.source) || typeof visit.codeMode !== 'boolean' || !statuses.includes(visit.status)
    || (visit.failure !== undefined && (!failures.includes(visit.failure) || visit.status !== 'failed'))
    || !date(visit.startedAt) || !date(visit.finishedAt) || Date.parse(visit.finishedAt) < Date.parse(visit.startedAt) || !duration(visit.durationMs)
    || ![visit.retryAttempts, visit.requests, visit.providerFailures, visit.reportRejections, visit.reportRepairs, visit.omittedCalls].every(count)
    || !Array.isArray(visit.calls) || visit.calls.length > maxCalls
    || visit.calls.some(call => !recordFields(call, ['tool', 'outcome', 'durationMs']) || !reliabilityToolNames.includes(call.tool) || !reliabilityOutcomes.includes(call.outcome) || !duration(call.durationMs))) throw new Error('Invalid reliability visit.');
  if (!recordFields(model, ['fingerprint', 'configId', 'name', 'provider', 'kind', 'modelId', 'endpoint', 'authMethod', 'chatgptProfileId', 'reasoningEffort', 'contextWindow', 'maxOutputTokens', 'timeoutSeconds', 'maxConcurrentRequests', 'supportsImages'])
    || !text(model.configId, 100) || !text(model.name, 200) || !text(model.modelId, 300) || !text(model.endpoint, 2000)
    || !['anthropic', 'openai', 'ollama', 'custom'].includes(model.provider) || !['local', 'cloud'].includes(model.kind)
    || !['apiKey', 'chatgpt'].includes(model.authMethod) || (model.chatgptProfileId !== undefined && (model.authMethod !== 'chatgpt' || !text(model.chatgptProfileId, 100)))
    || !['off', 'low', 'medium', 'high'].includes(model.reasoningEffort) || typeof model.supportsImages !== 'boolean'
    || ![model.contextWindow, model.maxOutputTokens, model.timeoutSeconds, model.maxConcurrentRequests].every(value => count(value) && value > 0)
    || model.fingerprint !== fingerprint(model)) throw new Error('Invalid reliability model.');
  if (model.endpoint !== '[invalid endpoint]') {
    const url = new URL(model.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.replace(/\/+$/, '') !== model.endpoint) throw new Error('Invalid reliability endpoint.');
  }
}

function validated(value: unknown): ReliabilityData {
  const data = value as ReliabilityData;
  if (!recordFields(data, ['version', 'visits', 'updatedAt']) || data.version !== 1 || !date(data.updatedAt) || !Array.isArray(data.visits) || data.visits.length > maxVisits) throw new Error('Invalid reliability history.');
  const ids = new Set<string>();
  for (const visit of data.visits) { validateVisit(visit); if (ids.has(visit.id)) throw new Error('Duplicate reliability visit.'); ids.add(visit.id); }
  return data;
}

async function readHistory(filePath: string): Promise<ReliabilityData> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) throw new Error('Invalid reliability history file.');
  const contents = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(contents, 'utf8') > maxFileBytes) throw new Error('Reliability history is too large.');
  return validated(JSON.parse(contents));
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  if (Buffer.byteLength(contents, 'utf8') > maxFileBytes) throw new Error('Reliability history is too large.');
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, filePath);
  } finally { await unlink(temporary).catch(() => {}); }
}

function toolSummary(): ReliabilityToolSummary {
  return { total: 0, completed: 0, outcomes: Object.fromEntries(reliabilityOutcomes.map(outcome => [outcome, 0])) as Record<ReliabilityOutcome, number>, successRate: null, averageDurationMs: null };
}

function addCall(summary: ReliabilityToolSummary, call: ReliabilityToolCall): void {
  summary.total++; summary.outcomes[call.outcome]++;
  if (!incomplete.has(call.outcome)) {
    summary.averageDurationMs = ((summary.averageDurationMs ?? 0) * summary.completed + call.durationMs) / ++summary.completed;
    summary.successRate = summary.outcomes.success / summary.completed;
  }
}

/** Optional telemetry must never fail a model visit. Failed writes remain visible through snapshot(). */
export class ReliabilityStore {
  private writes: Promise<void> = Promise.resolve();
  private storage: ReliabilitySnapshot['storage'];
  private durable: ReliabilityData;
  private constructor(readonly filePath: string, private data: ReliabilityData, private readonly recordingDisabled = false, message?: string) {
    this.durable = structuredClone(data);
    this.storage = message ? { healthy: false, message } : { healthy: true };
  }
  static async open(filePath: string): Promise<ReliabilityStore> {
    const empty: ReliabilityData = { version: 1, visits: [], updatedAt: new Date().toISOString() };
    try { return new ReliabilityStore(filePath, await readHistory(filePath)); }
    catch (primaryError) {
      try { return new ReliabilityStore(filePath, await readHistory(`${filePath}.bak`), false, 'Recovered reliability history from its last-good backup. The latest results may be missing.'); }
      catch (backupError) {
        if ((primaryError as NodeJS.ErrnoException).code === 'ENOENT' && (backupError as NodeJS.ErrnoException).code === 'ENOENT') return new ReliabilityStore(filePath, empty);
        return new ReliabilityStore(filePath, empty, true, 'Reliability history and its backup could not be validated. Recording is disabled; restore a valid history file and restart the server.');
      }
    }
  }
  async record(visit: ReliabilityVisit): Promise<void> {
    // Clone before queueing so later caller mutations cannot introduce private content.
    let copy: ReliabilityVisit;
    try { validateVisit(visit); copy = structuredClone(visit); }
    catch { this.storage = { healthy: false, message: 'A reliability result could not be recorded because its metadata was invalid.' }; return; }
    const write = this.writes.then(async () => {
      if (this.recordingDisabled || this.data.visits.some(item => item.id === copy.id)) return;
      this.data = { version: 1, visits: [...this.data.visits, copy].slice(-maxVisits), updatedAt: new Date().toISOString() };
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        // Only validated durable state is backed up, including after recovery or a failed primary write.
        await atomicWrite(`${this.filePath}.bak`, JSON.stringify(this.durable));
        await atomicWrite(this.filePath, JSON.stringify(this.data));
        this.durable = structuredClone(this.data);
        this.storage = { healthy: true };
      } catch { this.storage = { healthy: false, message: 'Reliability history could not be saved. New results are available in memory; check local storage.' }; }
    });
    this.writes = write;
    await write;
  }
  snapshot(): ReliabilitySnapshot {
    const groups = new Map<string, ModelReliabilitySummary>();
    for (const visit of this.data.visits) {
      const key = `${visit.model.fingerprint}:${visit.codeMode ? 'on' : 'off'}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, model: { ...visit.model }, codeMode: visit.codeMode, visits: 0,
          statuses: { success: 0, failed: 0, cancelled: 0, interrupted: 0 }, failures: { transient: 0, report: 0, configuration: 0, timeout: 0 }, modelFailures: 0,
          retryAttempts: 0, requests: 0, providerFailures: 0, reportRejections: 0, reportRepairs: 0,
          tools: toolSummary(), codeModeCalls: toolSummary(), byTool: {}, omittedCalls: 0, lastSeenAt: visit.finishedAt };
        groups.set(key, group);
      }
      group.visits++; group.statuses[visit.status]++; if (visit.status === 'failed') group.modelFailures++;
      if (visit.failure) group.failures[visit.failure]++;
      for (const counter of ['retryAttempts', 'requests', 'providerFailures', 'reportRejections', 'reportRepairs', 'omittedCalls'] as const) group[counter] += visit[counter];
      if (visit.finishedAt >= group.lastSeenAt) { group.lastSeenAt = visit.finishedAt; group.model = { ...visit.model }; }
      for (const call of visit.calls) {
        addCall(call.tool === 'codemode' ? group.codeModeCalls : group.tools, call);
        addCall(group.byTool[call.tool] ??= toolSummary(), call);
      }
    }
    const newest = [...this.data.visits].sort((first, second) => Date.parse(second.finishedAt) - Date.parse(first.finishedAt));
    return { version: 1, retention: { maxVisits: 1000, retainedVisits: this.data.visits.length,
      ...(this.data.visits.length ? { oldestAt: this.data.visits.reduce((oldest, visit) => visit.finishedAt < oldest ? visit.finishedAt : oldest, this.data.visits[0].finishedAt) } : {}) },
      models: [...groups.values()].sort((first, second) => Date.parse(second.lastSeenAt) - Date.parse(first.lastSeenAt)),
      recentVisits: structuredClone(newest.slice(0, 50)), storage: { ...this.storage }, updatedAt: this.data.updatedAt };
  }
  async flush(): Promise<void> { await this.writes; }
}
