import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createPortReservation } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { createServer } from 'vite';
import { createApp } from '../server/index';
import { createTestAccount, signInPage, testRegistrationSecret } from './test-auth';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-ux-'));
const runtime = await createApp({ dataDir: temporary, registrationSecret: testRegistrationSecret, demoStepMs: 2000 });
const { app, shutdown } = runtime;
const account = await createTestAccount(runtime, 'ux-tester');
const { store, engine } = account.workspace;
await store.update(state => {
  state.workflow.settings.mode = 'once';
  state.workflow.settings.executionMode = 'demo';
  state.workflow.settings.continuous = false;
  const stamp = new Date().toISOString();
  state.findings = [
    { id: 'ux-high', title: 'Keep the review controls readable', description: 'A seeded local observation for checking long evidence text and filter controls.', severity: 'high', status: 'open', file: `src/${'long-source-segment-'.repeat(8)}.tsx`, line: 42, nodeId: 'crawler', createdAt: stamp, demo: true },
    { id: 'ux-low', title: 'Review the empty search state', description: 'Check that a search with no results explains how to clear filters and return to the full shelf.', severity: 'low', status: 'resolved', nodeId: 'designer', createdAt: stamp, demo: true },
  ];
  state.messages = [
    { id: 'ux-message', from: 'crawler', to: 'all', text: 'The local review is ready for the team. Check the findings and coordinate the next pass.', type: 'message', createdAt: stamp },
    { id: 'ux-assignment', from: 'you', to: 'crawler', text: 'Read the complete assignment before reviewing the layout. '.repeat(12), type: 'assignment', createdAt: stamp },
  ];
  state.runs = [{ id: 'ux-completed-run', status: 'completed', mode: 'demo', startedAt: new Date(Date.now() - 125000).toISOString(), finishedAt: stamp, cycle: 1, steps: 5 }];
});
const apiServer = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => apiServer.once('listening', resolve));
const address = apiServer.address(); assert(address && typeof address !== 'string');
// Vite treats port zero as its configured default, so choose a free local port first.
const reservation = createPortReservation();
await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const reservedAddress = reservation.address(); assert(reservedAddress && typeof reservedAddress !== 'string');
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const vite = await createServer({ server: { host: '127.0.0.1', port: reservedAddress.port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${address.port}` } } });
await vite.listen();
const viteAddress = vite.httpServer?.address(); assert(viteAddress && typeof viteAddress !== 'string');
const baseUrl = `http://127.0.0.1:${viteAddress.port}`;
const pages = [
  { name: 'Workflow builder', slug: 'builder', selector: '.builder-page' },
  { name: 'Your team', slug: 'team', selector: '.staff-panel' },
  { name: 'Team messages', slug: 'messages', selector: '.messages-panel' },
  { name: 'Models', slug: 'models', selector: '.models-panel' },
  { name: 'Knowledge', slug: 'knowledge', selector: '.knowledge-panel' },
  { name: 'Findings', slug: 'findings', selector: '.findings-panel' },
  { name: 'Tool reliability', slug: 'reliability', selector: '.reliability-panel' },
  { name: 'Run history', slug: 'runs', selector: '.runs-panel' },
] as const;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;

async function overflow(label: string) {
  assert(page);
  const result = await page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth,
    offending: [...document.querySelectorAll('main *,[role="dialog"] *')].filter(element => {
      const rectangle = element.getBoundingClientRect();
      return rectangle.width > 0 && rectangle.right > window.innerWidth + 2 && getComputedStyle(element).position !== 'absolute';
    }).slice(0, 8).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right) })) }));
  assert(result.document <= result.width + 1, `${label}: page overflows horizontally (${JSON.stringify(result)})`);
}

async function screenshot(name: string) {
  assert(page); await page.screenshot({ path: `.crawlspace/previews/ux-${name}.png`, fullPage: await page.getByRole('dialog').count() === 0, animations: 'disabled' });
}

