import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, constants, type JsonWebKey } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Express } from 'express';
import { InputError } from './validation';

// Public-client SIWC contract: https://developers.openai.com/siwc/token-sharing-open-source
const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const authorizeEndpoint = `${issuer}/api/accounts/authorize`;
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const directScope = 'chatgpt.tokens.use.direct';
const scopes = `openid profile email offline_access resource.invoke ${directScope}`;
const loginLifetime = 10 * 60_000;
const requestTimeout = 15_000;
const maximumFileBytes = 2_000_000;

type Tokens = { access?: string; refresh?: string; idToken: string; expiresAt: number; scopes: string[]; earliestRefreshAt?: number };
type Profile = { id: string; clientId: string; label: string; issuer?: string; subject?: string; email?: string; tokens?: Tokens };
type CredentialData = { version: 1; hostId: string; activeProfileId?: string; profiles: Profile[] };
export type ChatgptProfile = { id: string; clientId: string; label: string; subject?: string; email?: string; connected: boolean; sharing: boolean };
export type ChatgptStatus = { profiles: ChatgptProfile[]; activeProfileId?: string; pending?: { id: string; profileId?: string; url: string; expiresAt: number }; error?: string };
export type ChatgptModel = { id: string; name: string; contextWindow?: number; supportsImages?: boolean };
type Pending = NonNullable<ChatgptStatus['pending']> & { state: string; nonce: string; verifier: string; redirectUri: string; clientId?: string; server: Server; timer: ReturnType<typeof setTimeout>; handling: boolean; abort: AbortController; completion?: Promise<void> };
type Fetch = typeof globalThis.fetch;
export type ChatgptOptions = { fetch?: Fetch; now?: () => number; credentialDirectory?: string; appName?: string };

export class ChatgptError extends InputError {
  constructor(message: string, status = 400, public code?: string, public requestId?: string) { super(message, status); }
}

function nonempty(value: unknown, maximum = 10_000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum; }
function equal(a: unknown, b: string) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function localProfile(profile: Profile): ChatgptProfile {
  return { id: profile.id, clientId: profile.clientId, label: profile.label, subject: profile.subject, email: profile.email, connected: !!profile.tokens, sharing: !!profile.tokens?.access && profile.tokens.scopes.includes(directScope) };
}
function profileFor(data: CredentialData, id?: string): Profile {
  const profile = data.profiles.find(item => item.id === (id ?? data.activeProfileId));
  if (!profile) throw new ChatgptError('Choose a saved ChatGPT account or continue with ChatGPT first.', 400);
  return profile;
}
function isTerminalRefresh(code?: string) { return !!code && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code); }
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

// Windows' current-user DPAPI keeps OAuth secrets protected even if a project is shared.
// Secrets travel through stdin/stdout, never command arguments or environment variables.
async function dpapi(value: string, decrypt: boolean): Promise<string> {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new ChatgptError('Windows could not protect ChatGPT credentials in time.', 500)); }, requestTimeout);
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > maximumFileBytes * 2) child.kill(); });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new ChatgptError('Windows credential protection is unavailable. ChatGPT credentials were not saved.', 500)); });
    child.once('close', code => { clearTimeout(timer); code === 0 && /^[A-Za-z0-9+/=]+$/.test(output.trim()) ? resolve(output.trim()) : reject(new ChatgptError('Windows could not protect or open this user’s ChatGPT credentials.', 500)); });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

export class ChatgptService {
  readonly credentialDirectory: string;
  private readonly file: string;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly appName: string;
  private pending?: Pending;
  private startingLogin = false;
  private loginGeneration = 0;
  private loginStart?: Promise<{ url: string }>;
  private disposed = false;
  private error?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private discovery?: { expires: number; jwksUri: string; revocationEndpoint: string };
  private jwks?: { expires: number; keys: JsonWebKey[] };

  constructor(stateDirectory: string, options: ChatgptOptions = {}) {
    const installation = createHash('sha256').update(path.resolve(stateDirectory)).digest('hex').slice(0, 24);
    const userData = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local') : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
    this.credentialDirectory = options.credentialDirectory ?? path.join(userData, 'Crawlspace', 'chatgpt', installation);
    this.file = path.join(this.credentialDirectory, 'credentials.json');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.appName = options.appName ?? 'Crawlspace';
  }

