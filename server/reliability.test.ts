import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../shared/types';
import type { ReliabilityVisit } from '../shared/reliability';
import { ReliabilityStore, ReliabilityVisitTracker } from './reliability';

const config: ModelConfig = { id: 'local-model', name: 'Local model', provider: 'custom', kind: 'local', modelId: 'model-a', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'PRIVATE_KEY_ENV', enabled: true };
function tracker(model: ModelConfig = config, codeMode = true) {
  let milliseconds = Date.parse('2026-10-12T10:00:00.000Z');
  const tracking = new ReliabilityVisitTracker(model, { runId: 'run-one', nodeId: 'reviewer', cycle: 1, codeMode }, () => milliseconds);
  return { tracking, advance: (elapsed = 10) => { milliseconds += elapsed; } };
}
const start = (tracking: ReliabilityVisitTracker, id: string, tool = 'project_read') => tracking.observe({ type: 'tool_execution_start', toolCallId: id, toolName: tool, args: { path: 'PRIVATE_ARGUMENT' } });
const end = (tracking: ReliabilityVisitTracker, id: string, error?: string, durationMs?: number, cancelled = false) => tracking.observe({ type: 'tool_execution_end', toolCallId: id, toolName: 'PRIVATE_EVENT_NAME', isError: error !== undefined, durationMs,
  result: { content: [{ type: 'text', text: error ?? 'PRIVATE_RESULT' }] } }, cancelled);
