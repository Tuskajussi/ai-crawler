import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Message } from '../shared/types';
import { StateStore } from './store';
import { WorkflowEngine } from './engine';
import { InputError, validateModels, validateWorkflow } from './validation';
import { createPiExecutor, piAvailable } from './pi';

export async function createApp(options: { statePath?: string; demoStepMs?: number } = {}) {
  const store = await StateStore.open(options.statePath);
  const stateDirectory = path.dirname(store.filePath);
  const engine = new WorkflowEngine(store, { piExecutor: createPiExecutor(stateDirectory), demoStepMs: options.demoStepMs });
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
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', async (_request, response) => {
    response.json({ ok: true, piAvailable: await piAvailable(), running: engine.isRunning, mode: 'local', readOnly: true });
  });
  app.get('/api/state', (_request, response) => response.json(store.get()));
  app.put('/api/workflow', async (request, response) => {
    if (engine.isRunning) throw new InputError('Stop the active run before editing the workflow.', 409);
    validateWorkflow(request.body, store.get().models);
    const workflow = structuredClone(request.body);
    workflow.nodes.forEach((node: { data: { status: string } }) => { node.data.status = 'idle'; });
    response.json(await store.update(state => { state.workflow = workflow; }));
  });
  app.put('/api/models', async (request, response) => {
    if (engine.isRunning) throw new InputError('Stop the active run before editing models.', 409);
    validateModels(request.body);
    validateWorkflow(store.get().workflow, request.body);
    response.json(await store.update(state => { state.models = structuredClone(request.body); }));
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
    const status = error instanceof InputError ? error.status : (error as { status?: number })?.status === 400 ? 400 : 500;
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    if (status === 500) console.error(error);
    response.status(status).json({ error: message });
  });
  return { app, store, engine };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { app, engine, store } = await createApp();
  const port = Number(process.env.CRAWLSPACE_PORT || 3001);
  const server = app.listen(port, '127.0.0.1', () => console.log(`Crawlspace API listening at http://127.0.0.1:${port}`));
  const shutdown = async () => {
    await engine.stop();
    await store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