  private async read(): Promise<CredentialData> {
    let text: string;
    try {
      if ((await stat(this.file)).size > maximumFileBytes) throw new Error('Too large');
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      throw new ChatgptError('ChatGPT credential storage could not be read. Existing credentials were left unchanged.', 500);
    }
    try {
      let data = JSON.parse(text);
      if (process.platform === 'win32') {
        if (data.protection !== 'dpapi-current-user' || !nonempty(data.payload, maximumFileBytes * 2)) throw new Error('Unprotected credentials');
        data = JSON.parse(Buffer.from(await dpapi(data.payload, true), 'base64').toString('utf8'));
      }
      if (data.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/.test(data.hostId) || !Array.isArray(data.profiles) || data.profiles.length > 100) throw new Error('Invalid credential format');
      for (const profile of data.profiles) {
        if (!profile || !nonempty(profile.id, 100) || !nonempty(profile.clientId, 200) || !nonempty(profile.label, 500)) throw new Error('Invalid account');
        if (profile.tokens && (!nonempty(profile.tokens.idToken, 100_000) || !Array.isArray(profile.tokens.scopes) || !profile.tokens.scopes.every((scope: unknown) => nonempty(scope, 200)) || !Number.isFinite(profile.tokens.expiresAt))) throw new Error('Invalid tokens');
      }
      return data as CredentialData;
    } catch { throw new ChatgptError('ChatGPT credential storage is invalid or belongs to another Windows user. Existing credentials were left unchanged.', 500); }
  }

