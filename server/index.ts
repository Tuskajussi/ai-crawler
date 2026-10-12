import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Message } from '../shared/types';
import { StateStore } from './store';
import { WorkflowEngine } from './engine';
import { InputError, validateModels, validateWorkflow, validateRoutingSettings } from './validation';
import { createPiExecutor, modelReadiness, piAvailable } from './pi';
import { ChatgptService, registerChatgptRoutes, type ChatgptOptions } from './chatgpt';
import { probeModel } from './probe';
import { pruneScreenshots } from './screenshots';
import { createRoutingExecutor } from './routing';
import { initialState } from '../shared/defaults';
import { KnowledgeService, registerKnowledgeRoutes } from './knowledge';
import { ReliabilityStore } from './reliability';

export async function createApp(options: { statePath?: string; demoStepMs?: number; chatgptOptions?: ChatgptOptions; knowledgeOptions?: Parameters<typeof KnowledgeService.open>[1] } = {}) {
  const store = await StateStore.open(options.statePath);
  const stateDirectory = path.dirname(store.filePath);
  const reliability = await ReliabilityStore.open(path.join(stateDirectory, 'reliability.json'));
  const chatgpt = new ChatgptService(stateDirectory, options.chatgptOptions);
  let pendingScreenshots: () => string[] = () => [];
  const retainedScreenshots = () => [...store.get().findings.flatMap(finding => finding.screenshot ? [finding.screenshot] : []), ...pendingScreenshots()];
  await pruneScreenshots(path.join(stateDirectory, 'screenshots'), retainedScreenshots());
  const engine = new WorkflowEngine(store, { piExecutor: createPiExecutor(stateDirectory, { chatgpt, retainedScreenshots, reliability }), routingExecutor: createRoutingExecutor(), demoStepMs: options.demoStepMs });
  pendingScreenshots = () => engine.pendingScreenshots;
  const knowledge = await KnowledgeService.open(path.join(stateDirectory, 'knowledge'), options.knowledgeOptions);
  let shutdownKnowledge = () => knowledge.dispose();
  const probeControllers = new Set<AbortController>();
  const probeTasks = new Set<Promise<unknown>>();
  let shuttingDown = false;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    shuttingDown = true;
    for (const controller of probeControllers) controller.abort();
    shutdownTask = (async () => {
      const errors: unknown[] = [];
      const knowledgeDrain = shutdownKnowledge().catch(error => { errors.push(error); });
      // A failed state save must still allow credential rotations and probes to drain.
      for (const drain of [() => engine.stop(), () => engine.waitForIdle(), () => knowledgeDrain, () => Promise.allSettled([...probeTasks]), () => chatgpt.dispose(), () => store.flush(), () => reliability.flush()]) {
        try { await drain(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Crawlspace could not save all shutdown state.');
    })();
    return shutdownTask;
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    // This is a local workspace service: a random website must not submit runs.
    try {
      const host = new URL(`http://${request.get('host') || ''}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) throw new Error();
    } catch { response.status(403).json({ error: 'Only local hostnames are allowed.' }); return; }
    const origin = request.get('origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
      } catch { response.status(403).json({ error: 'Only local browser origins are allowed.' }); return; }
    }
    response.setHeader('Cache-Control', 'no-store');
    if (shuttingDown) { response.status(503).json({ error: 'Crawlspace is shutting down. Restart it before making changes or starting work.' }); return; }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  // A request body may have started arriving before shutdown began.
  app.use((_request, response, next) => {
    if (shuttingDown) { response.status(503).json({ error: 'Crawlspace is shutting down. Restart it before making changes or starting work.' }); return; }
    next();
  });
  registerChatgptRoutes(app, { service: chatgpt, isRunning: () => engine.isRunning, runWhenIdle: operation => engine.whenIdle(operation) });
  shutdownKnowledge = registerKnowledgeRoutes(app, knowledge);
  app.get('/api/reliability', (_request, response) => response.json(reliability.snapshot()));
  app.get('/api/health', async (_request, response) => {
    const models = await Promise.all(store.get().models.map(async model => modelReadiness(model, process.env, model.authMethod === 'chatgpt' ? await chatgpt.profileReadiness(model.chatgptProfileId) : undefined)));
    response.json({ ok: true, piAvailable: await piAvailable(), models, running: engine.isRunning, mode: 'local', readOnly: true });
  });
  app.post('/api/models/:id/probe', async (request, response) => {
    if (engine.isRunning) throw new InputError('Stop the active run before testing a model connection.', 409);
    const controller = new AbortController();
    probeControllers.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    const task = engine.whenIdle(async () => {
      if (controller.signal.aborted) throw new InputError('Connection check stopped.', 409);
      const model = store.get().models.find(item => item.id === request.params.id);
      if (!model) throw new InputError('Model was not found.', 404);
      return probeModel(model, stateDirectory, chatgpt, controller.signal);
    });
    probeTasks.add(task);
    try { response.json(await task); }
    finally { probeTasks.delete(task); probeControllers.delete(controller); response.removeListener('close', disconnect); }
  });
  app.post('/api/routing/probe', async (request, response) => {
    validateRoutingSettings(request.body);
    if (engine.isRunning) throw new InputError('Stop the active run before testing a decision connection.', 409);
    const routing = structuredClone(request.body);
    const controller = new AbortController();
    probeControllers.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    const task = engine.whenIdle(async () => {
      if (controller.signal.aborted) throw new InputError('Decision connection check stopped.', 409);
      const fixture = structuredClone(initialState);
      const node = fixture.workflow.nodes[0];
      node.data.modelId = 'qwen'; node.data.tools = ['read'];
      node.data.prompt = 'Inspect a small source file for an ordinary empty-list handling issue.';
      node.data.responsibilities = ['Read-only source review'];
      fixture.workflow.nodes = [node]; fixture.workflow.edges = [];
      fixture.workflow.settings = { ...fixture.workflow.settings, routing: { ...routing, mode: 'shadow' }, projectPath: '', previewUrl: '', supervisorModelId: 'claude' };
      try {
        const answer = await createRoutingExecutor()({ workflow: fixture.workflow, models: fixture.models, node,
          run: { id: randomUUID(), status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 }, cycle: 1, messages: [], findings: [], signal: controller.signal });
        return { ready: true, message: 'The decision endpoint returned a valid typed choice and probability distribution. Accuracy still needs shadow evaluation.', answer };
      } catch {
        return { ready: false, message: controller.signal.aborted ? 'Decision connection check stopped.' : 'The decision connection failed. Check its URL, model ID, API key environment variable and server capabilities.' };
      }
    });
    probeTasks.add(task);
    try { response.json(await task); }
    finally { probeTasks.delete(task); probeControllers.delete(controller); response.removeListener('close', disconnect); }
  });
  app.get('/api/state', (_request, response) => response.json(store.get()));
  app.put('/api/workflow', async (request, response) => {
    response.json(await engine.whenIdle(async () => {
      validateWorkflow(request.body, store.get().models);
      const workflow = structuredClone(request.body);
      workflow.nodes.forEach((node: { data: { status: string } }) => { node.data.status = 'idle'; });
      return store.update(state => { state.workflow = workflow; });
    }));
  });
  app.put('/api/models', async (request, response) => {
    response.json(await engine.whenIdle(async () => {
      validateModels(request.body);
      validateWorkflow(store.get().workflow, request.body);
      return store.update(state => { state.models = structuredClone(request.body); });
    }));
  });
  app.patch('/api/findings/:id', async (request, response) => {
    if (!['open', 'in_progress', 'resolved'].includes(request.body?.status)) throw new InputError('Finding status must be open, in_progress, or resolved.');
    response.json(await store.update(state => {
      const finding = state.findings.find(item => item.id === request.params.id);
      if (!finding) throw new InputError('Finding was not found.', 404);
      finding.status = request.body.status;
    }));
  });
  app.post('/api/messages', async (request, response) => {
    const body = request.body;
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000) throw new InputError('Write a message of 1–20,000 characters.');
    if (body.from !== 'you' || !['message', 'assignment'].includes(body.type)) throw new InputError('Messages must be from you and use type message or assignment.');
    if (body.to !== 'all' && !store.get().workflow.nodes.some(node => node.id === body.to)) throw new InputError('Message recipient was not found.');
    const message: Message = { id: randomUUID(), from: 'you', to: body.to, text: body.text.trim(), type: body.type, createdAt: new Date().toISOString() };
    response.status(201).json(await store.update(state => { state.messages.push(message); state.messages = state.messages.slice(-2000); }));
  });
  app.post('/api/runs', async (request, response) => {
    const mode = request.body?.mode;
    if (mode !== undefined && !['demo', 'pi'].includes(mode)) throw new InputError('Execution mode must be demo or pi.');
    await engine.start(mode);
    response.status(202).json(store.get());
  });
  app.post('/api/runs/stop', async (_request, response) => {
    await engine.stop();
    response.json(store.get());
  });
  app.use('/api/screenshots', express.static(path.join(stateDirectory, 'screenshots'), { dotfiles: 'deny', index: false }));
  app.use('/api', (_request, response) => response.status(404).json({ error: 'API route was not found.' }));
  const dist = path.resolve('dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const incomingStatus = (error as { status?: number })?.status;
    const status = error instanceof InputError ? error.status : incomingStatus === 400 || incomingStatus === 413 ? incomingStatus : 500;
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    if (status === 500) console.error(error);
    response.status(status).json({ error: message });
  });
  return { app, store, engine, chatgpt, knowledge, reliability, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { app, shutdown } = await createApp();
  const port = Number(process.env.CRAWLSPACE_PORT || 3001);
  const server = app.listen(port, '127.0.0.1', () => console.log(`Crawlspace API listening at http://127.0.0.1:${port}`));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    // Stop accepting new connections before any asynchronous resource drain.
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await shutdown();
      server.closeAllConnections();
      await closed;
      process.exit(0);
    } catch (error) {
      console.error('Crawlspace could not finish a durable shutdown:', error);
      server.closeAllConnections();
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}
