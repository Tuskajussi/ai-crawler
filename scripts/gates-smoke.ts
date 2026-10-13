import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { createApp } from '../server/index';
import { makeAgent } from '../shared/defaults';
import { createTestAccount, signInPage, testRegistrationSecret } from './test-auth';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-gates-'));
const runtime = await createApp({ dataDir: temporary, registrationSecret: testRegistrationSecret, demoStepMs: 30 });
const account = await createTestAccount(runtime, 'gates-tester');
const { store } = account.workspace;
await store.update(state => {
  state.workflow.nodes = [{ id: 'worker', type: 'agent', position: { x: 0, y: 0 }, data: { ...makeAgent('custom', 'qwen'), label: 'Local reviewer' } }];
  state.workflow.edges = [];
  Object.assign(state.workflow.settings, { mode: 'once', executionMode: 'demo', entryNodeId: 'worker', continuous: false });
  state.runs = []; state.findings = []; state.messages = [];
});
const apiServer = runtime.app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => apiServer.once('listening', resolve));
const address = apiServer.address(); assert(address && typeof address !== 'string');
const reservation = reservePort();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const reserved = reservation.address(); assert(reserved && typeof reserved !== 'string');
await new Promise<void>(resolve => reservation.close(() => resolve()));
const vite = await createServer({ server: { host: '127.0.0.1', port: reserved.port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${address.port}` } } });
await vite.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
const browserErrors: string[] = [];
async function noOverflow(label: string) {
  assert(page);
  const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(dimensions.document <= dimensions.viewport + 1, `${label}: horizontal overflow ${JSON.stringify(dimensions)}`);
}
async function snapshot(name: string) {
  assert(page); await mkdir('.crawlspace/previews', { recursive: true });
  await page.screenshot({ path: `.crawlspace/previews/gates-${name}.png`, fullPage: false, animations: 'disabled' });
}
async function waitForRun(status: string, previousRunId?: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const latest = store.get().runs[0];
    if (latest?.status === status && latest.id !== previousRunId) return latest;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Run did not become ${status}: ${JSON.stringify(store.get().runs[0])}`);
}
try {
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${reserved.port}`);
  await signInPage(page, account);
  await page.locator('.react-flow__node[data-id="worker"]').click();
  await page.getByRole('button', { name: 'Add acceptance gate', exact: true }).click();
  await page.getByLabel('Node name', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Model', { exact: true }).count(), 0, 'Control nodes have no model selector');
  await page.getByLabel('Maximum corrections', { exact: true }).fill('2');
  await page.getByLabel('Impact of accepting this work', { exact: true }).selectOption('high-impact');
  assert.equal(await page.getByLabel('Approval', { exact: true }).isDisabled(), true, 'High-impact work requires human approval');
  await page.getByLabel('Impact of accepting this work', { exact: true }).selectOption('contained');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'All changes saved', exact: true }).waitFor();
  const workflow = store.get().workflow;
  const check = workflow.nodes.find(node => node.type === 'check');
  const gate = workflow.nodes.find(node => node.type === 'gate');
  assert(check && gate);
  assert.equal(workflow.edges.length, 2, 'Single action creates the complete agent-check-gate path');
  assert.equal(gate.data.gate?.maxCorrections, 2);
  await page.locator(`.react-flow__node[data-id="${check.id}"]`).click();
  assert.equal(await page.getByLabel('Require finding evidence', { exact: false }).isChecked(), true);
  await page.getByRole('button', { name: 'Workflow settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  await page.getByLabel('Constraint', { exact: true }).fill('Preserve adapter keyword arguments exactly. Evidence: accepted adapter review.');
  await page.getByLabel('Apply to all agents', { exact: true }).uncheck();
  await page.getByRole('group', { name: 'Agents for lesson 1', exact: true }).getByLabel('Local reviewer', { exact: true }).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Agents for lesson 1', exact: true }).getByLabel('Local reviewer', { exact: true }).isDisabled(), true, 'Removing the last scoped agent cannot silently apply a lesson to everyone');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workflow settings', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(store.get().workflow.settings.lessons?.[0].nodeIds, ['worker']);
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  const approval = page.getByRole('region', { name: 'Acceptance approval', exact: true });
  await approval.waitFor();
  assert.equal(store.get().runs[0]?.approval?.status, 'pending');
  await approval.getByText('Review reports and check results', { exact: true }).click();
  await approval.getByText('Local reviewer', { exact: true }).first().waitFor();
  await noOverflow('Desktop approval'); await snapshot('approval-desktop');
  await approval.getByRole('button', { name: 'Approve work', exact: true }).click();
  const accepted = await waitForRun('completed');
  assert.equal(accepted.approval?.status, 'approved');
  assert(accepted.outcomes?.some(outcome => outcome.nodeId === 'worker' && outcome.verdict === 'accepted'));
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Run history', exact: true }).click();
  await page.getByText('Acceptance outcomes', { exact: false }).first().click();
  await page.getByText('Human approval:', { exact: false }).first().waitFor();
  await noOverflow('Acceptance history'); await snapshot('history-desktop');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Workflow builder', exact: true }).click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await approval.waitFor();
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Run history', exact: true }).click();
  await page.getByRole('region', { name: 'Acceptance approval', exact: true }).getByRole('button', { name: 'Reject work', exact: true }).click();
  const rejected = await waitForRun('failed');
  assert.equal(rejected.approval?.status, 'rejected');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Workflow builder', exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${check.id}"]`).click();
  await store.update(state => { state.workflow.nodes.find(node => node.id === 'worker')!.data.role = 'crawler'; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Local runner ready', { exact: true }).waitFor();
  await page.locator(`.react-flow__node[data-id="${check.id}"]`).click();
  const previousRunId = store.get().runs[0]?.id;
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  const failed = await waitForRun('failed', previousRunId);
  assert.equal(failed.results?.filter(result => result.nodeId === 'worker').length, 3, 'Two correction attempts rerun only the failed agent');
  assert.equal(failed.approval, undefined, 'A failed check never offers a human override');
  await page.getByLabel('Require finding evidence', { exact: false }).uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'All changes saved', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`.react-flow__node[data-id="${check.id}"]`).click({ force: true });
  await page.getByRole('dialog', { name: 'Report check settings', exact: true }).waitFor();
  await noOverflow('Mobile check settings'); await snapshot('check-mobile');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Node library', exact: true });
  await library.getByRole('button', { name: 'Checks & gates', exact: true }).click();
  await library.getByRole('button', { name: 'Add report check', exact: true }).waitFor();
  await noOverflow('Mobile controls library'); await snapshot('library-mobile');
  await library.getByRole('button', { name: 'Add report check', exact: true }).click();
  await page.getByRole('dialog', { name: 'Report check settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Workflow settings', exact: true }).click();
  await page.getByLabel('Enable lesson 1', { exact: true }).uncheck();
  await noOverflow('Mobile lessons'); await snapshot('lessons-mobile');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workflow settings', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(store.get().workflow.settings.lessons?.[0].enabled, false);
  assert.deepEqual(browserErrors, [], 'No browser runtime errors');
  console.log('Gate UI smoke passed: complete acceptance path, model-free controls, high-impact approval, scoped lessons, approve/reject, bounded correction, failed-check override prevention, outcome history, controls library and mobile layouts.');
} catch (failure) {
  await snapshot('failure').catch(() => {});
  if (page) console.error('Gate smoke context:', { dialogs: await page.getByRole('dialog').allTextContents(), alerts: await page.getByRole('alert').allTextContents(), runs: store.get().runs });
  throw failure;
} finally {
  await browser?.close(); await vite.close(); await runtime.shutdown();
  await new Promise<void>(resolve => apiServer.close(() => resolve()));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith('crawlspace-gates-'));
  await rm(temporary, { recursive: true, force: true });
}