function visit(id = 'visit-one', model: ModelConfig = config, codeMode = true): ReliabilityVisit {
  const { tracking } = tracker(model, codeMode);
  tracking.nextAttempt(); tracking.request();
  return { ...tracking.finish('success'), id };
}
async function fixture(action: (store: ReliabilityStore, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-reliability-'));
  try { const file = path.join(directory, 'reliability.json'); await action(await ReliabilityStore.open(file), file); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('tool classifications distinguish malformed arguments from failures after execution without persisting private content', () => {
  const { tracking, advance } = tracker();
  tracking.nextAttempt(); tracking.request();
  start(tracking, 'id-PRIVATE_SECRET'); advance(25); end(tracking, 'id-PRIVATE_SECRET');
  start(tracking, 'invalid'); end(tracking, 'invalid', 'Validation failed for tool "project_read": PRIVATE_ARGUMENT');
  start(tracking, 'execution'); tracking.executed('execution'); end(tracking, 'execution', 'Validation failed for tool "project_read": PRIVATE_EXCEPTION', 18);
  start(tracking, 'unknown-PRIVATE_ID', 'PRIVATE_TOOL_NAME'); end(tracking, 'unknown-PRIVATE_ID', 'Tool PRIVATE_TOOL_NAME not found');
  start(tracking, 'disabled'); end(tracking, 'disabled', 'Tool project_read not found');
  start(tracking, 'truncated'); end(tracking, 'truncated', 'Tool call "project_read" was not executed: the response hit the output token limit, so PRIVATE_ARGUMENT');
  start(tracking, 'code', 'codemode'); end(tracking, 'code', 'Script failed\nOutput:\nScript error:\nPRIVATE_CODE');
  start(tracking, 'code-invalid', 'codemode'); end(tracking, 'code-invalid', 'Validation failed for tool "codemode": PRIVATE_CODE');
  start(tracking, 'blocked'); tracking.blocked('blocked'); end(tracking, 'blocked', 'PRIVATE_BLOCK_REASON');
  const result = tracking.finish('success');
  assert.deepEqual(result.calls.map(call => call.outcome), ['success', 'invalid_arguments', 'execution_error', 'unknown_tool', 'unknown_tool', 'truncated', 'code_error', 'invalid_arguments', 'blocked']);
  assert.equal(result.calls[0].durationMs, 25);
  assert.equal(result.calls[2].durationMs, 18);
  assert.equal(result.calls[3].tool, '[unknown tool]');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(result.requests, 1);
});

test('duplicate events are ignored while completed IDs can be reused by later requests', () => {
  const { tracking } = tracker();
  tracking.nextAttempt(); tracking.request();
  start(tracking, 'same'); start(tracking, 'same'); end(tracking, 'same'); end(tracking, 'same');
  tracking.request(); start(tracking, 'same'); end(tracking, 'same');
  const finished = tracking.finish('success');
  assert.equal(finished.calls.length, 2);
  tracking.request(); start(tracking, 'late'); end(tracking, 'late');
  assert.deepEqual(tracking.finish('failed', 'configuration'), finished, 'Finishing twice must not record a second visit or late SDK events');
  finished.calls.length = 0;
  assert.equal(tracking.finish('success').calls.length, 2, 'Returned values must not mutate the tracker');
});

test('retry and session endings settle unfinished calls without inflating success counts', () => {
  const { tracking, advance } = tracker();
  tracking.nextAttempt(); tracking.request(); start(tracking, 'reused'); advance(30);
  tracking.providerFailure(); tracking.nextAttempt(); tracking.request();
  start(tracking, 'reused'); end(tracking, 'reused');
  tracking.reportRejected(); tracking.reportRepair(); tracking.request(); start(tracking, 'unfinished');
  const finished = tracking.finish('cancelled');
  assert.deepEqual(finished.calls.map(call => call.outcome), ['interrupted', 'success', 'cancelled']);
  assert.equal(finished.retryAttempts, 1);
  assert.equal(finished.requests, 3);
  assert.equal(finished.providerFailures, 1);
  assert.equal(finished.reportRejections, 1);
  assert.equal(finished.reportRepairs, 1);
  assert.equal(finished.calls[0].durationMs, 30);
  const next = tracker().tracking; start(next, 'unfinished');
  assert.equal(next.finish('success').calls[0].outcome, 'interrupted', 'A successful report does not establish that unfinished tools succeeded');
});

test('host cancellation classifies opaque error results but preserves previously completed successes', () => {
  const { tracking } = tracker();
  start(tracking, 'ok'); end(tracking, 'ok', undefined, 10, true);
  start(tracking, 'failed', 'codemode'); end(tracking, 'failed', 'PRIVATE_OPAQUE_EXCEPTION', 10, true);
  start(tracking, 'abort'); end(tracking, 'abort', 'Operation aborted');
  start(tracking, 'budget', 'codemode'); tracking.blocked('budget'); end(tracking, 'budget', 'Script failed', 10, true);
  const result = tracking.finish('failed', 'timeout');
  assert.deepEqual(result.calls.map(call => call.outcome), ['success', 'cancelled', 'cancelled', 'blocked']);
  assert.equal(result.failure, 'timeout');
});

test('tracker bounds retained calls and reports omission explicitly', () => {
  const { tracking } = tracker();
  for (let index = 0; index < 300; index++) { start(tracking, String(index)); end(tracking, String(index)); }
  const result = tracking.finish('success');
  assert.equal(result.calls.length, 256);
  assert.equal(result.omittedCalls, 44);
});

test('summary keeps Code Mode wrappers separate and exposes meaningful rate denominators and durations', async () => fixture(async store => {
  const { tracking } = tracker();
  tracking.nextAttempt(); tracking.request();
  start(tracking, 'success'); end(tracking, 'success', undefined, 20);
  start(tracking, 'invalid'); end(tracking, 'invalid', 'Validation failed for tool "project_read"', 0);
  start(tracking, 'blocked'); tracking.blocked('blocked'); end(tracking, 'blocked', 'Blocked', 1000);
  start(tracking, 'cancelled'); end(tracking, 'cancelled', 'Operation aborted', 1000);
  start(tracking, 'code', 'codemode'); end(tracking, 'code', undefined, 40);
  start(tracking, 'pending');
  await store.record(tracking.finish('failed', 'report'));
  const summary = store.snapshot().models[0];
  assert.equal(summary.visits, 1); assert.equal(summary.modelFailures, 1); assert.equal(summary.failures.report, 1);
  assert.equal(summary.tools.total, 5); assert.equal(summary.tools.completed, 2);
  assert.equal(summary.tools.successRate, 0.5); assert.equal(summary.tools.averageDurationMs, 10);
  assert.equal(summary.codeModeCalls.total, 1); assert.equal(summary.codeModeCalls.successRate, 1); assert.equal(summary.codeModeCalls.averageDurationMs, 40);
  assert.equal(summary.byTool.project_read?.outcomes.interrupted, 1);
  assert.equal(summary.requests, 1);
  await store.record(visit('empty', { ...config, modelId: 'different' }));
  const empty = store.snapshot().models.find(model => model.model.modelId === 'different')!;
  assert.equal(empty.tools.successRate, null); assert.equal(empty.tools.averageDurationMs, null);
}));

test('grouping normalizes endpoints and defaults while separating execution settings and effective profiles', async () => fixture(async store => {
  await store.record(visit('one'));
  await store.record(visit('renamed', { ...config, name: 'Renamed model', baseUrl: 'http://127.0.0.1:8080/v1/', apiKeyEnv: 'DIFFERENT_PRIVATE_ENV', contextWindow: 32768, maxOutputTokens: 8192, reasoningEffort: 'off', maxConcurrentRequests: 1, supportsImages: false, timeoutSeconds: 180 }));
  assert.equal(store.snapshot().models.length, 1);
  assert.equal(store.snapshot().models[0].visits, 2);
  await store.record(visit('different-config-id', { ...config, id: 'different-quantization' }));
  for (const [id, change] of [
    ['reasoning', { reasoningEffort: 'high' }], ['context', { contextWindow: 65536 }], ['output', { maxOutputTokens: 1024 }],
    ['endpoint', { baseUrl: 'http://192.168.1.2:8080/v1' }], ['model', { modelId: 'different' }], ['timeout', { timeoutSeconds: 300 }],
  ] as const) await store.record(visit(id, { ...config, ...change }));
  await store.record(visit('code-off', config, false));
  const cloud: ModelConfig = { ...config, provider: 'openai', kind: 'cloud', baseUrl: '', authMethod: 'chatgpt', chatgptProfileId: 'profile-one' };
  await store.record(visit('profile-one', cloud));
  await store.record(visit('profile-two', { ...cloud, chatgptProfileId: 'profile-two' }));
  assert.equal(store.snapshot().models.length, 11);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE_ENV|PRIVATE_KEY_ENV/);
}));

test('concurrent recording is durable, idempotent, and independent of mutable caller/snapshot objects', async () => fixture(async (store, file) => {
  const original = visit('mutable');
  const queued = store.record(original);
  original.calls.push({ tool: 'project_read', outcome: 'execution_error', durationMs: 5 });
  await Promise.all([queued, ...Array.from({ length: 24 }, (_, index) => store.record(visit(`parallel-${index}`)))]);
  await store.record(visit('mutable'));
  await store.flush();
  assert.equal(store.snapshot().retention.retainedVisits, 25);
  assert.equal(store.snapshot().recentVisits.find(item => item.id === 'mutable')?.calls.length, 0);
  const snapshot = store.snapshot(); snapshot.recentVisits.length = 0; snapshot.models[0].model.name = 'Must not leak mutation';
  assert.equal(store.snapshot().recentVisits.length, 25);
  assert.notEqual(store.snapshot().models[0].model.name, 'Must not leak mutation');
  assert.deepEqual((await ReliabilityStore.open(file)).snapshot(), store.snapshot());
  assert.doesNotMatch(await readFile(file, 'utf8'), /PRIVATE_KEY_ENV/);
}));

test('retention and summaries use only the last 1000 visits while recent visits are sorted by finish time', async () => fixture(async (_store, file) => {
  const baseline = visit('template');
  const visits = Array.from({ length: 1000 }, (_, index) => ({ ...baseline, id: `old-${index}`, model: baseline.model,
    finishedAt: new Date(Date.parse(baseline.finishedAt) + index * 1000).toISOString(), status: index === 0 ? 'failed' as const : 'success' as const }));
  await writeFile(file, JSON.stringify({ version: 1, visits, updatedAt: baseline.finishedAt }));
  const store = await ReliabilityStore.open(file);
  await store.record({ ...visit('new-one'), finishedAt: new Date(Date.parse(baseline.finishedAt) + 1001 * 1000).toISOString() });
  await store.record({ ...visit('new-two'), finishedAt: new Date(Date.parse(baseline.finishedAt) + 1002 * 1000).toISOString() });
  const snapshot = store.snapshot();
  assert.equal(snapshot.retention.retainedVisits, 1000);
  assert.equal(snapshot.models[0].visits, 1000);
  assert.equal(snapshot.models[0].modelFailures, 0, 'Retired failed visits must not remain in aggregates');
  assert.equal(snapshot.recentVisits.length, 50);
  assert.deepEqual(snapshot.recentVisits.slice(0, 2).map(item => item.id), ['new-two', 'new-one']);
  assert.equal(snapshot.retention.oldestAt, visits[2].finishedAt);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).visits.length, 1000);
}));

