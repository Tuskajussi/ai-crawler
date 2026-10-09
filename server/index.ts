import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Message, AuthSession as PublicSession } from '../shared/types';
import { AuthStore, AuthError, type AuthSession, type CreatedSession } from './auth';
import { readServerConfig, isLoopback, type ServerConfig } from './config';
import { Workspaces, type Workspace } from './workspaces';
import { InputError, validateModels, validateWorkflow } from './validation';
import { validateModelAccess, validateRunAccess } from './policy';

const COOKIE_NAME = 'crawlspace_session';
const unsafe = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
function tokenFrom(request: express.Request): string | undefined {
  const value = request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
function equalToken(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
class AuthAttempts {
  private readonly entries = new Map<string, {count: number; until: number}>();
  check(key: string): void {
    const now = Date.now();
    if (this.entries.size >= 10_000) for (const [id, item] of this.entries) if (item.until <= now) this.entries.delete(id);
    const old = this.entries.get(key);
    if (old && old.until > now) {
      if (old.count >= 20) throw new AuthError(429, 'Too many authentication attempts. Try again in 15 minutes.');
      old.count += 1;
    } else {
      if (this.entries.size >= 10_000) throw new AuthError(429, 'Authentication is busy. Try again later.');
      this.entries.set(key, {count: 1, until: now + 15 * 60_000});
    }
  }
}

export interface AppOptions { dataDir?: string; statePath?: string; registrationSecret?: string; demoStepMs?: number; config?: Partial<ServerConfig>; }
export async function createApp(options: AppOptions = {}) {
  const config = readServerConfig(process.env, { ...options.config, ...(options.dataDir ? {dataDir: options.dataDir} : options.statePath ? {dataDir: path.dirname(options.statePath)} : {}), ...(options.registrationSecret !== undefined ? {registrationSecret: options.registrationSecret} : {}) });
  const auth = await AuthStore.open(path.join(config.dataDir, 'auth.json'), { registrationSecret: config.registrationSecret });
  const workspaces = new Workspaces(config, auth, { legacyStatePath: options.statePath, demoStepMs: options.demoStepMs });
  const attempts = new AuthAttempts();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const secureCookie = config.publicUrl?.startsWith('https://') ?? false;
  const cookieOptions = { httpOnly: true, secure: secureCookie, sameSite: 'lax' as const, path: '/' };
  const clearCookie = (response: express.Response) => response.clearCookie(COOKIE_NAME, cookieOptions);
  const publicSession = (session: AuthSession | null): PublicSession => ({ user: session?.user ?? null, ...(session ? {csrfToken: session.csrfToken} : {}), registrationEnabled: auth.registrationEnabled });
  const sendSession = (response: express.Response, session: CreatedSession) => {
    response.cookie(COOKIE_NAME, session.token, {...cookieOptions, maxAge: Math.max(0, session.expiresAt - Date.now())});
    response.json(publicSession(session));
  };
  app.use((request, response, next) => {
    try {
      const host = request.get('host') || '';
      const parsedHost = new URL(`http://${host}`);
      if (parsedHost.username || parsedHost.password || parsedHost.pathname !== '/' || parsedHost.search || parsedHost.hash) throw new Error();
      const expected = config.publicUrl ? new URL(config.publicUrl).host.toLowerCase() : undefined;
      const internalHealth = request.path === '/api/health' && isLoopback(parsedHost.hostname);
      if (expected ? host.toLowerCase() !== expected && !internalHealth : !isLoopback(parsedHost.hostname)) throw new Error();
      const origin = request.get('origin');
      if (origin) {
        const url = new URL(origin);
        if (url.username || url.password || url.origin !== origin || (config.publicUrl ? origin !== config.publicUrl : !isLoopback(url.hostname) || !['http:', 'https:'].includes(url.protocol))) throw new Error();
      }
    } catch { response.status(403).json({error: 'This host or browser origin is not allowed.'}); return; }
    if (unsafe(request.method) && request.get('sec-fetch-site') === 'cross-site') { response.status(403).json({error: 'Cross-site requests are not allowed.'}); return; }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Cache-Control', 'no-store');
    if (config.hosted) {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
  });
  app.use('/api', (request, response, next) => {
    if (unsafe(request.method) && !request.is('application/json')) { response.status(415).json({error: 'Use application/json for API writes.'}); return; }
    next();
  });
  app.use(express.json({limit: '2mb'}));
  app.get('/api/health', (_request, response) => response.json({ok: true}));
  app.get('/api/auth/session', async (request, response) => {
    const token = tokenFrom(request);
    const session = token ? await auth.getSession(token) : null;
    if (request.headers.cookie && !session) clearCookie(response);
    response.json(publicSession(session));
  });
  app.post('/api/auth/register', async (request, response) => {
    attempts.check(request.ip || request.socket.remoteAddress || 'unknown');
    const body = request.body || {};
    const session = await auth.register(body.username, body.password, body.registrationSecret);
    // Initialize before issuing a cookie, including the first account's legacy workspace.
    await workspaces.get(session.user.id);
    response.status(201);
    sendSession(response, session);
  });
  app.post('/api/auth/login', async (request, response) => {
    attempts.check(request.ip || request.socket.remoteAddress || 'unknown');
    const session = await auth.login(request.body?.username, request.body?.password);
    sendSession(response, session);
  });
  app.use('/api', async (request, response, next) => {
    const token = tokenFrom(request);
    const session = token ? await auth.getSession(token) : null;
    if (!session) { clearCookie(response); response.status(401).json({error: 'Sign in to access your workspace.'}); return; }
    if (unsafe(request.method) && !equalToken(request.get('X-CSRF-Token') || '', session.csrfToken)) { response.status(403).json({error: 'Your security token is missing or expired. Refresh the page and try again.'}); return; }
    response.locals.session = session;
    response.locals.token = token;
    next();
  });
  app.post('/api/auth/logout', async (_request, response) => {
    await auth.logout(response.locals.token);
    clearCookie(response);
    response.json(publicSession(null));
  });
  app.post('/api/auth/password', async (request, response) => {
    attempts.check(`password:${response.locals.session.user.id}`);
    try { await auth.changePassword(response.locals.session.user.id, request.body?.currentPassword, request.body?.newPassword); }
    catch (error) { if (error instanceof AuthError && error.status === 401) throw new AuthError(400, 'Current password is incorrect.'); throw error; }
    clearCookie(response);
    response.json(publicSession(null));
  });
  app.use('/api', async (_request, response, next) => {
    response.locals.workspace = await workspaces.get(response.locals.session.user.id);
    next();
  });
  const workspaceFor = (response: express.Response) => response.locals.workspace as Workspace;
  app.get('/api/state', (_request, response) => response.json(workspaces.state(workspaceFor(response))));
  app.put('/api/workflow', async (request, response) => {
    const {store, engine, projectsRoot} = workspaceFor(response);
    if (engine.isRunning) throw new InputError('Stop the active run before editing the workflow.', 409);
    validateWorkflow(request.body, store.get().models);
    if (request.body.settings.executionMode === 'pi') await validateRunAccess(request.body, store.get().models, projectsRoot, config);
    const workflow = structuredClone(request.body);
    workflow.nodes.forEach((node: {data: {status: string}}) => { node.data.status = 'idle'; });
    await store.update(state => { state.workflow = workflow; });
    response.json(workspaces.state(workspaceFor(response)));
  });
  app.put('/api/models', async (request, response) => {
    const {store, engine} = workspaceFor(response);
    if (engine.isRunning) throw new InputError('Stop the active run before editing models.', 409);
    validateModels(request.body);
    validateModelAccess(request.body, config);
    validateWorkflow(store.get().workflow, request.body);
    await store.update(state => { state.models = structuredClone(request.body); });
    response.json(workspaces.state(workspaceFor(response)));
  });
  app.patch('/api/findings/:id', async (request, response) => {
    const {store} = workspaceFor(response);
    if (!['open', 'in_progress', 'resolved'].includes(request.body?.status)) throw new InputError('Finding status must be open, in_progress, or resolved.');
    await store.update(state => {
      const finding = state.findings.find(item => item.id === request.params.id);
      if (!finding) throw new InputError('Finding was not found.', 404);
      finding.status = request.body.status;
    });
    response.json(workspaces.state(workspaceFor(response)));
  });
  app.post('/api/messages', async (request, response) => {
    const {store} = workspaceFor(response);
    const body = request.body;
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000) throw new InputError('Write a message of 1–20,000 characters.');
    if (body.from !== 'you' || !['message', 'assignment'].includes(body.type)) throw new InputError('Messages must be from you and use type message or assignment.');
    if (body.to !== 'all' && !store.get().workflow.nodes.some(node => node.id === body.to)) throw new InputError('Message recipient was not found.');
    const message: Message = {id: randomUUID(), from: 'you', to: body.to, text: body.text.trim(), type: body.type, createdAt: new Date().toISOString()};
    await store.update(state => { state.messages.push(message); state.messages = state.messages.slice(-2000); });
    response.status(201).json(workspaces.state(workspaceFor(response)));
  });
  app.post('/api/runs', async (request, response) => {
    const workspace = workspaceFor(response);
    const mode = request.body?.mode;
    if (mode !== undefined && !['demo', 'pi'].includes(mode)) throw new InputError('Execution mode must be demo or pi.');
    const state = workspace.store.get();
    if ((mode ?? state.workflow.settings.executionMode) === 'pi') await validateRunAccess(state.workflow, state.models, workspace.projectsRoot, config);
    await workspace.engine.start(mode);
    response.status(202).json(workspaces.state(workspace));
  });
  app.post('/api/runs/stop', async (_request, response) => {
    const workspace = workspaceFor(response);
    await workspace.engine.stop();
    response.json(workspaces.state(workspace));
  });
  app.use('/api/screenshots', (request, response, next) => {
    express.static(path.join(workspaceFor(response).directory, 'screenshots'), {dotfiles: 'deny', index: false, fallthrough: true, setHeaders: res => res.setHeader('Cache-Control', 'private, no-store')})(request, response, next);
  });
  app.use('/api', (_request, response) => response.status(404).json({error: 'API route was not found.'}));
  const dist = path.resolve('dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const known = error instanceof InputError || error instanceof AuthError;
    const suggested = (error as {status?: number})?.status;
    const status = known ? error.status : suggested === 400 ? 400 : suggested === 413 ? 413 : 500;
    const message = known ? error.message : status === 400 ? 'Request JSON is invalid.' : status === 413 ? 'Request body is too large.' : 'Unexpected server error.';
    if (status === 500) console.error('API request failed:', error instanceof Error ? error.name : 'unknown error');
    if (status === 429) response.setHeader('Retry-After', '900');
    response.status(status).json({error: message});
  });
  return {app, auth, workspaces, config, shutdown: () => workspaces.shutdown()};
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  if (existsSync('.env')) loadEnvFile('.env');
  const runtime = await createApp();
  const {host, port} = runtime.config;
  const server = runtime.app.listen(port, host, () => console.log(`Crawlspace listening on ${host}:${port}; registration ${runtime.auth.registrationEnabled ? 'enabled' : 'closed'}.`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await runtime.shutdown();
    server.closeAllConnections();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}