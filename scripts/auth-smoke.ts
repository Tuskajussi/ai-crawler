import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as reservePort } from 'node:net';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { createApp } from '../server/index';
import { createTestAccount, signInPage, testRegistrationSecret } from './test-auth';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-auth-ui-'));
const runtime = await createApp({ dataDir: temporary, registrationSecret: testRegistrationSecret, config: { hosted: false } });
const first = await createTestAccount(runtime, 'auth-first');
const second = await createTestAccount(runtime, 'auth-second');
const api = runtime.app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => api.once('listening', resolve));
const address = api.address(); assert(address && typeof address !== 'string');
const reservation = reservePort();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const reserved = reservation.address(); assert(reserved && typeof reserved !== 'string');
await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const vite = await createServer({ server: { host: '127.0.0.1', port: reserved.port, strictPort: true, proxy: { '/api': `http://127.0.0.1:${address.port}` } } });
await vite.listen();
const base = `http://127.0.0.1:${reserved.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let releaseResponse = () => {};
let staleResponse: Promise<number> | undefined;
try {
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await signInPage(page, first);
  let requestStarted = () => {};
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const held = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route('**/api/session-expiry-fixture', async route => {
    const headers = await route.request().allHeaders();
    assert.match(headers.cookie, /crawlspace_session=/, 'The held request starts with an authenticated cookie');
    assert.match(headers['x-csrf-token'], /^[a-f0-9]{64}$/, 'The held write uses the original session token');
    requestStarted();
    await held;
    // Replay the original cookie after sign-out, rather than inventing a 401.
    const response = await route.fetch({ headers });
    assert.equal(response.status(), 401, 'The real API rejects the revoked original session');
    assert.equal(response.headers()['set-cookie'], undefined, 'A passive 401 must not clear the newer browser cookie');
    await route.fulfill({ response });
  });
  // Import the app's real transport module; browser storage never contains the token.
  staleResponse = page.evaluate(async modulePath => {
    const { apiFetch } = await import(modulePath);
    return (await apiFetch('/session-expiry-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status as number;
  }, '/src/api.ts');
  await started;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signInPage(page, second);
  const session = await (await page.request.get(`${base}/api/auth/session`)).json();
  assert.equal(session.user.id, second.user.id);
  releaseResponse();
  assert.equal(await staleResponse, 401);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.auth-account-name').innerText(), 'auth-second\nPrivate workspace', 'A late 401 keeps the new account mounted');
  // A real write also proves that the late response preserved the new CSRF token.
  await page.getByRole('textbox', { name: 'Workflow name', exact: true }).fill('Second account after stale response');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Workflow saved', { exact: true }).waitFor();
  assert.equal(second.workspace.store.get().workflow.name, 'Second account after stale response');
  assert.notEqual(first.workspace.store.get().workflow.name, 'Second account after stale response');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Auth UI smoke passed: the actual API rejects a held revoked-session request after a different account signs in, without clearing its cookie; the new workspace and CSRF-protected write remain valid. No model requests were made.');
} catch (error) {
  await mkdir('.crawlspace/previews', { recursive: true });
  await page?.screenshot({ path: '.crawlspace/previews/auth-failure.png', fullPage: true });
  throw error;
} finally {
  releaseResponse();
  await staleResponse?.catch(() => {});
  await browser?.close(); await vite.close(); await runtime.shutdown();
  await new Promise<void>(resolve => api.close(() => resolve()));
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('crawlspace-auth-ui-'));
  await rm(resolved, { recursive: true, force: true });
}