test('corrupt primary recovers its validated backup without backing up corrupt bytes', async () => fixture(async (store, file) => {
  await store.record(visit('last-good')); await store.record(visit('latest'));
  await writeFile(file, '{PRIVATE_CORRUPT_PRIMARY');
  const recovered = await ReliabilityStore.open(file);
  assert.equal(recovered.snapshot().retention.retainedVisits, 1);
  assert.equal(recovered.snapshot().storage.healthy, false);
  assert.match(recovered.snapshot().storage.message ?? '', /Recovered/);
  await recovered.record(visit('after-recovery'));
  assert.equal(recovered.snapshot().storage.healthy, true);
  assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).visits[0].id, 'last-good');
  assert.doesNotMatch(await readFile(`${file}.bak`, 'utf8'), /PRIVATE_CORRUPT/);
}));

test('unrecoverable history disables recording without overwriting either copy or exposing raw errors', async () => fixture(async (_store, file) => {
  await writeFile(file, '{PRIVATE_SECRET_PRIMARY'); await writeFile(`${file}.bak`, '{PRIVATE_SECRET_BACKUP');
  const store = await ReliabilityStore.open(file);
  await store.record(visit('must-not-replace-history')); await store.flush();
  assert.equal(store.snapshot().storage.healthy, false);
  assert.match(store.snapshot().storage.message ?? '', /Recording is disabled/);
  assert.equal(store.snapshot().retention.retainedVisits, 0);
  assert.equal(await readFile(file, 'utf8'), '{PRIVATE_SECRET_PRIMARY');
  assert.equal(await readFile(`${file}.bak`, 'utf8'), '{PRIVATE_SECRET_BACKUP');
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE_SECRET/);
}));

