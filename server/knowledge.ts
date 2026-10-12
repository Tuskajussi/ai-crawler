import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChunkOptions, EmbeddingConfig, KnowledgeChunk, KnowledgeJob, KnowledgePreview, KnowledgeSearchResult, KnowledgeStatus } from '../shared/knowledge';
import { createEmbeddingExecutor, embeddingReadiness, embeddingSpaceKey, validateEmbeddingConfig } from './embedding-provider';
import { prepareKnowledgeSource, type PreparedSource } from './knowledge-media';
import { KnowledgeStore, knowledgeLimits, knowledgeStorageBytes, sourceDirectoryName, type StoredKnowledgeChunk, type StoredKnowledgeSource } from './knowledge-store';
import { InputError } from './validation';
import { ensureKnowledgeDirectory, readKnowledgeBinary } from './knowledge-files';

type Embed = ReturnType<typeof createEmbeddingExecutor>;
type Prepare = typeof prepareKnowledgeSource;
interface PreviewLease { public: KnowledgePreview; source: PreparedSource; key: string }
interface Activity { controller: AbortController; signal: AbortSignal; done: Promise<void>; finish: () => void }
const previewLifetime = 15 * 60_000;
const maxPreviewBytes = 256 * 1024 * 1024;
const chunkPublic = ({ vector: _vector, mediaFile: _file, ...chunk }: StoredKnowledgeChunk): KnowledgeChunk => chunk;
const preparedPublic = ({ payload: _payload, ...chunk }: PreparedSource['chunks'][number]): KnowledgeChunk => chunk;

function normalized(vector: number[], dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid embedding vector.');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding vector.');
  return vector.map(value => value / norm);
}