async function navigate(item: typeof pages[number]) {
  assert(page);
  if ((page.viewportSize()?.width ?? 1512) <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  await nav.getByRole('button', { name: item.name === 'Findings' ? /^Findings/ : item.name, exact: item.name !== 'Findings' }).click();
  if ((page.viewportSize()?.width ?? 1512) <= 760) await page.locator('#workspace-navigation').waitFor({ state: 'hidden' });
  await page.locator(item.selector).waitFor({ state: 'visible' });
  if (item.slug === 'knowledge') await page.locator('.knowledge-loading').waitFor({ state: 'hidden' });
  if (item.slug === 'reliability') await page.getByRole('heading', { name: 'No measured visits yet', exact: true }).waitFor();
  const current = page.locator('#workspace-navigation nav button[aria-current="page"]');
  assert.equal(await current.count(), 1, 'Exactly one navigation destination is current');
  assert.match(await current.textContent() ?? '', new RegExp(item.name));
}

async function trapFocus(dialog: Locator) {
  assert(page);
  await page.waitForFunction(() => !!document.activeElement?.closest('[role="dialog"]'));
  const focusable = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';
  await dialog.evaluate((element, selector) => {
    const items = [...element.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length && !item.closest('[inert]'));
    if (!items.length) throw new Error('The dialog has no keyboard-operable controls');
    items.at(-1)!.focus();
  }, focusable);
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate((element, selector) => [...element.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length && !item.closest('[inert]'))[0] === document.activeElement, focusable), true, 'Tab wraps to the first visible dialog control');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate((element, selector) => [...element.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length && !item.closest('[inert]')).at(-1) === document.activeElement, focusable), true, 'Shift+Tab wraps to the last visible dialog control');
  // Leave screenshots at the beginning of long dialogs after verifying both boundaries.
  await page.keyboard.press('Tab');
}