test('write failures do not fail agents and a later successful write persists retained in-memory results', async () => fixture(async (store, file) => {
  await store.record(visit('saved'));
  await rm(file); await mkdir(file);
  await store.record(visit('memory-only')); await store.flush();
  assert.equal(store.snapshot().storage.healthy, false);
  assert.equal(store.snapshot().retention.retainedVisits, 2);
  const recovered = await ReliabilityStore.open(file);
  assert.equal(recovered.snapshot().recentVisits[0].id, 'saved');
  await rm(file, { recursive: true });
  await store.record(visit('storage-restored'));
  assert.equal(store.snapshot().storage.healthy, true);
  assert.equal((await ReliabilityStore.open(file)).snapshot().retention.retainedVisits, 3);
}));

test('strict stored schema rejects unexpected private fields, fabricated outcomes and corrupt grouping fingerprints', async () => fixture(async (_store, file) => {
  for (const mutate of [
    (value: any) => { value.visits[0].prompt = 'PRIVATE_PROMPT'; },
    (value: any) => { value.visits[0].model.apiKey = 'PRIVATE_KEY'; },
    (value: any) => { value.visits[0].model.fingerprint = '0'.repeat(64); },
    (value: any) => { value.visits[0].calls = [{ tool: 'PRIVATE_TOOL_NAME', outcome: 'success', durationMs: 0 }]; },
    (value: any) => { value.visits[0].calls = [{ tool: 'project_read', outcome: 'fabricated', durationMs: 0 }]; },
  ]) {
    const data = { version: 1, visits: [visit()], updatedAt: new Date().toISOString() }; mutate(data);
    await writeFile(file, JSON.stringify(data));
    const store = await ReliabilityStore.open(file);
    assert.equal(store.snapshot().storage.healthy, false);
    assert.equal(store.snapshot().retention.retainedVisits, 0);
    assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE_/);
  }
}));

test('invalid runtime telemetry is refused without throwing or retaining unexpected private fields', async () => fixture(async store => {
  const invalid = { ...visit(), error: 'PRIVATE_ERROR' };
  await store.record(invalid);
  assert.equal(store.snapshot().storage.healthy, false);
  assert.equal(store.snapshot().retention.retainedVisits, 0);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE_ERROR/);
  await store.record(visit('valid'));
  assert.equal(store.snapshot().storage.healthy, true);
}));
