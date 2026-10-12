/** Exercise the built production server with Node only (no tsx or dev dependencies). */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const repository = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = path.join(repository, 'dist-server', 'index.js');
await access(entrypoint);
await access(path.join(repository, 'dist', 'index.html'));
const temporaryParent = await realpath(tmpdir());
const temporaryRoot = await mkdtemp(path.join(temporaryParent, 'crawlspace-production-smoke-'));
const dataDirectory = path.join(temporaryRoot, 'data');
const publicOrigin = 'https://crawl.example.com';
const secret = randomBytes(32).toString('base64url');
const password = randomBytes(24).toString('base64url');
const username = 'production-smoke';
let child;
let childFailure;
let childOutput = '';
let port;

function safeDiagnostics() {
  return childOutput.replaceAll(secret, '[redacted]').replaceAll(password, '[redacted]').slice(-4_000);
}

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const available = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return available;
}

async function request(route, { method = 'GET', body, cookie, csrfToken, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const pending = httpRequest({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Host: 'crawl.example.com', Origin: publicOrigin,
        ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(serialized === undefined ? {} : { 'Content-Length': Buffer.byteLength(serialized) }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...headers,
      },
    }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.once('error', reject);
      incoming.once('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        resolve(new Response([204, 205, 304].includes(incoming.statusCode) ? undefined : Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
    });
    pending.setTimeout(3_000, () => pending.destroy(new Error('Production HTTP request timed out.')));
    pending.once('error', reject);
    pending.end(serialized);
  });
}

