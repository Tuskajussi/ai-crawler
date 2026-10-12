import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatgptService, adaptChatgptResponsesPayload, createChatgptFetch } from './chatgpt';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' };
const directScope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'mock-request-id' } });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-chatgpt-'));
  const credentials = path.join(directory, 'protected-credentials');
  let now = Date.now();
  let nonce = '';
  let subject = 'user-a';
  let claimsOverride: Record<string, unknown> = {};
  let permission = directScope;
  let refreshError: string | undefined;
  let revokeFails = false;
  let refreshIdentityOverride: Record<string, unknown> | undefined;
  let invalidSignature = false;
  let refreshGate: Promise<void> | undefined;
  let releaseRefresh = () => {};
  let refreshStarted = () => {};
  const calls: { url: string; request: Request; form?: URLSearchParams }[] = [];
  let exchanges = 0;
  let refreshes = 0;
  function identity(clientId: string, override: Record<string, unknown> = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: publicJwk.kid })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: clientId, sub: subject, email: 'person@example.test', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, nonce, ...override })).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), pair.privateKey);
    if (invalidSignature) signature[0] ^= 1;
    return `${header}.${claims}.${signature.toString('base64url')}`;
  }
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.redirect, 'error', 'OAuth/discovery requests must never follow redirects');
    const form = request.method === 'POST' ? new URLSearchParams(await request.clone().text()) : undefined;
    calls.push({ url: request.url, request, form });
    if (request.url === 'https://auth.openai.com/.well-known/openid-configuration') return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (request.url === 'https://auth.openai.com/.well-known/jwks.json') return json({ keys: [publicJwk] });
    if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
      if (form!.get('grant_type') === 'refresh_token') {
        refreshes++;
        refreshStarted();
        await refreshGate;
        if (refreshError) return json({ error: refreshError }, 400);
        return json({ token_type: 'Bearer', access_token: `access-refreshed-${refreshes}`, refresh_token: `refresh-rotated-${refreshes}`, expires_in: 3600, scope: permission, ...(refreshIdentityOverride ? { id_token: identity(form!.get('client_id')!, refreshIdentityOverride) } : {}) });
      }
      exchanges++;
      return json({ token_type: 'Bearer', access_token: `access-private-${exchanges}`, refresh_token: `refresh-private-${exchanges}`, id_token: identity(form!.get('client_id')!, claimsOverride), expires_in: 3600, scope: permission });
    }
    if (request.url === 'https://auth.openai.com/oauth/revoke') return revokeFails ? json({ error: 'temporarily_unavailable' }, 503) : new Response('', { status: 200 });
    if (request.url === 'https://api.openai.com/v1/models') return json({ models: [{ slug: 'available-model', display_name: 'Available model', visibility: 'list', context_window: 128_000, input_modalities: ['text', 'image'] }, { slug: 'hidden-model', visibility: 'hide' }] });
    throw new Error(`Unexpected remote request to ${request.url}`);
  };
  const options = { credentialDirectory: credentials, fetch: fetcher, now: () => now };
  const service = new ChatgptService(directory, options);
  const services = [service];
  return {
    directory, credentials, service, calls,
    get exchanges() { return exchanges; }, get refreshes() { return refreshes; },
    setClaims(value: Record<string, unknown>) { claimsOverride = value; },
    setPermission(value: string) { permission = value; },
    setSubject(value: string) { subject = value; },
    setRefreshError(value: string | undefined) { refreshError = value; },
    setRevokeFails(value: boolean) { revokeFails = value; },
    setRefreshIdentity(value: Record<string, unknown> | undefined) { refreshIdentityOverride = value; },
    setInvalidSignature(value: boolean) { invalidSignature = value; },
    pauseRefresh() { refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; }); return new Promise<void>(resolve => { refreshStarted = resolve; }); },
    releaseRefresh() { releaseRefresh(); },
    advance(milliseconds: number) { now += milliseconds; },
    additionalService() { const instance = new ChatgptService(directory, options); services.push(instance); return instance; },
    async start(profileId?: string) { const result = await service.login(profileId); const url = new URL(result.url); nonce = url.searchParams.get('nonce')!; return url; },
    async callback(authorization: URL, clientId: string | null = 'oaiapp_test', state?: string) {
      const url = new URL(authorization.searchParams.get('redirect_uri')!);
      url.search = new URLSearchParams({ code: 'single-use-code', state: state ?? authorization.searchParams.get('state')!, ...(clientId ? { client_id: clientId } : {}) }).toString();
      const response = await fetch(url);
      await response.text();
      return response.status;
    },
    async connect(clientId = 'oaiapp_test') { const authorization = await this.start(); assert.equal(await this.callback(authorization, clientId), 200); return (await service.status()).profiles.at(-1)!; },
    async close() { releaseRefresh(); for (const instance of services) await instance.dispose(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); },
  };
}

