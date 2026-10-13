import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { createApp } from '../server/index';
import { makeAgent } from '../shared/defaults';
import { makeControlNode } from '../shared/controls';
import { createTestAccount, signInPage, testRegistrationSecret } from './test-auth';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-project-ui-'));
const projectFolder = path.join(temporary, 'existing-project');
await mkdir(projectFolder);
await writeFile(path.join(projectFolder, 'example.ts'), 'export const value = 1;\n', 'utf8');
const runtime = await createApp({ dataDir: path.join(temporary, 'private-data'), registrationSecret: testRegistrationSecret });
const account = await createTestAccount(runtime, 'project-tester');
const { store } = account.workspace;
await store.update(state => {
  state.workflow.nodes = [{ id: 'worker', type: 'agent', position: { x: 0, y: 0 }, data: { ...makeAgent('custom', 'qwen'), label: 'Project worker' } }];
  state.workflow.edges = [];
  Object.assign(state.workflow.settings, { entryNodeId: 'worker', mode: 'once', executionMode: 'demo', continuous: false });
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
const errors: string[] = [];
async function screenshot(name: string) { assert(page); await mkdir('.crawlspace/previews', { recursive: true }); await page.screenshot({ path: `.crawlspace/previews/project-${name}.png`, fullPage: false, animations: 'disabled' }); }
async function noOverflow(label: string) { assert(page); const size = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth })); assert(size.document <= size.viewport + 1, `${label}: ${JSON.stringify(size)}`); }
async function navigate(name: string) {
  assert(page);
  if ((page.viewportSize()?.width ?? 1512) <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name, exact: true }).click();
}
try {
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${reserved.port}`); await signInPage(page, account);
  await page.locator('.react-flow__node[data-id="worker"]').click();
  assert.equal(await page.getByLabel('Edit project files', { exact: true }).isDisabled(), true, 'Project permission must be enabled before per-agent editing');
  assert.equal(await page.getByLabel('Run configured tests', { exact: true }).isDisabled(), true, 'Project permission must be enabled before per-agent tests');
  await page.getByRole('button', { name: 'Open Project settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Project settings', exact: true }).waitFor();
  await page.getByLabel('Project folder path', { exact: true }).fill(projectFolder);
  await page.getByRole('button', { name: 'Validate folder', exact: true }).click();
  await page.locator('.project-success').waitFor();
  assert.match(await page.locator('.project-success').innerText(), /folder|project|ready|valid/i);
  await page.getByLabel('UI preview URL', { exact: true }).fill('http://127.0.0.1:5173');
  await page.getByLabel('Allow agents to edit project files', { exact: false }).check();
  await page.getByLabel('Allow agents to run configured tests', { exact: false }).check();
  await page.getByRole('button', { name: 'Add test command', exact: true }).click();
  await page.getByLabel('Test name', { exact: true }).fill('Unit tests');
  await page.getByLabel('Command', { exact: true }).fill('npm test');
  await page.getByLabel('Timeout (seconds)', { exact: true }).fill('120');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/project') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  assert.equal((await saved).ok(), true);
  await page.getByText('Project settings saved. All agents use this folder.', { exact: true }).waitFor();
  assert.equal(store.get().project?.path, projectFolder);
  assert.equal(store.get().project?.allowEdits, true); assert.equal(store.get().project?.allowTests, true);
  assert.deepEqual(store.get().project?.testCommands.map(command => ({ name: command.name, command: command.command, timeout: command.timeoutSeconds })), [{ name: 'Unit tests', command: 'npm test', timeout: 120 }]);
  await noOverflow('Desktop project'); await screenshot('settings-desktop');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText('Local runner ready', { exact: true }).waitFor();
  await navigate('Project settings');
  assert.equal(await page.getByLabel('Project folder path', { exact: true }).inputValue(), projectFolder, 'Existing project selection persists after reload');
  await page.getByRole('button', { name: 'Add test command', exact: true }).click();
  await page.getByRole('button', { name: 'Remove test command 2', exact: true }).click();
  await navigate('Workflow builder');
  await page.locator('.react-flow__node[data-id="worker"]').click();
  await page.getByLabel('Edit project files', { exact: true }).check();
  await page.getByLabel('Run configured tests', { exact: true }).check();
  await page.getByLabel('Capture UI screenshots', { exact: true }).check();
  await page.getByLabel('Capture UI screenshots', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'All changes saved', exact: true }).waitFor();
  assert.deepEqual(store.get().workflow.nodes[0].data.tools, ['read', 'edit', 'test'], 'Each capability toggle preserves the other enabled tools');
  await page.getByRole('button', { name: 'Workflow settings', exact: true }).click();
  assert.equal(await page.getByLabel('Project path', { exact: true }).inputValue(), projectFolder);
  assert.equal(await page.getByLabel('Project path', { exact: true }).getAttribute('readonly'), '');
  await page.getByRole('dialog', { name: 'Workflow settings', exact: true }).getByRole('button', { name: 'Open Project settings', exact: true }).click();
  await page.locator('.project-panel').waitFor();
  const check = makeControlNode('check', 'project-check', { x: 330, y: 0 });
  const gate = makeControlNode('gate', 'project-gate', { x: 660, y: 0 });
  await store.update(state => {
    state.workflow.nodes.push(check, gate);
    state.workflow.edges = [{ id: 'worker-check', source: 'worker', target: check.id }, { id: 'check-gate', source: check.id, target: gate.id }];
  });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText('Local runner ready', { exact: true }).waitFor();
  await page.locator('.react-flow__node[data-id="project-check"]').click();
  await page.getByLabel('Require passing tests', { exact: false }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'All changes saved', exact: true }).waitFor();
  assert.equal(store.get().workflow.nodes.find(node => node.id === check.id)?.data.check?.requireTests, true);
  const stamp = new Date().toISOString();
  await store.update(state => { state.runs = [{ id: 'recorded-execution-ui', status: 'completed', mode: 'pi', startedAt: stamp, finishedAt: stamp, cycle: 1, steps: 1, results: [{ nodeId: 'worker', nodeName: 'Project worker', modelId: 'qwen', cycle: 1, output: 'Review output shown separately from recorded execution evidence.', findings: [], completedAt: stamp, changes: [{ path: 'example.ts', action: 'edited' }], tests: [{ commandId: state.project!.testCommands[0].id, name: 'Unit tests', exitCode: 0, passed: true, timedOut: false, durationMs: 235, output: '1 test passed\n<script>must remain text</script>' }, { commandId: state.project!.testCommands[0].id, name: 'Earlier failing attempt', exitCode: 1, passed: false, timedOut: false, durationMs: 150, output: 'Assertion failed: expected 2, received 1' }] }] }]; });
  await navigate('Run history');
  await page.getByText('Cycle 1', { exact: true }).click();
  await page.locator('.run-result-summary').click();
  await page.getByText('Recorded test executions', { exact: true }).waitFor();
  await page.getByText('Project file changes', { exact: true }).waitFor();
  await page.getByText('Command output', { exact: true }).first().click();
  await page.getByText('1 test passed', { exact: false }).waitFor();
  assert.equal(await page.locator('.execution-evidence script').count(), 0, 'Command output is rendered as text');
  await noOverflow('Execution results'); await screenshot('results-desktop');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await navigate('Project settings'); await page.locator('.project-panel').waitFor();
    await noOverflow(`Project settings ${width}`); await screenshot(`settings-${width}`);
    await navigate('Workflow builder');
    await page.locator('.react-flow__node[data-id="worker"]').click({ force: true });
    await page.getByRole('dialog', { name: 'Project worker settings', exact: true }).waitFor();
    await page.getByLabel('Run configured tests', { exact: true }).scrollIntoViewIfNeeded();
    await noOverflow(`Agent capabilities ${width}`); await screenshot(`capabilities-${width}`);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Node library', exact: true });
  await library.getByLabel('Search node templates', { exact: true }).fill('Implementation worker');
  await library.getByRole('button', { name: 'Preview Implementation worker', exact: true }).click();
  await library.getByText('Edit project files', { exact: true }).waitFor();
  await library.getByText('Run configured tests', { exact: true }).waitFor();
  await library.getByText('Enable editing and tests in Project settings before running this worker.', { exact: false }).waitFor();
  await noOverflow('Implementation worker preview');
  await library.getByRole('button', { name: 'Close node library', exact: true }).click();
  await page.route('**/api/state', async route => {
    const response = await route.fetch(); const state = await response.json();
    state.workspace.hosted = true; state.project.allowEdits = false; state.project.allowTests = false;
    await route.fulfill({ response, json: state });
  });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText('Local runner ready', { exact: true }).waitFor();
  await navigate('Project settings');
  assert.equal(await page.getByLabel('Allow agents to edit project files', { exact: false }).isDisabled(), true);
  assert.equal(await page.getByLabel('Allow agents to run configured tests', { exact: false }).isDisabled(), true);
  await page.getByText('Hosted workspaces support project review.', { exact: false }).waitFor();
  await noOverflow('Hosted project settings');
  assert.deepEqual(errors, []);
  console.log('Project UI smoke passed: existing folder validation/save/reload, shared project source, permission-gated agent tools without losing other capabilities, named test commands, passing-test requirement, recorded execution/file evidence, escaped output, hosted restrictions and 320/390px layouts. Execution evidence uses an explicit UI fixture; no models or test commands were invoked by this smoke.');
} catch (failure) {
  await screenshot('failure').catch(() => {});
  if (page) console.error('Project UI failure context:', { dialogs: await page.getByRole('dialog').allTextContents(), alerts: await page.getByRole('alert').allTextContents() });
  throw failure;
} finally {
  await browser?.close(); await vite.close(); await runtime.shutdown();
  await new Promise<void>(resolve => apiServer.close(() => resolve()));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith('crawlspace-project-ui-'));
  await rm(temporary, { recursive: true, force: true });
}
