import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { createApp } from '../server/index';
import { createTestAccount, signInPage, testRegistrationSecret } from './test-auth';
import { ReliabilityVisitTracker } from '../server/reliability';
import type { ModelConfig } from '../shared/types';
import { reliabilityOutcomes, type ModelReliabilitySummary, type ReliabilityModel, type ReliabilitySnapshot, type ReliabilityToolCall, type ReliabilityToolName, type ReliabilityToolSummary, type ReliabilityVisit } from '../shared/reliability';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-reliability-ui-'));
const runtime = await createApp({ dataDir: temporary, registrationSecret: testRegistrationSecret });
const { app, shutdown } = runtime;
const account = await createTestAccount(runtime, 'reliability-tester');
const { reliability } = account.workspace;
const apiServer = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => apiServer.once('listening', resolve));
const apiAddress = apiServer.address(); assert(apiAddress && typeof apiAddress !== 'string');
const vite = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiAddress.port}` } } });
await vite.listen();
const viteAddress = vite.httpServer?.address(); assert(viteAddress && typeof viteAddress !== 'string');

function toolSummary(calls: ReliabilityToolCall[]): ReliabilityToolSummary {
  const outcomes = Object.fromEntries(reliabilityOutcomes.map(outcome => [outcome, 0])) as ReliabilityToolSummary['outcomes'];
  for (const call of calls) outcomes[call.outcome]++;
  const completed = calls.length - outcomes.blocked - outcomes.cancelled - outcomes.interrupted;
  return { total: calls.length, completed, outcomes, successRate: completed ? outcomes.success / completed : null, averageDurationMs: calls.length ? calls.reduce((sum, call) => sum + call.durationMs, 0) / calls.length : null };
}
const call = (tool: ReliabilityToolName, outcome: ReliabilityToolCall['outcome']): ReliabilityToolCall => ({ tool, outcome, durationMs: 20 });
const model = (fingerprint: string, patch: Partial<ReliabilityModel> = {}): ReliabilityModel => ({ fingerprint: fingerprint.repeat(64), configId: `model-${fingerprint}`, name: 'Strata local', provider: 'custom', kind: 'local', modelId: 'qwen-strata', endpoint: 'http://192.168.1.20:8080/v1', authMethod: 'apiKey', reasoningEffort: 'off', contextWindow: 32768, maxOutputTokens: 4096, timeoutSeconds: 180, maxConcurrentRequests: 1, supportsImages: false, ...patch });
const first = model('a');
const second = model('b', { endpoint: 'http://192.168.1.21:8080/v1', reasoningEffort: 'high', maxOutputTokens: 8192 });
const cloud = model('c', { name: 'Cloud reviewer', provider: 'openai', kind: 'cloud', modelId: 'cloud-review-model', endpoint: 'ChatGPT subscription', authMethod: 'chatgpt', supportsImages: true });
const firstCalls = [call('project_read', 'success'), call('project_read', 'invalid_arguments'), call('project_find', 'execution_error'), call('project_ls', 'success'), call('[unknown tool]', 'unknown_tool'), call('capture_ui', 'blocked'), call('capture_ui', 'cancelled')];
const secondCalls = [call('project_grep', 'success'), call('project_grep', 'success'), call('project_grep', 'truncated'), call('codemode', 'success'), call('codemode', 'code_error'), call('codemode', 'interrupted')];
const cloudCalls = [call('codemode', 'success')];
function group(model: ReliabilityModel, codeMode: boolean, calls: ReliabilityToolCall[], patch: Partial<ModelReliabilitySummary> = {}): ModelReliabilitySummary {
  const byTool: ModelReliabilitySummary['byTool'] = {};
  for (const name of new Set(calls.map(call => call.tool))) byTool[name] = toolSummary(calls.filter(call => call.tool === name));
  return { key: `${model.fingerprint}:${codeMode}`, model, codeMode, visits: 1, statuses: { success: 1, failed: 0, cancelled: 0, interrupted: 0 }, failures: { transient: 0, report: 0, configuration: 0, timeout: 0 }, modelFailures: 0, retryAttempts: 0, requests: 1, providerFailures: 0, reportRejections: 0, reportRepairs: 0, tools: toolSummary(calls.filter(call => call.tool !== 'codemode')), codeModeCalls: toolSummary(calls.filter(call => call.tool === 'codemode')), byTool, omittedCalls: 0, lastSeenAt: new Date().toISOString(), ...patch };
}
const groups = [
  group(first, false, firstCalls, { visits: 4, statuses: { success: 2, failed: 1, cancelled: 1, interrupted: 0 }, failures: { transient: 1, report: 0, configuration: 0, timeout: 0 }, modelFailures: 1, retryAttempts: 2, requests: 6, providerFailures: 1, reportRejections: 2, reportRepairs: 1, omittedCalls: 3 }),
  group(second, true, secondCalls, { visits: 3, statuses: { success: 1, failed: 1, cancelled: 0, interrupted: 1 }, failures: { transient: 0, report: 1, configuration: 0, timeout: 0 }, modelFailures: 1, retryAttempts: 1, requests: 4 }),
  group(cloud, true, cloudCalls),
];
const visit = (id: string, model: ReliabilityModel, codeMode: boolean, nodeId: string, calls: ReliabilityToolCall[], patch: Partial<ReliabilityVisit> = {}): ReliabilityVisit => ({ id, model, runId: `run-${id}-fixture`, nodeId, cycle: 2, source: 'workflow', codeMode, status: 'success', startedAt: new Date(Date.now() - 6000).toISOString(), finishedAt: new Date().toISOString(), durationMs: 6000, retryAttempts: 0, requests: 1, providerFailures: 0, reportRejections: 0, reportRepairs: 0, calls, omittedCalls: 0, ...patch });
const seeded: ReliabilitySnapshot = { version: 1, retention: { maxVisits: 1000, retainedVisits: 8, oldestAt: new Date(Date.now() - 86400000).toISOString() }, models: groups, recentVisits: [visit('recent-cloud', cloud, true, 'reviewer', cloudCalls), visit('recent-second', second, true, 'tester', secondCalls, { status: 'interrupted' }), visit('recent-first', first, false, 'crawler', firstCalls, { status: 'failed', failure: 'transient', retryAttempts: 2, providerFailures: 1, reportRejections: 2, reportRepairs: 1 })], storage: { healthy: true }, updatedAt: new Date().toISOString() };
const empty: ReliabilitySnapshot = { version: 1, retention: { maxVisits: 1000, retainedVisits: 0 }, models: [], recentVisits: [], storage: { healthy: true }, updatedAt: new Date().toISOString() };

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
try {
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let phase: 'empty' | 'seeded' | 'error' | 'storage' = 'empty';
  let requests = 0;
  await page.route('**/api/reliability', async route => {
    requests++; assert.equal(route.request().method(), 'GET', 'Reliability history is read-only');
    if (phase === 'error') await route.fulfill({ status: 503, json: { error: 'History fixture temporarily unavailable.' } });
    else if (phase === 'storage') await route.fulfill({ json: { ...seeded, storage: { healthy: false, message: 'A local history write failed. Counts may be incomplete.' } } });
    else await route.fulfill({ json: phase === 'empty' ? empty : seeded });
  });
  await mkdir('.crawlspace/previews', { recursive: true });
  await page.goto(`http://127.0.0.1:${viteAddress.port}`, { waitUntil: 'domcontentloaded' });
  await signInPage(page, account);
  const nav = page.getByRole('button', { name: 'Tool reliability', exact: true });
  await nav.click();
  await page.getByRole('heading', { name: 'No measured visits yet', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Observed totals', { exact: true }).count(), 0, 'Empty history does not invent scores');
  await page.screenshot({ path: '.crawlspace/previews/reliability-empty.png', fullPage: true });
  const refresh = page.getByRole('button', { name: 'Refresh history', exact: true });
  phase = 'seeded'; await refresh.click();
  await page.getByLabel('Observed totals', { exact: true }).waitFor();
  assert.equal(await page.locator('.reliability-model').count(), 3, 'The same model on different endpoints remains separate');
  const totals = page.getByLabel('Observed totals', { exact: true });
  assert.equal(await totals.locator('article').filter({ has: page.getByText('Measured visits', { exact: true }) }).locator('strong').innerText(), '8');
  assert.equal(await totals.locator('article').filter({ has: page.getByText('Tool success', { exact: true }) }).locator('strong').innerText(), '50.0%');
  assert.equal(await totals.locator('article').filter({ has: page.getByText('Code Mode success', { exact: true }) }).locator('strong').innerText(), '66.7%');
  await totals.getByText('4 / 8 finished calls', { exact: true }).waitFor();
  await totals.getByText('2 / 3 finished calls', { exact: true }).waitFor();
  const firstCard = page.getByRole('article', { name: 'Strata local, configuration aaaaaaaa, Code Mode off', exact: true });
  await firstCard.getByText(first.endpoint, { exact: true }).waitFor();
  await firstCard.locator('summary').filter({ hasText: 'Tool outcomes' }).click();
  await firstCard.getByText('Invalid arguments', { exact: true }).waitFor();
  await firstCard.getByText('Tool or service error', { exact: true }).waitFor();
  await firstCard.getByText('Blocked', { exact: true }).waitFor();
  await firstCard.getByText('Cancelled', { exact: true }).last().waitFor();
  await firstCard.locator('summary').filter({ hasText: 'Execution settings' }).click();
  await firstCard.getByText('Visit time limit', { exact: true }).waitFor();
  await firstCard.getByText('Standard endpoint', { exact: true }).waitFor();
  const secondCard = page.getByRole('article', { name: 'Strata local, configuration bbbbbbbb, Code Mode on', exact: true });
  await secondCard.locator('summary').filter({ hasText: 'Tool outcomes' }).click();
  await secondCard.getByText('Code error', { exact: true }).waitFor();
  await secondCard.getByText('Output limit reached', { exact: true }).waitFor();
  await secondCard.getByText('Interrupted', { exact: true }).last().waitFor();
  await page.locator('.reliability-recent').getByText('Scout', { exact: true }).waitFor();
  await page.locator('.reliability-recent').getByText('Visit failure: Provider error', { exact: true }).waitFor();
  await page.screenshot({ path: '.crawlspace/previews/reliability-desktop.png', fullPage: true });
  await page.getByLabel('Model configuration', { exact: true }).selectOption(groups[1].key);
  assert.equal(await page.locator('.reliability-model').count(), 1);
  assert.equal(await page.locator('.reliability-visit').count(), 1, 'Recent visits follow the selected model and Code Mode configuration');
  assert.equal(await totals.locator('article').filter({ has: page.getByText('Measured visits', { exact: true }) }).locator('strong').innerText(), '3');
  await page.getByLabel('Model configuration', { exact: true }).selectOption('all');

  phase = 'error'; await refresh.click();
  await page.getByRole('alert').getByText('Could not refresh reliability history.', { exact: true }).waitFor();
  await page.getByText(/Showing the last successful snapshot from/).waitFor();
  assert.equal(await page.locator('.reliability-model').count(), 3, 'A failed refresh preserves the last successful snapshot');
  await page.screenshot({ path: '.crawlspace/previews/reliability-stale.png', fullPage: true });
  phase = 'storage'; await refresh.click();
  await page.getByRole('alert').getByText('History storage needs attention.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Could not refresh reliability history.', { exact: true }).count(), 0, 'A successful refresh clears stale request errors');
  phase = 'seeded'; await refresh.click();
  await page.waitForFunction(() => document.querySelectorAll('.reliability-error').length === 0);
  const beforePoll = requests;
  await page.waitForFunction(() => !!document.querySelector('.reliability-panel'));
  const pollDeadline = Date.now() + 8000;
  while (requests === beforePoll && Date.now() < pollDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(requests > beforePoll, 'History refreshes while the panel is mounted');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.crawlspace/previews/reliability-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Reliability layout fits a mobile screen');
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.getByRole('button', { name: 'Workflow builder', exact: true }).click();
  const afterUnmount = requests;
  await page.waitForTimeout(5600);
  assert.equal(requests, afterUnmount, 'Reliability polling stops when navigating away');
  phase = 'error'; await nav.click();
  await page.getByRole('heading', { name: 'History is unavailable', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Observed totals', { exact: true }).count(), 0, 'Initial load errors do not invent scores');
  phase = 'empty'; await refresh.click();
  await page.getByRole('heading', { name: 'No measured visits yet', exact: true }).waitFor();
  const recordedModel: ModelConfig = { id: 'recorded-ui-model', name: 'Recorded local model', provider: 'custom', kind: 'local', modelId: 'recorded-model', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: '', enabled: true };
  const tracker = new ReliabilityVisitTracker(recordedModel, { runId: 'real-api-ui-visit', nodeId: 'crawler', cycle: 1, codeMode: false });
  tracker.nextAttempt(); tracker.request();
  tracker.observe({ type: 'tool_execution_start', toolCallId: 'ui-visit-call', toolName: 'project_read', args: { path: 'PRIVATE_UI_ARGUMENT' } });
  tracker.executed('ui-visit-call');
  tracker.observe({ type: 'tool_execution_end', toolCallId: 'ui-visit-call', isError: false, durationMs: 12, result: { content: [{ type: 'text', text: 'PRIVATE_UI_RESULT' }] } });
  await reliability.record(tracker.finish('success')); await reliability.flush();
  await page.unroute('**/api/reliability');
  await refresh.click();
  await page.getByRole('heading', { name: 'Recorded local model', exact: true }).waitFor();
  const actualTotals = page.getByLabel('Observed totals', { exact: true });
  await actualTotals.getByText('1 / 1 finished calls', { exact: true }).waitFor();
  assert.equal(await actualTotals.locator('article').filter({ has: page.getByText('Tool success', { exact: true }) }).locator('strong').innerText(), '100.0%');
  assert.equal(await page.locator('.reliability-visit').count(), 1, 'Actual API returns the durably recorded visit');
  const durable = await readFile(reliability.filePath, 'utf8');
  assert.match(durable, /Recorded local model/); assert.doesNotMatch(durable, /PRIVATE_UI_ARGUMENT|PRIVATE_UI_RESULT/);
  await page.screenshot({ path: '.crawlspace/previews/reliability-api.png', fullPage: true });
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Reliability UI smoke passed: empty/error states without fake scores, endpoint/config groups, exact denominators, tool/Code Mode separation, failure categories, filters/recent visits, refresh/stale/storage recovery, polling cleanup and mobile layout. An unmocked API phase verifies the actual tracker/store/dashboard contract and durable metadata without storing private tool content. No models were called.');
} catch (failure) {
  await page?.screenshot({ path: '.crawlspace/previews/reliability-failure.png', fullPage: true });
  throw failure;
} finally {
  await browser?.close(); await vite.close(); await shutdown();
  await new Promise<void>(resolve => apiServer.close(() => resolve()));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith('crawlspace-reliability-ui-'));
  await rm(temporary, { recursive: true, force: true });
}