test('ChatGPT health/status reads are lazy and never create credential files or make network calls', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.deepEqual(await f.service.status(), { profiles: [], activeProfileId: undefined });
  assert.equal((await f.service.profileReadiness()).ready, false);
  await assert.rejects(stat(f.credentials), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
});

test('official public-client sign-in validates state and PKCE, stores protected tokens, and exposes safe metadata', async t => {
  const f = await fixture(); t.after(() => f.close());
  const authorization = await f.start();
  assert.equal(authorization.origin, 'https://auth.openai.com');
  assert.equal(authorization.pathname, '/api/accounts/authorize');
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'Crawlspace');
  assert.equal(authorization.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.match(authorization.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/);
  assert.equal(new URL(authorization.searchParams.get('redirect_uri')!).hostname, '127.0.0.1');
  assert.equal(await f.callback(authorization, 'oaiapp_test', 'incorrect-state'), 400);
  assert.equal(f.exchanges, 0);
  assert.ok((await f.service.status()).pending);
  assert.equal(await f.callback(authorization), 200);
  const status = await f.service.status();
  assert.equal(status.pending, undefined);
  assert.equal(status.profiles.length, 1);
  assert.equal(status.profiles[0].sharing, true);
  assert.equal(status.profiles[0].subject, 'user-a');
  assert.equal(status.activeProfileId, status.profiles[0].id);
  assert.doesNotMatch(JSON.stringify(status), /access-private|refresh-private|idToken/);
  const exchange = f.calls.find(call => call.form?.get('grant_type') === 'authorization_code')!;
  assert.equal(exchange.form!.get('client_id'), 'oaiapp_test');
  assert.equal(exchange.form!.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(exchange.form!.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
  const stored = await readFile(path.join(f.credentials, 'credentials.json'), 'utf8');
  if (process.platform === 'win32') {
    assert.equal(JSON.parse(stored).protection, 'dpapi-current-user');
    assert.doesNotMatch(stored, /access-private|refresh-private|person@example/);
  } else {
    assert.equal((await stat(path.join(f.credentials, 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(f.credentials)).mode & 0o777, 0o700);
  }
  const before = (await stat(path.join(f.credentials, 'credentials.json'))).mtimeMs;
  await f.service.status(); await f.service.profileReadiness(status.activeProfileId);
  assert.equal((await stat(path.join(f.credentials, 'credentials.json'))).mtimeMs, before, 'read-only checks must not rewrite credentials');
});

test('reconnect reuses the same host/client and rejects a different validated account', async t => {
  const f = await fixture(); t.after(() => f.close());
  const first = await f.start();
  assert.equal(await f.callback(first), 200);
  const profile = (await f.service.status()).profiles[0];
  const reconnect = await f.start(profile.id);
  assert.equal(reconnect.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(reconnect.searchParams.has('agent_name_hint'), false);
  assert.equal(reconnect.searchParams.has('prompt'), false, 'ordinary reconnect must not force consent');
  assert.equal(reconnect.searchParams.get('ext_agent_host_id'), first.searchParams.get('ext_agent_host_id'));
  assert.equal(reconnect.searchParams.has('id_token_hint'), false, 'ID-token hints must not pass through the settings UI');
  f.setSubject('different-user');
  assert.equal(await f.callback(reconnect, null), 400);
  assert.equal((await f.service.status()).profiles[0].subject, 'user-a');
  assert.equal(await f.service.accessToken(profile.id), 'access-private-1');
  f.setSubject('user-a');
  const valid = await f.start(profile.id);
  assert.equal(await f.callback(valid, null), 200);
  assert.equal((await f.service.status()).profiles.length, 1);
});

test('ID-token nonce, issuer, audience, expiry, issued-at and signature validation block activation', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const override of [{ nonce: 'wrong-nonce' }, { iss: 'https://not-openai.example' }, { aud: 'another-client' }, { exp: 1 }, { iat: undefined }, { iat: 9_999_999_999 }]) {
    f.setClaims(override);
    const auth = await f.start();
    assert.equal(await f.callback(auth, `oaiapp_invalid_${f.exchanges}`), 400);
    assert.equal((await f.service.status()).activeProfileId, undefined);
    assert.equal((await f.service.status()).profiles.some(profile => profile.connected), false);
  }
  const status = await f.service.status();
  assert.equal(status.profiles.length, 6, 'issued registrations survive failed code exchanges/identity validation for reconnect');
  assert.match(status.error!, /ID token/);
  f.setClaims({}); f.setInvalidSignature(true);
  const tampered = await f.start();
  assert.equal(await f.callback(tampered, 'oaiapp_tampered'), 400);
  assert.match((await f.service.status()).error!, /signature/);
});

test('cancelled and declined sign-ins never activate an account or consume a token exchange', async t => {
  const f = await fixture(); t.after(() => f.close());
  const first = await f.start();
  await assert.rejects(f.service.login(), /already waiting/);
  await f.service.cancelLogin();
  assert.equal((await f.service.status()).pending, undefined);
  const second = await f.start();
  assert.notEqual(second.searchParams.get('state'), first.searchParams.get('state'));
  const callback = new URL(second.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ error: 'access_denied', state: second.searchParams.get('state')! }).toString();
  const response = await fetch(callback); await response.text();
  assert.equal(response.status, 400);
  assert.equal(f.exchanges, 0);
  assert.equal((await f.service.status()).profiles.length, 0);
  assert.match((await f.service.status()).error!, /declined/);
});

test('cancel and dispose invalidate login startup while credential registration is waiting on another process', async t => {
  for (const operation of ['cancel', 'dispose'] as const) {
    const f = await fixture(); t.after(() => f.close());
    await mkdir(f.credentials);
    const lockPath = path.join(f.credentials, 'credentials.json.lock');
    const lock = await open(lockPath, 'wx');
    const startup = f.service.login();
    const rejected = assert.rejects(startup, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 80));
    const stopping = operation === 'dispose' ? f.service.dispose() : f.service.cancelLogin();
    await lock.close(); await rm(lockPath);
    await stopping; await rejected;
    assert.equal((await f.service.status()).pending, undefined);
    assert.equal(f.exchanges, 0);
    if (operation === 'dispose') await assert.rejects(f.service.login(), /stopped/);
    else { await f.service.login(); await f.service.cancelLogin(); }
  }
});

test('identity-only consent is retained separately and never authorizes inference or model discovery', async t => {
  const f = await fixture(); t.after(() => f.close());
  f.setPermission('openid profile email offline_access');
  const profile = await f.connect();
  assert.equal(profile.connected, true);
  assert.equal(profile.sharing, false);
  assert.equal((await f.service.profileReadiness(profile.id)).ready, false);
  await assert.rejects(f.service.accessToken(profile.id), /grant permission/);
  await assert.rejects(f.service.listModels(profile.id), /grant permission/);
  assert.equal(f.calls.some(call => call.url.includes('/v1/models')), false);
  const enablePlan = await f.start(profile.id);
  assert.equal(enablePlan.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(enablePlan.searchParams.get('prompt'), 'consent');
  assert.ok(enablePlan.searchParams.get('scope')!.split(' ').includes('chatgpt.tokens.use.direct'));
  f.setPermission(directScope);
  assert.equal(await f.callback(enablePlan, null), 200);
  assert.equal((await f.service.status()).profiles[0].sharing, true);
  assert.equal((await f.service.status()).profiles.length, 1, 'consent updates the saved account registration');
  await f.service.logout(profile.id);
  const signedOutReconnect = await f.start(profile.id);
  assert.equal(signedOutReconnect.searchParams.has('prompt'), false, 'signed-out reconnect keeps the documented regular OAuth flow');
});

test('refresh rotation is serialized across service instances and models use the selected current token', async t => {
  const f = await fixture(); t.after(() => f.close());
  const profile = await f.connect();
  const second = f.additionalService();
  f.advance(56 * 60_000);
  const tokens = await Promise.all([f.service.accessToken(profile.id), second.accessToken(profile.id), f.service.accessToken(profile.id)]);
  assert.deepEqual(tokens, ['access-refreshed-1', 'access-refreshed-1', 'access-refreshed-1']);
  assert.equal(f.refreshes, 1);
  const refresh = f.calls.find(call => call.form?.get('grant_type') === 'refresh_token')!;
  assert.equal(refresh.form!.get('client_id'), 'oaiapp_test');
  assert.equal(refresh.form!.get('refresh_token'), 'refresh-private-1');
  assert.equal(refresh.form!.has('scope'), false);
  const models = await second.listModels(profile.id);
  assert.deepEqual(models, [{ id: 'available-model', name: 'Available model', contextWindow: 128_000, supportsImages: true }]);
  assert.equal(f.calls.find(call => call.url.endsWith('/models'))!.request.headers.get('authorization'), 'Bearer access-refreshed-1');
  f.advance(56 * 60_000);
  await f.service.accessToken(profile.id);
  assert.equal(f.calls.filter(call => call.form?.get('grant_type') === 'refresh_token')[1].form!.get('refresh_token'), 'refresh-rotated-1');
});

test('temporary refresh errors retain credentials, terminal errors clear tokens while preserving registration', async t => {
  const f = await fixture(); t.after(() => f.close());
  const profile = await f.connect();
  f.advance(56 * 60_000);
  f.setRefreshError('temporarily_unavailable');
  await assert.rejects(f.service.accessToken(profile.id), /temporarily_unavailable/);
  assert.equal((await f.service.status()).profiles[0].connected, true);
  f.setRefreshError('invalid_grant');
  await assert.rejects(f.service.accessToken(profile.id), /invalid_grant/);
  const status = await f.service.status();
  assert.equal(status.profiles[0].connected, false);
  assert.equal(status.profiles[0].clientId, 'oaiapp_test');
  const reconnect = await f.start(profile.id);
  assert.equal(reconnect.searchParams.get('client_id'), 'oaiapp_test');
});

test('a rotated refresh token survives later identity verification failure and can recover', async t => {
  const f = await fixture(); t.after(() => f.close());
  const profile = await f.connect();
  f.advance(56 * 60_000);
  f.setRefreshIdentity({ sub: 'wrong-user' });
  await assert.rejects(f.service.accessToken(profile.id), /different account/);
  f.setRefreshIdentity(undefined);
  assert.equal(await f.service.accessToken(profile.id), 'access-refreshed-2');
  const refreshCalls = f.calls.filter(call => call.form?.get('grant_type') === 'refresh_token');
  assert.equal(refreshCalls[1].form!.get('refresh_token'), 'refresh-rotated-1');
});

test('run cancellation returns promptly while an already-started token rotation finishes safely', async t => {
  const f = await fixture(); t.after(() => f.close());
  const profile = await f.connect();
  f.advance(56 * 60_000);
  const started = f.pauseRefresh();
  const abort = new AbortController();
  const request = f.service.accessToken(profile.id, abort.signal);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started;
  const before = Date.now();
  abort.abort();
  await rejected;
  assert.ok(Date.now() - before < 500, 'stopping a run must not wait for the refresh network request');
  f.releaseRefresh();
  assert.equal(await f.service.accessToken(profile.id), 'access-refreshed-1');
  assert.equal(f.refreshes, 1);
});

test('account selection stays separate and logout revokes one session while retaining its registration', async t => {
  const f = await fixture(); t.after(() => f.close());
  const first = await f.connect('oaiapp_first');
  const second = await f.connect('oaiapp_second');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.label, second.label);
  await f.service.select(first.id);
  assert.equal((await f.service.status()).activeProfileId, first.id);
  await f.service.logout(first.id);
  const revoke = f.calls.find(call => call.url.endsWith('/revoke'))!;
  assert.equal(revoke.form!.get('client_id'), 'oaiapp_first');
  assert.equal(revoke.form!.get('token'), 'refresh-private-1');
  assert.equal(revoke.form!.get('token_type_hint'), 'refresh_token');
  assert.equal((await f.service.status()).profiles[0].connected, false);
  assert.equal((await f.service.status()).profiles[1].connected, true);
  f.setRevokeFails(true);
  await f.service.logout(second.id);
  assert.match((await f.service.status()).error!, /Remote revocation could not be confirmed/);
  assert.equal((await f.service.status()).profiles[1].connected, false);
});

test('scoped Pi transport preserves local tool names, adapts SIWC payloads, refreshes auth and rejects other endpoints', async t => {
  const f = await fixture(); t.after(() => f.close());
  const profile = await f.connect();
  const original = { model: 'available-model', input: [{ role: 'system', content: 'Review only.' }, { role: 'user', content: 'Inspect source.' }], tools: [{ type: 'function', name: 'project_read', parameters: {} }, { type: 'custom', name: 'codemode', format: { type: 'grammar' } }], max_output_tokens: 100, temperature: 0, metadata: {}, previous_response_id: 'previous', store: true, stream: false };
  const adapted = adaptChatgptResponsesPayload(original);
  assert.equal(adapted.store, false); assert.equal(adapted.stream, true);
  assert.equal(adapted.max_output_tokens, undefined); assert.equal(adapted.tools, undefined);
  assert.equal(adapted.input[0].type, 'additional_tools');
  assert.deepEqual(adapted.input[0].tools.map((tool: any) => tool.name), ['project_read', 'codemode']);
  assert.equal(adapted.input[1].role, 'developer');
  assert.equal(original.input[0].role, 'system', 'the hook must not mutate another provider’s payload');
  assert.throws(() => adaptChatgptResponsesPayload({ input: [], tools: [{ type: 'tool_search' }] }), /confined local/);
  let sent: Request | undefined;
  const transport = createChatgptFetch(f.service, profile.id, async (input, init) => { sent = new Request(input, init); return new Response('mock stream'); });
  await transport('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer dummy' }, body: JSON.stringify(adapted) });
  assert.equal(sent!.headers.get('authorization'), 'Bearer access-private-1');
  assert.equal(sent!.redirect, 'error');
  await assert.rejects(transport('https://other.example/v1/responses', { method: 'POST' }), /public Responses/);
  await assert.rejects(transport('https://api.openai.com/v1/responses?leak=yes', { method: 'POST' }), /public Responses/);
  await assert.rejects(transport('https://api.openai.com/v1/responses', { method: 'GET' }), /public Responses/);
  f.advance(56 * 60_000);
  await transport('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(adapted) });
  assert.equal(sent!.headers.get('authorization'), 'Bearer access-refreshed-1');
});
