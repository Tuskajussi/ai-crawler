import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createApp } from './index';

const SECRET = 'integration-test-registration-secret-at-least-32-characters';
const PASSWORD = 'a long integration test password';

interface RequestOptions {
  csrf?: boolean;
  headers?: Record<string, string>;
}

async function withServer(
  run: (context: { instance: Awaited<ReturnType<typeof createApp>>; base: string; directory: string }) => Promise<void>,
  config?: { publicUrl: string; hosted: boolean },
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-api-'));
  try {
    const instance = await createApp({ dataDir: path.join(directory, 'data'), registrationSecret: SECRET, demoStepMs: 60_000, ...(config ? { config } : {}) });
    const server = instance.app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      await run({ instance, base, directory });
    } finally {
      try {
        await instance.shutdown();
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.ok(path.basename(directory).startsWith('crawlspace-api-'));
    await rm(directory, { recursive: true, force: true });
  }
}

// Node fetch replaces Host, so use a real HTTP request for proxy-origin tests.
async function fetchWithHost(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(url, { method: init.method, headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject);
    request.end(init.body);
  });
}
function browser(base: string, defaultHeaders: Record<string, string> = {}) {
  let cookie = '';
  let csrfToken = '';
  const request = async (route: string, method = 'GET', body?: unknown, options: RequestOptions = {}) => {
    const transport = defaultHeaders.Host || options.headers?.Host ? fetchWithHost : fetch;
    const response = await transport(`${base}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json', ...defaultHeaders,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrfToken && options.csrf !== false && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const authenticate = async (route: string, body: unknown) => {
    const response = await request(route, 'POST', body);
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    csrfToken = data.csrfToken;
    return { response, data };
  };
  return {
    request,
    register: (username: string) => authenticate('/auth/register', { username, password: PASSWORD, registrationSecret: SECRET }),
    login: (username: string, password = PASSWORD) => authenticate('/auth/login', { username, password }),
  };
}

test('authenticated API preserves workflow behavior and requires CSRF for every mutation', async () => {
  await withServer(async ({ instance, base }) => {
    const client = browser(base);
    const anonymousSession = await client.request('/auth/session');
    assert.equal(anonymousSession.status, 200);
    assert.equal((await anonymousSession.json()).user, null);
    assert.equal((await client.request('/state')).status, 401);
    assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 401);
    assert.equal((await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD, registrationSecret: 'wrong' })).status, 403);
    const { response: registered, data: session } = await client.register('tester');
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie') ?? '';
    assert.match(cookie, /crawlspace_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /;\s*Secure/i);
    assert.equal(session.user.username, 'tester');
    assert.equal(session.registrationEnabled, true);
    assert.match(session.csrfToken, /^[a-f0-9]{64}$/);
    assert.equal(session.token, undefined);
    assert.equal(session.password, undefined);
    const restoredSession = await (await client.request('/auth/session')).json();
    assert.equal(restoredSession.user.id, session.user.id);
    assert.equal(restoredSession.csrfToken, session.csrfToken);
    assert.equal((await client.request('/messages', 'POST', { from: 'you', to: 'all', text: 'blocked', type: 'message' }, { csrf: false })).status, 403);
    assert.equal((await client.request('/messages', 'POST', { from: 'you', to: 'all', text: 'blocked', type: 'message' }, { headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
    const stateResponse = await client.request('/state');
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal((await client.request('/messages', 'POST', { from: 'you', to: 'missing', text: 'hello', type: 'message' })).status, 400);
    const sent = await client.request('/messages', 'POST', { from: 'you', to: 'tester', text: 'Review empty responses.', type: 'assignment' });
    assert.equal(sent.status, 201);
    assert.equal((await sent.json()).messages.at(-1).to, 'tester');
    assert.equal((await client.request('/state', 'GET', undefined, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    state.workflow.settings.mode = 'once';
    assert.equal((await client.request('/workflow', 'PUT', state.workflow)).status, 200);
    assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 202);
    assert.equal((await client.request('/runs', 'POST', { mode: 'demo' })).status, 409);
    assert.equal((await client.request('/workflow', 'PUT', state.workflow)).status, 409);
    const stopped = await client.request('/runs/stop', 'POST', {});
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).runs[0].status, 'stopped');
    const workspace = await instance.workspaces.get(session.user.id);
    await workspace.engine.waitForIdle();
    assert.equal((await client.request('/findings/missing', 'PATCH', { status: 'resolved' })).status, 404);
    assert.equal((await client.request('/auth/logout', 'POST', {}, { csrf: false })).status, 403);
    assert.equal((await client.request('/auth/password', 'POST', { currentPassword: PASSWORD, newPassword: 'different sufficiently long password' }, { csrf: false })).status, 403);
  });
});

test('accounts have independent workflows, messages, and protected screenshot directories', async () => {
  await withServer(async ({ instance, base }) => {
    const alice = browser(base);
    const bob = browser(base);
    const { data: aliceSession } = await alice.register('alice');
    const { data: bobSession } = await bob.register('bob');
    assert.notEqual(aliceSession.user.id, bobSession.user.id);
    const aliceState = await (await alice.request('/state')).json();
    aliceState.workflow.name = 'Alice private workflow';
    assert.equal((await alice.request('/workflow', 'PUT', aliceState.workflow)).status, 200);
    const sent = await alice.request('/messages', 'POST', { from: 'you', to: 'all', text: 'Alice private review assignment', type: 'message' });
    assert.equal(sent.status, 201);
    const bobState = await (await bob.request('/state')).json();
    assert.notEqual(bobState.workflow.name, 'Alice private workflow');
    assert.ok(!bobState.messages.some((message: { text: string }) => message.text === 'Alice private review assignment'));
    const aliceWorkspace = await instance.workspaces.get(aliceSession.user.id);
    const bobWorkspace = await instance.workspaces.get(bobSession.user.id);
    assert.notEqual(aliceWorkspace.directory, bobWorkspace.directory);
    const aliceScreenshots = path.join(aliceWorkspace.directory, 'screenshots');
    await mkdir(aliceScreenshots, { recursive: true });
    await writeFile(path.join(aliceScreenshots, 'private-review.png'), Buffer.from('alice screenshot evidence'));
    const aliceScreenshot = await alice.request('/screenshots/private-review.png');
    assert.equal(aliceScreenshot.status, 200);
    assert.equal(await aliceScreenshot.text(), 'alice screenshot evidence');
    assert.equal((await bob.request('/screenshots/private-review.png')).status, 404);
    assert.equal((await browser(base).request('/screenshots/private-review.png')).status, 401);
    assert.equal((await bob.request(`/screenshots/${aliceSession.user.id}/private-review.png`)).status, 404);
  });
});

test('logout and password changes revoke sessions; bad password changes keep the user signed in', async () => {
  await withServer(async ({ base }) => {
    const first = browser(base);
    const second = browser(base);
    await first.register('tester');
    assert.equal((await second.request('/auth/login', 'POST', { username: 'tester', password: 'incorrect long password' })).status, 401);
    await second.login('tester');
    const wrongChange = await first.request('/auth/password', 'POST', { currentPassword: 'wrong long password', newPassword: 'changed integration password' });
    assert.ok([400, 403].includes(wrongChange.status));
    assert.equal((await first.request('/state')).status, 200);
    assert.equal((await second.request('/auth/logout', 'POST', {})).ok, true);
    assert.equal((await second.request('/state')).status, 401);
    assert.equal((await (await second.request('/auth/session')).json()).user, null);
    await second.login('tester');
    const changed = await first.request('/auth/password', 'POST', { currentPassword: PASSWORD, newPassword: 'changed integration password' });
    assert.equal(changed.ok, true);
    assert.equal((await first.request('/state')).status, 401);
    assert.equal((await second.request('/state')).status, 401);
    await first.login('tester', 'changed integration password');
    assert.equal((await first.request('/state')).status, 200);
  });
});

test('hosted mode trusts the configured origin and issues Secure session cookies', async () => {
  await withServer(async ({ base }) => {
    const hostedHeaders = { Host: 'crawl.example.com', Origin: 'https://crawl.example.com' };
    const client = browser(base, hostedHeaders);
    const { response, data } = await client.register('hosted-user');
    assert.match(response.headers.get('set-cookie') ?? '', /;\s*Secure/i);
    assert.equal(data.user.username, 'hosted-user');
    assert.equal((await client.request('/state')).status, 200);
    assert.equal((await client.request('/state', 'GET', undefined, { headers: { Origin: 'https://other.example.com' } })).status, 403);
    assert.equal((await client.request('/auth/session', 'GET', undefined, { headers: { Host: 'attacker.example.com' } })).status, 403);
  }, { publicUrl: 'https://crawl.example.com', hosted: true });
});



test('authentication rejects malformed sessions, cross-site/form writes, and repeated secret guesses', async () => {
  await withServer(async ({ instance, base }) => {
    const client = browser(base);
    const malformed = await client.request('/auth/session', 'GET', undefined, { headers: { Cookie: 'crawlspace_session=malformed%00cookie' } });
    assert.equal(malformed.status, 200);
    assert.equal((await malformed.json()).user, null);
    assert.equal((await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD, registrationSecret: SECRET }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD, registrationSecret: SECRET }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const malformedJson = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformedJson.status, 400);
    const missing = await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD });
    const wrong = await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD, registrationSecret: 'wrong secret' });
    assert.equal(missing.status, 403);
    assert.equal(wrong.status, 403);
    assert.deepEqual(await missing.json(), await wrong.json());
    for (let attempt = 2; attempt < 20; attempt += 1) {
      assert.equal((await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD, registrationSecret: 'wrong secret' })).status, 403);
    }
    const limited = await client.request('/auth/register', 'POST', { username: 'tester', password: PASSWORD, registrationSecret: SECRET });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '900');
    assert.equal(instance.auth.firstUserId, undefined);
  });
});