try {
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const unexpectedRequests: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort();
    if (route.request().method() === 'POST' && /\/probe$|\/chatgpt\/(?:login|select|logout)$|\/knowledge\/(?:preview|index|search)$/.test(url.pathname)) unexpectedRequests.push(url.pathname);
    return route.continue();
  });
  await mkdir('.crawlspace/previews', { recursive: true });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await signInPage(page, account);
  await page.getByText('Local runner ready', { exact: true }).waitFor();
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  for (const group of ['Workspace', 'Resources', 'Insights']) await nav.getByText(group, { exact: true }).waitFor();

  for (const item of pages) { await navigate(item); await overflow(`Desktop ${item.name}`); await screenshot(`desktop-${item.slug}`); }
  await navigate(pages[3]);
  const models = page.locator('.models-panel');
  await models.getByRole('region', { name: 'Local models', exact: true }).waitFor();
  await models.getByRole('region', { name: 'Cloud models', exact: true }).waitFor();
  await page.getByLabel('Search models', { exact: true }).fill('no-model-with-this-name');
  await page.getByRole('heading', { name: 'No matching models', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByLabel('Filter models by location', { exact: true }).selectOption('local');
  assert.equal(await models.getByRole('region', { name: 'Cloud models', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  for (const heading of ['Connection', 'Capacity and reasoning', 'Agent access and capabilities']) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await overflow('Desktop model editor'); await screenshot('desktop-model-editor');
  await page.getByRole('button', { name: 'Close model editor', exact: true }).click();

  await navigate(pages[5]);
  await page.getByLabel('Filter by severity', { exact: true }).selectOption('high');
  await page.getByText('Showing 1 of 2 findings', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByText('Showing 2 of 2 findings', { exact: true }).waitFor();
  await navigate(pages[2]);
  await page.getByLabel('Message type', { exact: true }).selectOption('assignment');
  await page.getByLabel('Your message', { exact: true }).fill('A local layout test assignment.');
  assert.equal(await page.getByRole('button', { name: 'Send assignment', exact: true }).isDisabled(), true, 'Assignments require a specific recipient before sending');
  await page.getByLabel('Message recipient', { exact: true }).selectOption('crawler');
  assert.equal(await page.getByRole('button', { name: 'Send assignment', exact: true }).isEnabled(), true);
  await navigate(pages[1]);
  const assignment = page.locator('.staff-assignment').first();
  await assignment.locator('summary').click();
  assert.equal(await assignment.getAttribute('open'), '', 'Long staff assignments can be expanded in full');
  await screenshot('desktop-expanded-assignment');

  await navigate(pages[0]);
  const helpButton = page.getByRole('button', { name: 'Help', exact: true });
  await helpButton.click();
  const help = page.getByRole('dialog', { name: 'Meet your next little team.', exact: true });
  await help.waitFor(); await trapFocus(help); await screenshot('desktop-help');
  await page.keyboard.press('Escape'); await help.waitFor({ state: 'hidden' });
  assert.equal(await helpButton.evaluate(element => element === document.activeElement), true, 'Help restores focus to its opener');

  await page.locator('.react-flow__node[data-id="crawler"]').click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByRole('button', { name: 'Stop run', exact: true }).waitFor();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="Workflow name"]') as HTMLInputElement | null)?.disabled);
  assert.equal(await page.getByLabel('Workflow name', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByTitle('Toggle looping', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('Agent name', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Duplicate', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).isDisabled(), true);
  const add = page.getByRole('button', { name: 'Add agent', exact: true });
  assert.equal(await add.isEnabled(), true, 'The node library remains browseable during a run');
  await add.click();
  const library = page.getByRole('dialog', { name: 'Node library', exact: true });
  await library.getByRole('button', { name: 'Preview Custom agent', exact: true }).click();
  assert.equal(await library.getByRole('button', { name: 'Add to workflow', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape'); await library.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).waitFor();
  await engine.waitForIdle();
  assert.equal(await page.getByLabel('Workflow name', { exact: true }).isEnabled(), true);

  for (const width of [320, 390, 768, 1280, 1512]) {
    await page.setViewportSize({ width, height: width <= 760 ? 844 : 1000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Local runner ready', { exact: true }).waitFor();
    if (width <= 1100) assert.equal(await page.getByRole('dialog', { name: 'Scout settings', exact: true }).count(), 0, 'Compact builder starts with its canvas visible');
    for (const item of pages) { await navigate(item); await overflow(`${width}px ${item.name}`); }
    await navigate(pages[0]); await screenshot(`builder-${width}`);
    if (width > 1100) continue;
    const node = page.locator('.react-flow__node[data-id="crawler"]');
    await node.focus(); await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Scout settings', exact: true });
    await inspector.waitFor(); await trapFocus(inspector); await overflow(`${width}px agent drawer`); await screenshot(`agent-${width}`);
    const graphNodes = page.locator('.react-flow__node');
    const nodeCount = await graphNodes.count();
    await page.keyboard.press('Delete');
    assert.equal(await graphNodes.count(), nodeCount, 'Delete in agent settings does not remove a workflow node');
    await page.keyboard.press('Escape'); await inspector.waitFor({ state: 'hidden' });
    assert.equal(await node.evaluate(element => element === document.activeElement), true, 'Closing agent settings restores focus to the selected node');
    await node.focus(); await page.keyboard.press('Space'); await inspector.waitFor();
    await inspector.getByRole('button', { name: 'Close agent settings', exact: true }).click(); await inspector.waitFor({ state: 'hidden' });
    if (width > 760) continue;
    const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
    await drawer.waitFor(); await trapFocus(drawer); await overflow(`${width}px navigation`); await screenshot(`navigation-${width}`);
    await page.keyboard.press('Delete');
    assert.equal(await graphNodes.count(), nodeCount, 'Delete in navigation does not remove a workflow node');
    assert.equal(await page.locator('.workspace-main').evaluate(element => element.hasAttribute('inert') || !!element.closest('[inert]')), true, 'Open navigation prevents background interaction');
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
    assert.equal(await menu.evaluate(element => element === document.activeElement), true, 'Navigation restores focus to its opener');
    await menu.click(); await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
    await add.click(); await library.waitFor(); await trapFocus(library); await overflow(`${width}px node library`); await screenshot(`library-${width}`);
    await page.keyboard.press('Escape'); await library.waitFor({ state: 'hidden' });
    assert.equal(await add.evaluate(element => element === document.activeElement), true, 'Node library restores focus to Add agent');
    const settingsButton = page.getByRole('button', { name: 'Workflow settings', exact: true });
    await settingsButton.click();
    const settings = page.getByRole('dialog', { name: 'Workflow settings', exact: true });
    await settings.waitFor(); await trapFocus(settings); await overflow(`${width}px workflow settings`); await screenshot(`settings-${width}`);
    await page.keyboard.press('Escape'); await settings.waitFor({ state: 'hidden' });
    assert.equal(await settingsButton.evaluate(element => element === document.activeElement), true, 'Workflow settings restores focus to its opener');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Local runner ready', { exact: true }).waitFor();
  await navigate(pages[0]);
  const priorNodeCount = await page.locator('.react-flow__node').count();
  const priorBodyOverflow = await page.evaluate(() => document.body.style.overflow);
  const mobileMenu = page.getByRole('button', { name: 'Open navigation', exact: true });
  await mobileMenu.click();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  const passwordDialog = page.getByRole('dialog', { name: 'A new key to your workspace.', exact: true });
  await passwordDialog.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'account-current-password');
  await trapFocus(passwordDialog); await overflow('390px change password'); await screenshot('password-390');
  assert.equal(await page.locator('.workspace-main').evaluate(element => element.hasAttribute('inert')), true, 'The password dialog prevents workspace interaction');
  await page.keyboard.press('Escape'); await passwordDialog.waitFor({ state: 'hidden' });
  assert.equal(await mobileMenu.evaluate(element => element === document.activeElement), true, 'Closing password settings returns focus to the mobile menu');
  assert.equal(await page.evaluate(() => document.body.style.overflow), priorBodyOverflow, 'Opening password settings from navigation restores page scrolling on close');
  await add.click(); await library.waitFor();
  await library.getByRole('button', { name: 'Preview Custom agent', exact: true }).click();
  await library.getByRole('button', { name: 'Back to templates', exact: true }).waitFor();
  await overflow('390px node library preview'); await screenshot('library-preview-390');
  await library.getByRole('button', { name: 'Add to workflow', exact: true }).click();
  const newInspector = page.getByRole('dialog', { name: 'Custom agent settings', exact: true });
  await newInspector.waitFor();
  const newNode = page.locator('.react-flow__node').filter({ hasText: 'Custom agent' });
  await newNode.waitFor();
  assert.equal(await page.locator('.react-flow__node').count(), priorNodeCount + 1, 'Adding a template creates exactly one node');
  await page.locator('.toast').waitFor({ state: 'visible' });
  const newInspectorClose = newInspector.getByRole('button', { name: 'Close agent settings', exact: true });
  assert.equal(await newInspectorClose.evaluate(element => {
    const rectangle = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
    return topmost === element || (topmost !== null && element.contains(topmost));
  }), true, 'The success toast never obscures the new agent drawer close control');
  await screenshot('new-agent-390');
  await page.keyboard.press('Escape'); await newInspector.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('react-flow__node') && document.activeElement.textContent?.includes('Custom agent'));
  assert.equal(await newNode.evaluate(element => element === document.activeElement), true, 'New agent settings restore focus to the newly mounted node');
  assert.equal(await page.evaluate(() => document.body.style.overflow), priorBodyOverflow, 'Closing new agent settings restores page scrolling');
  assert.deepEqual(unexpectedRequests, [], 'Browsing and UX checks never probe models, sign in to providers, upload sources, create embeddings or search providers');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('UX smoke passed: grouped/current navigation, model shelves and filters, long assignments, recipient guidance, dialog keyboard traps and focus restoration, Enter/Space agent activation, drawer Delete protection, mobile password focus and scroll restoration, new-agent focus and scroll restoration, live-run editing locks, and eight pages without overflow at 320/390/768/1280/1512px. Screenshots saved as .crawlspace/previews/ux-*.png. No model or cloud requests were made.');
} catch (failure) {
  await screenshot('failure').catch(() => {});
  if (page) console.error('UX failure context:', { viewport: page.viewportSize(), dialogs: await page.getByRole('dialog').allTextContents(), focused: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 500)) });
  throw failure;
} finally {
  await browser?.close(); await vite.close(); await shutdown();
  await new Promise<void>(resolve => apiServer.close(() => resolve()));
  const resolvedTemporary = path.resolve(temporary);
  assert.equal(path.dirname(resolvedTemporary), path.resolve(os.tmpdir()));
  assert(path.basename(resolvedTemporary).startsWith('crawlspace-ux-'));
  await rm(resolvedTemporary, { recursive: true, force: true });
}