async function start(registrationEnabled) {
  childOutput = '';
  childFailure = undefined;
  child = spawn(process.execPath, [entrypoint], {
    cwd: repository,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CRAWLSPACE_DATA_DIR: dataDirectory,
      CRAWLSPACE_HOST: '127.0.0.1',
      CRAWLSPACE_PORT: String(port),
      CRAWLSPACE_PUBLIC_URL: publicOrigin,
      CRAWLSPACE_REGISTRATION_SECRET: registrationEnabled ? secret : '',
      CRAWLSPACE_TRUST_PROXY: 'false',
      CRAWLSPACE_MODEL_KEY_ALLOWLIST: 'ANTHROPIC_API_KEY,OPENAI_API_KEY',
      CRAWLSPACE_MODEL_ENDPOINT_ORIGINS: '',
      CRAWLSPACE_PREVIEW_ORIGINS: '',
    },
  });
  child.once('error', error => { childFailure = error; });
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { childOutput = (childOutput + chunk.toString()).slice(-16_000); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (childFailure) throw childFailure;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Production server exited before listening. ${safeDiagnostics()}`);
    try {
      const response = await request('/api/health', { headers: { Host: '127.0.0.1' } });
      if (response.status === 200 && (await response.json()).ok) return;
    } catch {
      // The child has not bound its listener yet.
    }
    await delay(100);
  }
  throw new Error(`Production server did not become ready. ${safeDiagnostics()}`);
}

function waitForExit(processToWait, timeoutMs) {
  if (processToWait.exitCode !== null || processToWait.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = exited => {
      clearTimeout(timer);
      processToWait.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    processToWait.once('exit', onExit);
  });
}

async function stop() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const processToStop = child;
  let exited = waitForExit(processToStop, 5_000);
  processToStop.kill('SIGTERM'); // This script owns this exact Node child PID.
  if (await exited) return;
  exited = waitForExit(processToStop, 5_000);
  processToStop.kill('SIGKILL');
  assert.equal(await exited, true, 'The production smoke child must stop before cleanup.');
}

try {
  port = await freePort();
  await start(true);
  const health = await request('/api/health', { headers: { Host: '127.0.0.1' } });
  assert.deepEqual(await health.json(), { ok: true });
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type') ?? '', /text\/html/);
  const csp = html.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(html.headers.get('strict-transport-security') ?? '', /max-age=/);
  const document = await html.text();
  const assetPaths = [...document.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assetPaths.some(asset => asset.endsWith('.js')), 'The production HTML must reference its built JavaScript.');
  assert.ok(assetPaths.some(asset => asset.endsWith('.css')), 'The production HTML must reference its built CSS.');
  for (const asset of new Set(assetPaths)) {
    const response = await request(asset);
    assert.equal(response.status, 200, `Built asset must be served: ${asset}`);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { username, password, registrationSecret: 'wrong secret' } })).status, 403);
  const registration = await request('/api/auth/register', { method: 'POST', body: { username, password, registrationSecret: secret } });
  assert.equal(registration.status, 201);
  const setCookie = registration.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /crawlspace_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /;\s*Secure/i);
  const cookie = setCookie.split(';')[0];
  const session = await registration.json();
  assert.equal(session.user.username, username);
  assert.equal(session.registrationEnabled, true);
  assert.match(session.csrfToken, /^[a-f0-9]{64}$/);
  assert.equal(session.token, undefined);
  const authenticated = await request('/api/state', { cookie });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).workspace.hosted, true);
  const message = { from: 'you', to: 'all', type: 'message', text: 'Persisted production smoke assignment.' };
  assert.equal((await request('/api/messages', { method: 'POST', body: message, cookie })).status, 403);
  assert.equal((await request('/api/messages', { method: 'POST', body: message, cookie, csrfToken: session.csrfToken })).status, 201);
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  const pdfBytes = Buffer.from(await pdf.save());
  const upload = { method: 'POST', body: pdfBytes, cookie, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'production.pdf' } };
  assert.equal((await request('/api/knowledge/preview', upload)).status, 403, 'Binary uploads must require CSRF too.');
  const prepared = await request('/api/knowledge/preview', { ...upload, csrfToken: session.csrfToken });
  assert.equal(prepared.status, 200, 'The bundled PDF worker must prepare authenticated uploads.');
  const preview = await prepared.json();
  assert.equal(preview.modality, 'pdf');
  assert.equal(preview.chunks.length, 1);
  assert.equal(preview.chunks[0].locator.pageStart, 1);
  assert.equal((await request(`/api/knowledge/previews/${preview.id}`, { method: 'DELETE', body: {}, cookie, csrfToken: session.csrfToken })).status, 204);
  const savedAuth = await readFile(path.join(dataDirectory, 'auth.json'), 'utf8');
  for (const sensitive of [secret, password, cookie.slice('crawlspace_session='.length)]) assert.equal(savedAuth.includes(sensitive), false);
  console.log('Production assets, headers, secret registration, cookies, CSRF, and workspace access passed.');

  await stop();
  await start(false);
  const resumed = await request('/api/auth/session', { cookie });
  assert.equal(resumed.status, 200);
  const resumedSession = await resumed.json();
  assert.equal(resumedSession.user.id, session.user.id);
  assert.equal(resumedSession.csrfToken, session.csrfToken);
  assert.equal(resumedSession.registrationEnabled, false);
  const resumedState = await request('/api/state', { cookie });
  assert.equal(resumedState.status, 200);
  assert.ok((await resumedState.json()).messages.some(item => item.text === message.text));
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { username: 'another-user', password, registrationSecret: secret } })).status, 403);
  const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(login.status, 200);
  const loggedIn = await login.json();
  assert.equal(loggedIn.user.id, session.user.id);
  assert.equal(loggedIn.registrationEnabled, false);
  const loggedInCookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.notEqual(loggedInCookie, cookie);
  assert.equal((await request('/api/state', { cookie: loggedInCookie })).status, 200);
  assert.equal((await request('/api/auth/logout', { method: 'POST', body: {}, cookie: loggedInCookie, csrfToken: loggedIn.csrfToken })).status, 200);
  assert.equal((await request('/api/state', { cookie: loggedInCookie })).status, 401);
  assert.equal((await request('/api/state', { cookie })).status, 200);
  console.log('Production restart preserved accounts, sessions, and workspace data; closed registration and login/logout passed.');
} finally {
  await stop();
  const resolvedRoot = await realpath(temporaryRoot);
  const relative = path.relative(temporaryParent, resolvedRoot);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.ok(path.basename(resolvedRoot).startsWith('crawlspace-production-smoke-'));
  await rm(resolvedRoot, { recursive: true, force: true });
}