  private async save(data: CredentialData, commitGuard?: () => void): Promise<void> {
    let text = JSON.stringify(data);
    if (process.platform === 'win32') text = JSON.stringify({ version: 1, protection: 'dpapi-current-user', payload: await dpapi(Buffer.from(text).toString('base64'), false) });
    const temporary = path.join(this.credentialDirectory, `.credentials-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      commitGuard?.();
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  // Both instances in this process and separate local server processes serialize rotations.
  private withData<T>(operation: (data: CredentialData) => Promise<T> | T, commitGuard?: () => void): Promise<T> {
    const work = this.chain.catch(() => {}).then(async () => {
      await mkdir(this.credentialDirectory, { recursive: true, mode: 0o700 });
      const lock = `${this.file}.lock`;
      const deadline = Date.now() + 30_000;
      let handle;
      while (!handle) {
        try { handle = await open(lock, 'wx', 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          try { if (Date.now() - (await stat(lock)).mtimeMs > 120_000) { await rm(lock, { force: true }); continue; } } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          if (Date.now() >= deadline) throw new ChatgptError('Another process is updating ChatGPT credentials. Try again shortly.', 409);
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      }
      try {
        const data = await this.read();
        const before = JSON.stringify(data);
        const existed = await stat(this.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        const result = await operation(data);
        commitGuard?.();
        if (!existed || JSON.stringify(data) !== before) await this.save(data, commitGuard);
        return result;
      } finally { await handle.close(); await rm(lock, { force: true }); }
    });
    this.chain = work;
    return work;
  }

  async status(): Promise<ChatgptStatus> {
    const data = await this.read();
    const pending = this.pending;
    return { profiles: data.profiles.map(localProfile), activeProfileId: data.activeProfileId, ...(pending ? { pending: { id: pending.id, profileId: pending.profileId, url: pending.url, expiresAt: pending.expiresAt } } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  async profileReadiness(profileId?: string): Promise<{ ready: boolean; message: string }> {
    const data = await this.read();
    const profile = data.profiles.find(item => item.id === (profileId ?? data.activeProfileId));
    if (!profile?.tokens) return { ready: false, message: 'Continue with ChatGPT to connect this account.' };
    if (!profile.tokens.scopes.includes(directScope)) return { ready: false, message: 'ChatGPT sign-in succeeded, but permission to use your ChatGPT plan was not granted. Reconnect to enable it.' };
    if (!profile.tokens.access || (profile.tokens.expiresAt <= this.now() && !profile.tokens.refresh)) return { ready: false, message: 'This ChatGPT connection expired. Reconnect the saved account.' };
    return { ready: true, message: 'ChatGPT plan permission is configured. Model access has not been tested.' };
  }

  async login(profileId?: string): Promise<{ url: string }> {
    if (this.disposed) throw new ChatgptError('The ChatGPT connection service has stopped.', 503);
    if (this.pending || this.startingLogin) throw new ChatgptError('A ChatGPT sign-in is already waiting in your browser. Complete or cancel it first.', 409);
    this.startingLogin = true;
    const generation = ++this.loginGeneration;
    const work = this.startLogin(profileId, generation);
    this.loginStart = work;
    try { return await work; } finally { this.startingLogin = false; if (this.loginStart === work) this.loginStart = undefined; }
  }

  private async startLogin(profileId: string | undefined, generation: number): Promise<{ url: string }> {
    const current = () => { if (this.disposed || generation !== this.loginGeneration) throw new ChatgptError('This ChatGPT sign-in was cancelled.'); };
    const registration = await this.withData(data => ({ hostId: data.hostId, profile: profileId ? structuredClone(profileFor(data, profileId)) : undefined }));
    current();
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => {
      const pending = this.pending;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') { response.writeHead(404).end('Not found.'); return; }
      if (!pending || pending.handling || pending.server !== server || this.now() >= pending.expiresAt || !equal(url.searchParams.get('state'), pending.state)) { response.writeHead(400).end('Sign-in state did not match. Return to Crawlspace and try again.'); return; }
      pending.handling = true;
      clearTimeout(pending.timer);
      const completion = this.completeLogin(pending, url);
      pending.completion = completion;
      void completion.then(() => {
        response.end('ChatGPT connected. Return to Crawlspace.');
      }, error => {
        if (this.pending === pending && !pending.abort.signal.aborted) this.error = error instanceof ChatgptError ? error.message : 'ChatGPT sign-in could not be completed. Try again.';
        response.writeHead(400).end('ChatGPT sign-in could not be completed. Return to Crawlspace for details.');
      }).finally(() => this.closePending(pending));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    try { current(); } catch (error) { server.closeAllConnections(); server.close(); throw error; }
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new ChatgptError('The ChatGPT sign-in callback could not start.', 500); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(authorizeEndpoint);
    const enablePlanUsage = !!registration.profile?.tokens && !registration.profile.tokens.scopes.includes(directScope);
    url.search = new URLSearchParams({ client_id: registration.profile?.clientId ?? 'dynamic_agent_client', ...(registration.profile ? {} : { agent_name_hint: this.appName }), ext_agent_host_id: registration.hostId, response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource, state, nonce, ...(enablePlanUsage ? { prompt: 'consent' } : {}), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    // The no-hint returning flow is documented and avoids sending an ID token through the UI.
    const pending: Pending = { id: randomUUID(), profileId, clientId: registration.profile?.clientId, url: url.toString(), expiresAt: this.now() + loginLifetime, state, nonce, verifier, redirectUri, server, handling: false, abort: new AbortController(), timer: setTimeout(() => { this.error = 'ChatGPT sign-in expired. Continue with ChatGPT to try again.'; this.closePending(pending); }, loginLifetime) };
    pending.timer.unref();
    this.pending = pending;
    this.error = undefined;
    return { url: pending.url };
  }

  private closePending(pending: Pending) { clearTimeout(pending.timer); if (this.pending === pending) this.pending = undefined; pending.server.close(); pending.server.closeIdleConnections(); }
  async cancelLogin(): Promise<void> {
    this.loginGeneration++;
    const pending = this.pending;
    if (pending) { pending.abort.abort(); pending.server.closeAllConnections(); this.closePending(pending); }
    await this.loginStart?.catch(() => {});
    await pending?.completion?.catch(() => {});
    this.error = undefined;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.cancelLogin(); await this.chain.catch(() => {}); }

  private async completeLogin(pending: Pending, callback: URL) {
    const current = () => { pending.abort.signal.throwIfAborted(); if (this.pending !== pending) throw new ChatgptError('This ChatGPT sign-in was cancelled.'); };
    current();
    if (callback.searchParams.has('error')) throw new ChatgptError('ChatGPT sign-in or plan permission was declined. You can continue with ChatGPT again when ready.');
    const code = callback.searchParams.get('code');
    const returnedClient = callback.searchParams.get('client_id');
    const clientId = pending.clientId ?? returnedClient;
    if (!nonempty(code, 4000) || !nonempty(clientId, 200) || clientId === 'dynamic_agent_client' || (pending.clientId && returnedClient && pending.clientId !== returnedClient)) throw new ChatgptError('ChatGPT returned an incomplete or mismatched account registration.');
    // Retain the issued registration even if the one-use authorization code exchange fails.
    const profileId = await this.withData(data => {
      if (pending.profileId) return profileFor(data, pending.profileId).id;
      if (data.profiles.length >= 100) throw new ChatgptError('Too many saved ChatGPT accounts.');
      const profile: Profile = { id: randomUUID(), clientId, label: `ChatGPT account ${data.profiles.length + 1}` };
      data.profiles.push(profile);
      pending.profileId = profile.id;
      return profile.id;
    });
    current();
    const token = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource }), pending.abort.signal);
    const identity = await this.verifyIdentity(token.id_token, clientId, pending.nonce);
    const credentials = this.parseTokens(token);
    await this.withData(data => {
      current();
      const profile = profileFor(data, profileId);
      if (profile.clientId !== clientId || (profile.subject && (profile.subject !== identity.sub || profile.issuer !== identity.iss))) throw new ChatgptError('The signed-in ChatGPT account does not match the selected saved account.');
      profile.issuer = identity.iss;
      profile.subject = identity.sub;
      profile.email = identity.email;
      profile.label = `${identity.email || 'ChatGPT account'} · ${profile.id.slice(0, 6)}`;
      profile.tokens = credentials;
      data.activeProfileId = profile.id;
    }, current);
    this.error = credentials.scopes.includes(directScope) ? undefined : 'ChatGPT is connected, but plan usage permission was not granted. Reconnect to enable plan usage, or choose an API key model.';
  }

  private async jsonRequest(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    const endpoint = new URL(url);
    if (![issuer, 'https://api.openai.com'].includes(endpoint.origin) || endpoint.username || endpoint.password || endpoint.hash) throw new ChatgptError('ChatGPT credentials may only be sent to official OpenAI endpoints.');
    const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(requestTimeout), ...(signal ? [signal] : [])]) });
    const text = await response.text();
    let body: any;
    try { if (text.length > maximumFileBytes) throw new Error(); body = text ? JSON.parse(text) : {}; } catch { if (response.ok) throw new ChatgptError('ChatGPT returned an invalid response. Try again later.', 502); body = {}; }
    if (!response.ok) {
      const candidate = body?.error?.code ?? (typeof body?.error === 'string' ? body.error : body?.code);
      const code = typeof candidate === 'string' && /^[a-zA-Z0-9_.-]{1,150}$/.test(candidate) ? candidate : undefined;
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const message = code === 'subscription_sharing_usage_limit_exceeded' ? 'This app’s ChatGPT usage limit was reached. Review ChatGPT Settings → Usage before trying again.' : code === 'subscription_sharing_user_not_eligible' ? 'ChatGPT plan usage is unavailable for this account or workspace.' : response.status === 401 ? 'ChatGPT did not accept this account’s sign-in. Reconnect the saved account.' : response.status === 403 ? 'ChatGPT did not permit this request for the selected account or workspace.' : `ChatGPT request failed (${response.status}${code ? `, ${code}` : ''}).`;
      throw new ChatgptError(message, response.status >= 500 ? 503 : response.status, code, requestId);
    }
    return body;
  }

  private tokenRequest(body: URLSearchParams, signal?: AbortSignal) { return this.jsonRequest(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body }, signal); }

  private parseTokens(token: any, retainedIdToken?: string): Tokens {
    if (!token || typeof token !== 'object' || !nonempty(token.scope, 5000) || (token.token_type !== undefined && String(token.token_type).toLowerCase() !== 'bearer')) throw new ChatgptError('ChatGPT returned an invalid token response.');
    const granted = token.scope.trim().split(/\s+/);
    const access = nonempty(token.access_token, 100_000) ? token.access_token : undefined;
    const refresh = nonempty(token.refresh_token, 100_000) ? token.refresh_token : undefined;
    const idToken = nonempty(token.id_token, 100_000) ? token.id_token : retainedIdToken;
    if (!idToken || (granted.includes(directScope) && !access) || (access && (!Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 86_400))) throw new ChatgptError('ChatGPT returned incomplete credentials. Reconnect the saved account.');
    const earliest = typeof token.earliest_refresh_at === 'number' ? token.earliest_refresh_at * (token.earliest_refresh_at < 1e12 ? 1000 : 1) : typeof token.earliest_refresh_at === 'string' ? Date.parse(token.earliest_refresh_at) : undefined;
    return { access, refresh, idToken, expiresAt: access ? this.now() + token.expires_in * 1000 : 0, scopes: granted, ...(earliest && Number.isFinite(earliest) ? { earliestRefreshAt: earliest } : {}) };
  }

  private async getDiscovery() {
    if (this.discovery && this.discovery.expires > this.now()) return this.discovery;
    const data = await this.jsonRequest(`${issuer}/.well-known/openid-configuration`);
    const trusted = (value: unknown) => { if (typeof value !== 'string') throw new ChatgptError('OpenAI identity discovery is incomplete.', 502); const url = new URL(value); if (url.origin !== issuer || url.username || url.password || url.hash) throw new ChatgptError('OpenAI identity discovery returned an unexpected endpoint.', 502); return value; };
    if (data.issuer !== issuer) throw new ChatgptError('OpenAI identity discovery returned an unexpected issuer.', 502);
    this.discovery = { expires: this.now() + 5 * 60_000, jwksUri: trusted(data.jwks_uri), revocationEndpoint: trusted(data.revocation_endpoint) };
    return this.discovery;
  }

  private async verifyIdentity(value: unknown, clientId: string, nonce?: string): Promise<{ iss: string; sub: string; email?: string }> {
    if (!nonempty(value, 100_000)) throw new ChatgptError('ChatGPT did not return an ID token.');
    let header: any; let claims: any; let parts: string[];
    try { parts = value.split('.'); if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error(); header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { throw new ChatgptError('ChatGPT returned an invalid ID token.'); }
    if (!['RS256', 'PS256', 'ES256'].includes(header.alg) || header.crit || !nonempty(header.kid, 200)) throw new ChatgptError('ChatGPT ID token uses an unsupported signing key.');
    const discovery = await this.getDiscovery();
    const keys = async (force = false) => {
      if (force || !this.jwks || this.jwks.expires <= this.now()) {
        const data = await this.jsonRequest(discovery.jwksUri);
        if (!Array.isArray(data.keys) || data.keys.length > 100) throw new ChatgptError('OpenAI identity signing keys are invalid.', 502);
        this.jwks = { expires: this.now() + 5 * 60_000, keys: data.keys };
      }
      return this.jwks.keys;
    };
    let key = (await keys()).find(key => key.kid === header.kid);
    if (!key) key = (await keys(true)).find(key => key.kid === header.kid);
    if (!key || (key.use && key.use !== 'sig') || (key.alg && key.alg !== header.alg) || (header.alg === 'ES256' ? key.kty !== 'EC' || key.crv !== 'P-256' : key.kty !== 'RSA')) throw new ChatgptError('ChatGPT ID token signing key could not be verified.');
    try {
      const publicKey = createPublicKey({ key, format: 'jwk' });
      if ((header.alg !== 'ES256' && (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) || !verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, ...(header.alg === 'PS256' ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : {}), ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}) }, Buffer.from(parts[2], 'base64url'))) throw new Error();
    } catch { throw new ChatgptError('ChatGPT ID token signature could not be verified.'); }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audience.includes(clientId) || (claims.azp !== undefined && claims.azp !== clientId) || (audience.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.iat) || claims.iat * 1000 > this.now() + 60_000 || !Number.isFinite(claims.exp) || claims.exp <= claims.iat || claims.exp * 1000 <= this.now() || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > this.now() + 60_000)) || !nonempty(claims.sub, 300) || (nonce !== undefined && !equal(claims.nonce, nonce))) throw new ChatgptError('ChatGPT ID token identity, expiry, or sign-in nonce did not match.');
    return { iss: claims.iss, sub: claims.sub, ...(nonempty(claims.email, 320) ? { email: claims.email } : {}) };
  }

  async select(profileId: string): Promise<void> {
    await this.withData(data => { const profile = profileFor(data, profileId); if (!profile.tokens) throw new ChatgptError('Reconnect this ChatGPT account before selecting it.'); data.activeProfileId = profile.id; });
    this.error = undefined;
  }

  async logout(profileId?: string): Promise<void> {
    if (this.pending) await this.cancelLogin();
    let remoteConfirmed = true;
    await this.withData(async data => {
      const profile = profileFor(data, profileId);
      if (profile.tokens?.refresh) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const discovery = await this.getDiscovery();
            await this.jsonRequest(discovery.revocationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.tokens.refresh, token_type_hint: 'refresh_token', client_id: profile.clientId }) });
            remoteConfirmed = true;
            break;
          } catch (error) {
            remoteConfirmed = false;
            if (attempt === 1 || (error instanceof ChatgptError && error.status < 500)) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      }
      delete profile.tokens;
      if (data.activeProfileId === profile.id) delete data.activeProfileId;
    });
    this.error = remoteConfirmed ? undefined : 'Signed out locally. Remote revocation could not be confirmed; disconnect Crawlspace in ChatGPT Settings → Security and login if needed.';
  }

  async accessToken(profileId?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const work = this.withData(async data => {
      signal?.throwIfAborted();
      const profile = profileFor(data, profileId);
      let tokens = profile.tokens;
      if (!tokens || !tokens.scopes.includes(directScope) || (!tokens.access && !tokens.refresh)) return { error: new ChatgptError('Connect this ChatGPT account and grant permission to use its plan before running this model.', 401) };
      if (tokens.expiresAt - this.now() <= 5 * 60_000 && (!tokens.earliestRefreshAt || this.now() >= tokens.earliestRefreshAt)) {
        if (!tokens.refresh) return { error: new ChatgptError('This ChatGPT connection needs a new sign-in. Reconnect the saved account.', 401) };
        try {
          // Once refresh starts, persist the rotated token even if the requesting run is stopped.
          const response = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: tokens.refresh, resource }));
          if (nonempty(response?.refresh_token, 100_000)) profile.tokens = { ...tokens, refresh: response.refresh_token, expiresAt: 0 };
          const refreshed = this.parseTokens(response, tokens.idToken);
          if (!refreshed.refresh) throw new ChatgptError('ChatGPT did not return a replacement refresh token. Reconnect the saved account.', 401);
          // The rotated token above survives later identity/key verification failure.
          if (response.id_token) { const identity = await this.verifyIdentity(response.id_token, profile.clientId); if (identity.sub !== profile.subject || identity.iss !== profile.issuer) throw new ChatgptError('ChatGPT refreshed credentials for a different account.', 401); }
          profile.tokens = tokens = refreshed;
        } catch (error) {
          if (error instanceof ChatgptError && isTerminalRefresh(error.code)) delete profile.tokens;
          return { error: error instanceof ChatgptError ? error : new ChatgptError('ChatGPT token renewal is temporarily unavailable. Try again later.', 503) };
        }
      }
      if (!tokens.access || !tokens.scopes.includes(directScope)) return { error: new ChatgptError('ChatGPT plan permission is no longer enabled. Reconnect the saved account.', 401) };
      if (tokens.expiresAt <= this.now()) return { error: new ChatgptError('This ChatGPT connection expired. Reconnect the saved account.', 401) };
      return { token: tokens.access };
    });
    const result = await abortable(work, signal);
    signal?.throwIfAborted();
    if (result.error) throw result.error;
    return result.token!;
  }

  async listModels(profileId?: string, signal?: AbortSignal): Promise<ChatgptModel[]> {
    const token = await this.accessToken(profileId, signal);
    const data = await this.jsonRequest(`${resource}/models`, { headers: { Authorization: `Bearer ${token}` } }, signal);
    if (!Array.isArray(data.models)) throw new ChatgptError('ChatGPT model discovery returned an unexpected catalog.', 502);
    return data.models.filter((model: any) => model?.visibility === 'list' && nonempty(model.slug, 300)).map((model: any) => ({ id: model.slug, name: nonempty(model.display_name, 300) ? model.display_name : model.slug, ...(Number.isInteger(model.context_window) && model.context_window > 0 ? { contextWindow: model.context_window } : {}), ...(Array.isArray(model.input_modalities) ? { supportsImages: model.input_modalities.includes('image') } : {}) }));
  }
}

export function registerChatgptRoutes(app: Express, options: { service: ChatgptService; isRunning?: () => boolean; runWhenIdle?: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const { service } = options;
  const profileId = (body: any, required = false) => { const value = body?.profileId; if ((value !== undefined && !nonempty(value, 100)) || (required && value === undefined)) throw new ChatgptError('Choose a saved ChatGPT account.'); return value as string | undefined; };
  const idle = () => { if (options.isRunning?.()) throw new ChatgptError('Stop the active run before changing ChatGPT connections.', 409); };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => { if (options.runWhenIdle) return options.runWhenIdle(operation); idle(); return operation(); };
  app.get(['/api/chatgpt', '/api/chatgpt/status'], async (_request, response) => response.json(await service.status()));
  app.post('/api/chatgpt/login', async (request, response) => response.json(await mutate(() => service.login(profileId(request.body)))));
  app.post('/api/chatgpt/cancel', async (_request, response) => response.json(await mutate(async () => { await service.cancelLogin(); return service.status(); })));
  app.post('/api/chatgpt/select', async (request, response) => response.json(await mutate(async () => { await service.select(profileId(request.body, true)!); return service.status(); })));
  app.post('/api/chatgpt/logout', async (request, response) => response.json(await mutate(async () => { await service.logout(profileId(request.body, true)); return service.status(); })));
  app.get('/api/chatgpt/models', async (request, response) => response.json({ models: await service.listModels(profileId({ profileId: request.query.profileId })) }));
}

// Scoped Pi onPayload hook: plain local tools are supplied through additional_tools,
// preserving tool names/call results and Code Mode without changing global providers.
export function adaptChatgptResponsesPayload(payload: unknown): Record<string, any> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChatgptError('ChatGPT Responses payload must be an object.');
  const result = structuredClone(payload) as Record<string, any>;
  for (const name of ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'prompt_cache_options', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']) delete result[name];
  if (!Array.isArray(result.input)) throw new ChatgptError('ChatGPT subscription requests must include their full input context.');
  result.input = result.input.map((item: any) => item && item.role === 'system' ? { ...item, role: 'developer' } : item);
  if (Array.isArray(result.tools) && result.tools.length) {
    if (result.tools.some((tool: any) => !tool || !['function', 'custom'].includes(tool.type))) throw new ChatgptError('This ChatGPT integration supports confined local function and Code Mode tools only.');
    result.input.unshift({ type: 'additional_tools', role: 'developer', tools: result.tools });
  }
  delete result.tools;
  result.store = false;
  result.stream = true;
  return result;
}

export function createChatgptFetch(service: ChatgptService, profileId?: string, fetcher: Fetch = globalThis.fetch): Fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${resource}/responses` || request.method !== 'POST') throw new ChatgptError('ChatGPT plan credentials may only be sent to the public Responses endpoint.');
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${await service.accessToken(profileId, request.signal)}`);
    return fetcher(new Request(request, { headers, redirect: 'error' }));
  };
}