/** One explicit indexing/search operation at a time; sources publish atomically. */
export class KnowledgeService {
  private previews = new Map<string, PreviewLease>();
  private queue: Promise<unknown> = Promise.resolve();
  private job?: KnowledgeJob;
  private jobTask?: Promise<void>;
  private jobController?: AbortController;
  private preparing = false;
  private searching = false;
  private indexing = false;
  private disposed = false;
  private activity?: Activity;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private constructor(readonly store: KnowledgeStore, private embed: Embed, private prepare: Prepare) {}
  static async open(directory: string, options: { embed?: Embed; prepare?: Prepare } = {}): Promise<KnowledgeService> {
    const store = await KnowledgeStore.open(directory);
    const service = new KnowledgeService(store, options.embed ?? createEmbeddingExecutor(), options.prepare ?? prepareKnowledgeSource);
    await service.cleanOrphans();
    return service;
  }
  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const task = this.queue.catch(() => {}).then(operation);
    this.queue = task;
    return task;
  }
  private checkAvailable(): void {
    if (this.disposed) throw new InputError('The knowledge library is shutting down.', 503);
    if (this.indexing || this.searching || this.preparing) throw new InputError('Wait for the current knowledge operation to finish, or cancel it.', 409);
  }
  private checkConsent(config: EmbeddingConfig, allowed: unknown): void {
    if (config.kind === 'cloud' && allowed !== true) throw new InputError('Confirm the cloud upload before sending content or a search query to this provider.');
  }
  private beginActivity(signal: AbortSignal): Activity {
    signal.throwIfAborted();
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    return this.activity = { controller, signal: AbortSignal.any([signal, controller.signal]), done, finish };
  }
  private endActivity(activity: Activity): void {
    if (this.activity === activity) this.activity = undefined;
    activity.finish();
  }
  private sourcePath(id: string): string {
    const directory = path.resolve(this.store.directory, sourceDirectoryName(id));
    if (path.dirname(directory) !== this.store.directory) throw new Error('Invalid knowledge source path.');
    return directory;
  }
  private async cleanOrphans(): Promise<void> {
    const retained = new Set(this.store.snapshot().sources.map(source => sourceDirectoryName(source.id)));
    let entries;
    try { entries = await readdir(this.store.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory() && /^source-[a-f0-9-]{36}$/.test(entry.name) && !retained.has(entry.name)) {
        await rm(this.sourcePath(entry.name.slice(7)), { recursive: true, force: true });
      }
    }
  }
  private async expire(): Promise<void> {
    for (const [id, preview] of this.previews) if (Date.parse(preview.public.expiresAt) <= Date.now()) {
      this.previews.delete(id);
      await preview.source.dispose();
    }
    if (!this.previews.size && this.expiryTimer) { clearInterval(this.expiryTimer); this.expiryTimer = undefined; }
  }
  status(): KnowledgeStatus {
    const state = this.store.summary();
    const key = embeddingSpaceKey(state.config);
    return {
      config: state.config, readiness: embeddingReadiness(state.config), limits: { ...knowledgeLimits },
      sources: state.sources.map(({ hash: _hash, storedBytes: _bytes, ...source }) => ({ ...source, compatible: source.spaceKey === key })),
      ...(this.job ? { job: structuredClone(this.job) } : {}),
    };
  }
  async configure(config: unknown): Promise<KnowledgeStatus> {
    return this.exclusive(async () => {
      this.checkAvailable();
      validateEmbeddingConfig(config);
      await this.store.update(state => { state.config = structuredClone(config); });
      return this.status();
    });
  }
  async preview(input: Parameters<Prepare>[0]): Promise<KnowledgePreview> {
    let activity!: Activity;
    await this.exclusive(async () => {
      this.checkAvailable(); await this.expire(); this.checkAvailable();
      if (this.previews.size >= 2) throw new InputError('Discard an existing preview before preparing another source.', 409);
      activity = this.beginActivity(input.signal); this.preparing = true;
    });
    let source: PreparedSource | undefined;
    try {
      source = await this.prepare({ ...input, signal: activity.signal });
      activity.signal.throwIfAborted();
      const prepared = source;
      return await this.exclusive(async () => {
        if (this.disposed) throw new InputError('The knowledge library is shutting down.', 503);
        const bytes = [...this.previews.values()].reduce((sum, item) => sum + item.source.chunks.reduce((n, chunk) => n + (chunk.payload?.length ?? Buffer.byteLength(chunk.text ?? '')), 0), 0)
          + prepared.chunks.reduce((sum, chunk) => sum + (chunk.payload?.length ?? Buffer.byteLength(chunk.text ?? '')), 0);
        if (bytes > maxPreviewBytes) throw new InputError('Prepared previews exceed the 256 MB allowance. Discard a preview or use a smaller source.');
        const preview: KnowledgePreview = { id: randomUUID(), name: prepared.name, modality: prepared.modality, bytes: prepared.bytes,
          chunks: prepared.chunks.map(preparedPublic), expiresAt: new Date(Date.now() + previewLifetime).toISOString() };
        // Bind consent to the exact destination shown with the preview.
        this.previews.set(preview.id, { public: preview, source: prepared, key: embeddingSpaceKey(this.store.snapshot().config) });
        if (!this.expiryTimer) {
          this.expiryTimer = setInterval(() => { void this.exclusive(() => this.expire()).catch(() => {}); }, 30_000);
          this.expiryTimer.unref();
        }
        source = undefined;
        return structuredClone(preview);
      });
    } finally {
      try { await source?.dispose(); }
      finally { await this.exclusive(() => { this.preparing = false; this.endActivity(activity); }); }
    }
  }
  async discard(id: string): Promise<void> {
    await this.exclusive(async () => { const preview = this.previews.get(id); this.previews.delete(id); await preview?.source.dispose(); await this.expire(); });
  }
  async index(previewId: unknown, allowCloudUpload: unknown): Promise<KnowledgeJob> {
    return this.exclusive(async () => {
      this.checkAvailable(); await this.expire(); this.checkAvailable();
      if (typeof previewId !== 'string') throw new InputError('Choose a prepared source.');
      const preview = this.previews.get(previewId);
      if (!preview) throw new InputError('The preview expired or was already used. Prepare this source again.', 404);
      const state = this.store.snapshot();
      const config = state.config;
      const key = embeddingSpaceKey(config);
      if (preview.key !== key) throw new InputError('The embedding destination changed. Prepare a new preview before creating embeddings.', 409);
      this.checkConsent(config, allowCloudUpload);
      const readiness = embeddingReadiness(config);
      if (!readiness.ready) throw new InputError(readiness.message);
      if (config.provider === 'compatible' && preview.source.chunks.some(chunk => chunk.modality !== 'text')) throw new InputError('This compatible endpoint accepts text chunks. Choose Gemini for PDF, image, audio or video chunks.');
      const hash = createHash('sha256').update(preview.source.hash).update(preview.source.name).update(key).update(JSON.stringify(preview.source.chunks.map(chunk => [chunk.modality, chunk.locator, chunk.text]))).digest('hex');
      if (state.sources.some(source => source.hash === hash)) throw new InputError('This source and chunk plan are already indexed with the selected embedding model.', 409);
      if (state.sources.length >= knowledgeLimits.sources || state.sources.reduce((sum, source) => sum + source.chunkCount, 0) + preview.source.chunks.length > knowledgeLimits.totalChunks) throw new InputError('The library is limited to 100 sources and 1,000 chunks. Remove a source before adding more.');
      const storedBytes = preview.source.chunks.reduce((sum, chunk) => sum + (chunk.payload?.length ?? Buffer.byteLength(chunk.text ?? '')), 0);
      if (state.sources.reduce((sum, source) => sum + source.storedBytes, 0) + storedBytes > knowledgeStorageBytes) throw new InputError('The library has reached its 1 GB content allowance. Remove a source before adding more.');
      this.previews.delete(previewId);
      if (!this.previews.size && this.expiryTimer) { clearInterval(this.expiryTimer); this.expiryTimer = undefined; }
      const controller = new AbortController(); this.jobController = controller;
      this.indexing = true;
      this.job = { id: randomUUID(), sourceName: preview.public.name, status: 'running', completedChunks: 0, totalChunks: preview.source.chunks.length, startedAt: new Date().toISOString() };
      const job = this.job;
      this.jobTask = Promise.resolve().then(() => this.performIndex(preview.source, config, key, hash, storedBytes, allowCloudUpload === true, job, controller));
      return structuredClone(job);
    });
  }
  private async performIndex(source: PreparedSource, config: EmbeddingConfig, spaceKey: string, hash: string, storedBytes: number, allowCloudUpload: boolean, job: KnowledgeJob, controller: AbortController): Promise<void> {
    const id = randomUUID();
    let directoryCreated = false;
    let committed = false;
    let outcome: KnowledgeJob['status'] = 'failed';
    let message: string | undefined;
    try {
      const chunks: StoredKnowledgeChunk[] = [];
      for (const chunk of source.chunks) {
        controller.signal.throwIfAborted();
        const vector = normalized(await this.embed(config, { title: source.name, ...(chunk.text !== undefined ? { text: chunk.text } : {}),
          ...(chunk.payload ? { media: { mimeType: chunk.mimeType, data: chunk.payload } } : {}) }, { purpose: 'document', signal: controller.signal, allowCloudUpload }), config.dimensions);
        controller.signal.throwIfAborted();
        chunks.push({ ...preparedPublic(chunk), vector, ...(chunk.payload ? { mediaFile: `chunk-${chunk.index}.bin` } : {}) });
        job.completedChunks = chunks.length;
      }
      await this.exclusive(async () => {
        controller.signal.throwIfAborted();
        const directory = this.sourcePath(id);
        await ensureKnowledgeDirectory(directory); directoryCreated = true;
        for (const chunk of source.chunks) if (chunk.payload) {
          controller.signal.throwIfAborted();
          await writeFile(path.join(directory, `chunk-${chunk.index}.bin`), chunk.payload, { flag: 'wx', mode: 0o600 });
        }
        controller.signal.throwIfAborted();
        const record: StoredKnowledgeSource = { id, name: source.name, modality: source.modality, bytes: source.bytes, storedBytes, chunkCount: chunks.length,
          dimensions: config.dimensions, modelId: config.modelId, spaceKey, hash, createdAt: new Date().toISOString(), chunks };
        await this.store.update(state => { state.sources.push(record); });
        committed = true;
        outcome = 'completed';
      });
    } catch (error) {
      outcome = controller.signal.aborted ? 'cancelled' : 'failed';
      message = controller.signal.aborted ? 'Embedding creation was cancelled. No partial source was indexed.'
        : error instanceof InputError ? error.message : 'Embedding creation failed. Check the provider and available local storage; no partial source was indexed.';
    } finally {
      try {
        try { if (directoryCreated && !committed) await rm(this.sourcePath(id), { recursive: true, force: true }); }
        finally { await source.dispose(); }
      } catch {
        message = committed ? 'The source was indexed, but local temporary cleanup needs attention.' : 'The source was not indexed, but local temporary cleanup needs attention.';
      } finally {
        this.indexing = false;
        job.status = outcome; job.finishedAt = new Date().toISOString();
        if (committed) job.sourceId = id;
        if (message) job.error = message;
      }
    }
  }
  async cancel(id: string): Promise<KnowledgeStatus> {
    await this.exclusive(() => {
      if (!this.job || this.job.id !== id) throw new InputError('Embedding job was not found.', 404);
      if (this.job.status === 'running') this.jobController?.abort();
    });
    await this.jobTask;
    return this.status();
  }
  async search(input: { query?: unknown; limit?: unknown; sourceIds?: unknown; allowCloudUpload?: unknown }, signal: AbortSignal): Promise<KnowledgeSearchResult[]> {
    let activity!: Activity;
    let config!: EmbeddingConfig;
    let sources!: StoredKnowledgeSource[];
    const limit = input.limit ?? 8;
    await this.exclusive(() => {
      this.checkAvailable();
      if (typeof input.query !== 'string' || !input.query.trim() || Buffer.byteLength(input.query, 'utf8') > 6000) throw new InputError('Write a search query of 1-6,000 UTF-8 bytes.');
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20) throw new InputError('Search result limit must be from 1 to 20.');
      if (input.sourceIds !== undefined && (!Array.isArray(input.sourceIds) || input.sourceIds.length > 100 || input.sourceIds.some(id => typeof id !== 'string'))) throw new InputError('Choose up to 100 source IDs.');
      const state = this.store.snapshot(); config = state.config;
      this.checkConsent(config, input.allowCloudUpload);
      const ids = input.sourceIds as string[] | undefined;
      if (ids?.some(id => !state.sources.some(source => source.id === id))) throw new InputError('A selected source was not found.', 404);
      sources = state.sources.filter(source => source.spaceKey === embeddingSpaceKey(config) && (!ids || ids.includes(source.id)));
      if (!sources.length) throw new InputError('No sources match the selected embedding model and dimensions. Index a source with this configuration first.');
      activity = this.beginActivity(signal); this.searching = true;
    });
    try {
      const query = normalized(await this.embed(config, { text: (input.query as string).trim() }, { purpose: 'query', signal: activity.signal, allowCloudUpload: input.allowCloudUpload === true }), config.dimensions);
      activity.signal.throwIfAborted();
      return sources.flatMap(source => source.chunks.map(chunk => ({ sourceId: source.id, sourceName: source.name, chunk: chunkPublic(chunk),
        score: Math.max(-1, Math.min(1, chunk.vector.reduce((sum, value, index) => sum + value * query[index], 0))) })))
        .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.chunk.index - b.chunk.index).slice(0, limit as number);
    } finally { await this.exclusive(() => { this.searching = false; this.endActivity(activity); }); }
  }
  async removeSource(id: string): Promise<KnowledgeStatus> {
    return this.exclusive(async () => {
      this.checkAvailable();
      if (!this.store.snapshot().sources.some(source => source.id === id)) throw new InputError('Knowledge source was not found.', 404);
      await ensureKnowledgeDirectory(this.store.directory);
      await this.store.update(state => { state.sources = state.sources.filter(source => source.id !== id); }, { mirrorBackup: true });
      await rm(this.sourcePath(id), { recursive: true, force: true });
      return this.status();
    });
  }
  exportSource(id: string) {
    const source = this.store.snapshot().sources.find(item => item.id === id);
    if (!source) throw new InputError('Knowledge source was not found.', 404);
    return { version: 1, source: { ...source, compatible: source.spaceKey === embeddingSpaceKey(this.store.summary().config),
      chunks: source.chunks.map(chunk => ({ ...chunk, contentUrl: `/api/knowledge/sources/${encodeURIComponent(source.id)}/chunks/${encodeURIComponent(chunk.id)}/content` })) },
      note: 'Vectors and source locations use the recorded embedding space. Media content is available from the local chunk download routes.' };
  }
  async content(sourceId: string, chunkId: string): Promise<{ data: Buffer; mimeType: string; name: string }> {
    const source = this.store.snapshot().sources.find(item => item.id === sourceId);
    const chunk = source?.chunks.find(item => item.id === chunkId);
    if (!source || !chunk) throw new InputError('Knowledge chunk was not found.', 404);
    const extension = ({ 'text/plain': 'txt', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4' } as Record<string, string>)[chunk.mimeType];
    let data: Buffer;
    try { data = chunk.mediaFile ? await readKnowledgeBinary(this.store.directory, sourceId, chunk.mediaFile) : Buffer.from(chunk.text ?? '', 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InputError('This chunk is no longer available.', 404); throw error; }
    return { data, mimeType: chunk.mimeType, name: `${path.parse(source.name).name}-chunk-${chunk.index + 1}.${extension ?? 'bin'}` };
  }
  async dispose(): Promise<void> {
    this.disposed = true; clearInterval(this.expiryTimer); this.jobController?.abort(); this.activity?.controller.abort();
    await Promise.all([this.jobTask, this.activity?.done]);
    await this.exclusive(async () => {
      const previews = [...this.previews.values()]; this.previews.clear();
      const outcomes = await Promise.allSettled(previews.map(preview => preview.source.dispose()));
      const failed = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(item => item.reason), 'Some knowledge previews could not be cleaned up.');
    });
    await this.store.flush();
  }
}

export function registerKnowledgeRoutes(app: express.Express, service: KnowledgeService) {
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<unknown>>();
  let previewRequest = false;
  const tracked = async <T>(response: express.Response, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController(); controllers.add(controller);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    const task = Promise.resolve().then(() => operation(controller.signal)); tasks.add(task);
    try { return await task; }
    finally { controllers.delete(controller); tasks.delete(task); response.removeListener('close', disconnect); }
  };
  app.get('/api/knowledge', (_request, response) => response.json(service.status()));
  app.put('/api/knowledge/config', async (request, response) => response.json(await service.configure(request.body)));
  app.post('/api/knowledge/preview', (_request, response, next) => {
    // Admit before buffering binary uploads, so concurrent requests cannot each
    // allocate the full upload allowance while waiting for one preparation.
    if (previewRequest) { next(new InputError('Wait for the current source upload or preparation to finish.', 409)); return; }
    previewRequest = true;
    const release = () => { previewRequest = false; response.removeListener('finish', release); response.removeListener('close', release); };
    response.once('finish', release); response.once('close', release); next();
  }, express.raw({ type: 'application/octet-stream', limit: knowledgeLimits.uploadBytes }), async (request, response) => {
    let name: string; let mimeType: string; let data: Buffer; let options: Partial<ChunkOptions> | undefined;
    if (Buffer.isBuffer(request.body)) {
      try { name = decodeURIComponent(request.get('X-File-Name') ?? ''); } catch { throw new InputError('Choose a valid filename.'); }
      mimeType = request.get('X-File-Type') ?? 'application/octet-stream'; data = request.body;
      if (request.get('X-Chunk-Options')) {
        try { options = JSON.parse(request.get('X-Chunk-Options')!); } catch { throw new InputError('Invalid chunk settings.'); }
      }
    } else {
      if (!request.body || typeof request.body.name !== 'string' || typeof request.body.text !== 'string') throw new InputError('Provide a filename and text, or choose a file.');
      name = request.body.name; mimeType = 'text/plain'; data = Buffer.from(request.body.text, 'utf8'); options = request.body.options;
    }
    response.json(await tracked(response, signal => service.preview({ name, data, mimeType, options, signal })));
  });
  app.delete('/api/knowledge/previews/:id', async (request, response) => { await service.discard(request.params.id); response.sendStatus(204); });
  app.post('/api/knowledge/index', async (request, response) => response.status(202).json(await service.index(request.body?.previewId, request.body?.allowCloudUpload)));
  app.post('/api/knowledge/jobs/:id/cancel', async (request, response) => response.json(await service.cancel(request.params.id)));
  app.post('/api/knowledge/search', async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new InputError('Provide a search query.');
    response.json({ results: await tracked(response, signal => service.search(request.body, signal)) });
  });
  app.delete('/api/knowledge/sources/:id', async (request, response) => response.json(await service.removeSource(request.params.id)));
  app.get('/api/knowledge/sources/:id/export', (request, response) => {
    response.setHeader('Content-Disposition', `attachment; filename="knowledge-${request.params.id}.json"`);
    response.json(service.exportSource(request.params.id));
  });
  app.get('/api/knowledge/sources/:sourceId/chunks/:chunkId/content', async (request, response) => {
    const content = await service.content(request.params.sourceId, request.params.chunkId);
    response.setHeader('Content-Type', content.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(content.name)}`);
    response.send(content.data);
  });
  return async () => {
    for (const controller of controllers) controller.abort();
    try { await service.dispose(); }
    finally { await Promise.allSettled([...tasks]); }
  };
}
