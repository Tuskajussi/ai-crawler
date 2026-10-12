import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import type { EmbeddingConfig } from '../shared/knowledge';
import { defaultEmbeddingConfig } from '../shared/knowledge';
import type { EmbeddingExecutor } from './embedding-provider';
import type { PreparedSource } from './knowledge-media';
import { KnowledgeService } from './knowledge';
import { sourceDirectoryName } from './knowledge-store';
import { createApp } from './index';

const local: EmbeddingConfig = { ...defaultEmbeddingConfig, provider: 'compatible', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', modelId: 'test-embedding', dimensions: 3 };
const cloud: EmbeddingConfig = { ...defaultEmbeddingConfig, provider: 'vertex', apiKeyEnv: '', projectId: 'test-project', dimensions: 128 };
const unit = (dimensions: number, first = 1) => Array.from({ length: dimensions }, (_value, index) => index === 0 ? first : 0);
const input = (text: string, name = 'notes.txt', options?: { textCharacters?: number; textOverlap?: number }) => ({ name, mimeType: 'text/plain', data: Buffer.from(text), signal: new AbortController().signal, ...(options ? { options } : {}) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

async function finished(service: KnowledgeService) {
  const deadline = Date.now() + 5000;
  while (service.status().job?.status === 'running') {
    if (Date.now() > deadline) throw new Error('The fake embedding job did not finish.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return service.status();
}

async function fixture(options: Parameters<typeof KnowledgeService.open>[1] = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-knowledge-service-'));
  const service = await KnowledgeService.open(directory, { embed: async config => unit(config.dimensions), ...options });
  return { directory, service, async dispose() {
    await service.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  } };
}

function prepared(name: string, contents: string[], dispose: () => Promise<void> = async () => {}): PreparedSource {
  return { name, modality: 'text', bytes: Buffer.byteLength(contents.join('')), hash: createHash('sha256').update(contents.join('')).digest('hex'), dispose,
    chunks: contents.map((text, index) => ({ id: randomUUID(), index, modality: 'text', mimeType: 'text/plain', text, preview: text, locator: { startLine: index + 1, endLine: index + 1 } })) };
}

test('previewing and reading status remain local while every cloud index and query requires explicit consent', async () => {
  const calls: { purpose: string; allowCloudUpload: boolean }[] = [];
  const context = await fixture({ embed: async (config, _input, options) => { calls.push(options); return unit(config.dimensions); } });
  try {
    await context.service.configure(cloud);
    const preview = await context.service.preview(input('A private paragraph.'));
    assert.equal(calls.length, 0);
    assert.equal(context.service.status().sources.length, 0);
    assert.ok(!JSON.stringify(preview).includes('payload'));
    await assert.rejects(context.service.index(preview.id, false), /Confirm the cloud upload/);
    assert.equal(calls.length, 0);
    await context.service.index(preview.id, true); const state = await finished(context.service);
    assert.equal(state.job?.status, 'completed'); assert.equal(calls.length, 1);
    await assert.rejects(context.service.search({ query: 'paragraph', allowCloudUpload: false }, new AbortController().signal), /Confirm the cloud upload/);
    assert.equal(calls.length, 1);
    await context.service.search({ query: 'paragraph', allowCloudUpload: true }, new AbortController().signal);
    assert.deepEqual(calls.map(call => [call.purpose, call.allowCloudUpload]), [['document', true], ['query', true]]);
  } finally { await context.dispose(); }
});

test('all chunk vectors publish together, survive restart and retain text locations without leaking into status', async () => {
  const context = await fixture({ embed: async () => [3, 4, 0] }); let reopened: KnowledgeService | undefined;
  try {
    await context.service.configure(local);
    const text = 'A searchable line.\n'.repeat(30);
    const preview = await context.service.preview(input(text, 'reference.md', { textCharacters: 200, textOverlap: 20 }));
    assert.ok(preview.chunks.length > 1);
    await context.service.index(preview.id, false); const state = await finished(context.service);
    assert.equal(state.job?.completedChunks, preview.chunks.length); assert.equal(state.sources.length, 1);
    const serializedStatus = JSON.stringify(state);
    for (const key of ['"vector"', '"chunks"', '"payload"', '"mediaFile"', '"hash"']) assert.ok(!serializedStatus.includes(key));
    const exported = context.service.exportSource(state.sources[0].id);
    assert.equal(exported.source.chunks.length, preview.chunks.length);
    assert.deepEqual(exported.source.chunks[0].vector, [0.6, 0.8, 0]);
    assert.deepEqual(exported.source.chunks[0].locator, preview.chunks[0].locator);
    await context.service.dispose();
    reopened = await KnowledgeService.open(context.directory, { embed: async () => [3, 4, 0] });
    const results = await reopened.search({ query: 'searchable line' }, new AbortController().signal);
    assert.equal(results.length, Math.min(8, preview.chunks.length));
    assert.ok(results.every(result => Math.abs(result.score - 1) < 1e-12));
    assert.equal((await reopened.content(state.sources[0].id, preview.chunks[0].id)).data.toString(), preview.chunks[0].text);
    assert.equal((await readFile(path.join(context.directory, 'index.json'), 'utf8')).includes('"vector":[0.6,0.8,0]'), true);
  } finally { await reopened?.dispose(); await context.dispose(); }
});

test('native PDF pages retain exact downloadable bytes through indexing and restart', async () => {
  const document = await PDFDocument.create(); document.addPage([200, 200]); document.addPage([300, 300]);
  const context = await fixture(); let reopened: KnowledgeService | undefined;
  try {
    await context.service.configure(cloud);
    const preview = await context.service.preview({ name: 'manual.pdf', mimeType: 'application/pdf', data: Buffer.from(await document.save()), signal: new AbortController().signal });
    assert.equal(preview.chunks.length, 2); assert.deepEqual(preview.chunks.map(chunk => chunk.locator.pageStart), [1, 2]);
    await context.service.index(preview.id, true); const state = await finished(context.service);
    assert.equal(state.job?.status, 'completed');
    const source = state.sources[0]; const saved = await context.service.content(source.id, preview.chunks[0].id);
    assert.equal(saved.mimeType, 'application/pdf'); assert.equal((await PDFDocument.load(saved.data)).getPageCount(), 1);
    await context.service.dispose(); reopened = await KnowledgeService.open(context.directory, { embed: async config => unit(config.dimensions) });
    assert.deepEqual((await reopened.content(source.id, preview.chunks[0].id)).data, saved.data);
    const exported = reopened.exportSource(source.id);
    assert.equal(exported.source.chunks[0].mediaFile, 'chunk-0.bin');
    assert.ok(!JSON.stringify(reopened.status()).includes('mediaFile'));
    await reopened.removeSource(source.id);
    await assert.rejects(readFile(path.join(context.directory, sourceDirectoryName(source.id), 'chunk-0.bin')), /ENOENT/);
    await assert.rejects(reopened.content(source.id, preview.chunks[0].id), /not found/);
  } finally { await reopened?.dispose(); await context.dispose(); }
});

test('cancellation waits for provider drain and disposes source work without committing any partial source', async () => {
  const entered = deferred<void>(); const release = deferred<number[]>(); let providerSignal: AbortSignal | undefined; let disposed = 0;
  const context = await fixture({ prepare: async () => prepared('cancel.txt', ['first', 'second'], async () => { disposed++; }), embed: async (_config, _input, options) => { providerSignal = options.signal; entered.resolve(); return release.promise; } });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('anything'));
    const job = await context.service.index(preview.id, false); await entered.promise;
    let cancelled = false; const cancellation = context.service.cancel(job.id).then(state => { cancelled = true; return state; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(providerSignal?.aborted, true); assert.equal(cancelled, false); assert.equal(disposed, 0);
    await assert.rejects(context.service.configure(local), /current knowledge operation/);
    release.resolve([1, 0, 0]); const state = await cancellation;
    assert.equal(state.job?.status, 'cancelled'); assert.equal(state.sources.length, 0); assert.equal(disposed, 1);
    assert.equal((await readdir(context.directory)).some(name => name.startsWith('source-')), false);
  } finally { release.resolve([1, 0, 0]); await context.dispose(); }
});

test('index failure after earlier valid chunks never publishes vectors, media or provider error contents', async () => {
  let calls = 0; let disposed = 0;
  const context = await fixture({ prepare: async () => prepared('failed.txt', ['first', 'second'], async () => { disposed++; }), embed: async () => ++calls === 1 ? [1, 0, 0] : [0, 0, 0] });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('anything'));
    await context.service.index(preview.id, false); const state = await finished(context.service);
    assert.equal(calls, 2); assert.equal(state.job?.status, 'failed'); assert.equal(state.job?.completedChunks, 1); assert.equal(disposed, 1); assert.equal(state.sources.length, 0);
    assert.equal((await readdir(context.directory)).some(name => name.startsWith('source-')), false);
    assert.equal(JSON.parse(await readFile(path.join(context.directory, 'index.json'), 'utf8')).sources.length, 0);
  } finally { await context.dispose(); }
});

test('busy indexing excludes config changes, preparation, search and source mutations while status stays readable', async () => {
  const entered = deferred<void>(); const release = deferred<number[]>();
  const context = await fixture({ embed: async () => { entered.resolve(); return release.promise; } });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('One paragraph.'));
    const job = await context.service.index(preview.id, false); await entered.promise;
    assert.equal(context.service.status().job?.id, job.id);
    for (const operation of [() => context.service.configure(local), () => context.service.preview(input('Another paragraph.')), () => context.service.index(preview.id, false),
      () => context.service.search({ query: 'paragraph' }, new AbortController().signal), () => context.service.removeSource(randomUUID())]) {
      await assert.rejects(operation(), /current knowledge operation/);
    }
    release.resolve([1, 0, 0]); assert.equal((await finished(context.service)).job?.status, 'completed');
  } finally { release.resolve([1, 0, 0]); await context.dispose(); }
});

test('busy searches keep the captured index stable and reject overlapping config and source changes', async () => {
  const entered = deferred<void>(); const release = deferred<number[]>();
  const context = await fixture({ embed: async (_config, _input, options) => { if (options.purpose === 'query') { entered.resolve(); return release.promise; } return [1, 0, 0]; } });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('One paragraph.')); await context.service.index(preview.id, false);
    const state = await finished(context.service); const sourceId = state.sources[0].id;
    const searching = context.service.search({ query: 'paragraph' }, new AbortController().signal); await entered.promise;
    for (const operation of [() => context.service.configure(local), () => context.service.preview(input('Another paragraph.')),
      () => context.service.search({ query: 'overlap' }, new AbortController().signal), () => context.service.removeSource(sourceId)]) {
      await assert.rejects(operation(), /current knowledge operation/);
    }
    assert.equal(context.service.exportSource(sourceId).source.name, 'notes.txt');
    release.resolve([1, 0, 0]); assert.equal((await searching)[0].sourceId, sourceId);
    assert.equal((await context.service.configure(local)).sources.length, 1);
  } finally { release.resolve([1, 0, 0]); await context.dispose(); }
});

test('deduplication distinguishes embedded titles and chunk plans while rejecting the identical source plan', async () => {
  const context = await fixture();
  try {
    await context.service.configure(local); const text = 'A paragraph with searchable content. '.repeat(25);
    const first = await context.service.preview(input(text, 'first-title.txt', { textCharacters: 200, textOverlap: 0 })); await context.service.index(first.id, false); await finished(context.service);
    const duplicate = await context.service.preview(input(text, 'first-title.txt', { textCharacters: 200, textOverlap: 0 }));
    await assert.rejects(context.service.index(duplicate.id, false), /already indexed/); await context.service.discard(duplicate.id);
    const renamed = await context.service.preview(input(text, 'second-title.txt', { textCharacters: 200, textOverlap: 0 }));
    await context.service.index(renamed.id, false); await finished(context.service);
    const differentPlan = await context.service.preview(input(text, 'first-title.txt', { textCharacters: 400, textOverlap: 0 }));
    await context.service.index(differentPlan.id, false); const state = await finished(context.service);
    assert.equal(state.sources.length, 3); assert.notEqual(state.sources[0].chunkCount, state.sources[2].chunkCount);
  } finally { await context.dispose(); }
});

test('destination changes invalidate previews and keep incompatible vectors out of search', async () => {
  let calls = 0; const context = await fixture({ embed: async config => { calls++; return unit(config.dimensions); } });
  try {
    await context.service.configure(local); const saved = await context.service.preview(input('Saved paragraph.'));
    await context.service.index(saved.id, false); await finished(context.service);
    const pending = await context.service.preview(input('Pending paragraph.'));
    await context.service.configure({ ...local, dimensions: 2 });
    assert.equal(context.service.status().sources[0].compatible, false);
    await assert.rejects(context.service.index(pending.id, false), /destination changed/);
    await assert.rejects(context.service.search({ query: 'paragraph' }, new AbortController().signal), /No sources match/);
    assert.equal(calls, 1);
    await context.service.configure(local); assert.equal(context.service.status().sources[0].compatible, true);
    assert.equal((await context.service.search({ query: 'paragraph' }, new AbortController().signal))[0].sourceName, 'notes.txt');
  } finally { await context.dispose(); }
});

test('search ranks normalized vectors and returns source locations without vector or media internals', async () => {
  const context = await fixture({ prepare: async () => prepared('rank.txt', ['apple', 'road', 'opposite']), embed: async (_config, source, options) => options.purpose === 'query' || source.text === 'apple' ? [9, 0, 0] : source.text === 'road' ? [0, 8, 0] : [-4, 0, 0] });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('anything'));
    await context.service.index(preview.id, false); const state = await finished(context.service);
    const results = await context.service.search({ query: 'apple', sourceIds: [state.sources[0].id], limit: 3 }, new AbortController().signal);
    assert.deepEqual(results.map(result => result.chunk.text), ['apple', 'road', 'opposite']);
    assert.deepEqual(results.map(result => result.score), [1, 0, -1]);
    assert.deepEqual(results.map(result => result.chunk.locator.startLine), [1, 2, 3]);
    assert.ok(results.every(result => result.sourceName === 'rank.txt'));
    assert.ok(!JSON.stringify(results).includes('vector')); assert.ok(!JSON.stringify(results).includes('mediaFile'));
    for (const invalid of [{ query: '' }, { query: 'x'.repeat(6001) }, { query: 'apple', limit: 0 }, { query: 'apple', limit: 21 }, { query: 'apple', sourceIds: [randomUUID()] }]) {
      await assert.rejects(context.service.search(invalid, new AbortController().signal));
    }
  } finally { await context.dispose(); }
});

test('unused previews are disposed, consumed previews cannot be reused, and startup removes only orphan source directories', async () => {
  let disposed = 0; const context = await fixture({ prepare: async source => prepared(source.name, ['fixture'], async () => { disposed++; }) }); let reopened: KnowledgeService | undefined;
  try {
    await context.service.configure(local);
    const unused = await context.service.preview(input('one')); await context.service.discard(unused.id); assert.equal(disposed, 1);
    const consumed = await context.service.preview(input('two')); await context.service.index(consumed.id, false); await finished(context.service);
    await assert.rejects(context.service.index(consumed.id, false), /expired or was already used/); assert.equal(disposed, 2);
    await context.service.dispose();
    const orphanId = randomUUID(); await mkdir(path.join(context.directory, sourceDirectoryName(orphanId))); await writeFile(path.join(context.directory, sourceDirectoryName(orphanId), 'chunk-0.bin'), 'orphan');
    await mkdir(path.join(context.directory, 'keep-unrelated')); await writeFile(path.join(context.directory, 'keep-unrelated', 'notes.txt'), 'keep');
    reopened = await KnowledgeService.open(context.directory, { embed: async config => unit(config.dimensions) });
    assert.ok(!(await readdir(context.directory)).includes(sourceDirectoryName(orphanId)));
    assert.equal(await readFile(path.join(context.directory, 'keep-unrelated', 'notes.txt'), 'utf8'), 'keep');
    assert.equal(reopened.status().sources.length, 1);
  } finally { await reopened?.dispose(); await context.dispose(); }
});

test('an indexed job stays running and locked until temporary cleanup has drained', async () => {
  const cleanup = deferred<void>(); const beganCleanup = deferred<void>();
  const context = await fixture({ prepare: async () => prepared('cleanup.txt', ['fixture'], async () => { beganCleanup.resolve(); await cleanup.promise; }) });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('anything')); const job = await context.service.index(preview.id, false);
    await beganCleanup.promise;
    assert.equal(context.service.status().job?.status, 'running');
    assert.equal(context.service.status().job?.finishedAt, undefined);
    assert.equal(context.service.status().sources.length, 1, 'A source may already be durable while its temporary work is still being cleaned up.');
    await assert.rejects(context.service.configure(local), /current knowledge operation/);
    let drained = false; const cancellation = context.service.cancel(job.id).then(state => { drained = true; return state; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(drained, false);
    cleanup.resolve(); assert.equal((await cancellation).job?.status, 'completed');
    assert.equal((await context.service.configure(local)).sources.length, 1);
  } finally { cleanup.resolve(); await context.dispose(); }
});

test('a failed job stays running and locked until cleanup finishes and terminal state is safe to observe', async () => {
  const cleanup = deferred<void>(); const beganCleanup = deferred<void>();
  const context = await fixture({ prepare: async () => prepared('failed-cleanup.txt', ['fixture'], async () => { beganCleanup.resolve(); await cleanup.promise; }), embed: async () => { throw new Error('Provider failed with private details.'); } });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('anything')); await context.service.index(preview.id, false);
    await beganCleanup.promise;
    const pending = context.service.status();
    assert.equal(pending.job?.status, 'running'); assert.equal(pending.job?.finishedAt, undefined); assert.equal(pending.job?.error, undefined); assert.equal(pending.sources.length, 0);
    await assert.rejects(context.service.configure(local), /current knowledge operation/);
    cleanup.resolve(); const terminal = await finished(context.service);
    assert.equal(terminal.job?.status, 'failed'); assert.equal(typeof terminal.job?.finishedAt, 'string'); assert.equal(terminal.sources.length, 0);
    assert.ok(!JSON.stringify(terminal).includes('private details'));
    assert.equal((await context.service.configure(local)).sources.length, 0);
  } finally { cleanup.resolve(); await context.dispose(); }
});

test('failed cleanup after a cancelled preview releases the preparation lock for later operations', async () => {
  let cleanupCalls = 0;
  const controller = new AbortController();
  const context = await fixture({ prepare: async () => {
    controller.abort();
    return prepared('cancelled-preview.txt', ['fixture'], async () => { cleanupCalls++; throw new Error('Temporary fixture cleanup failed.'); });
  } });
  try {
    await context.service.configure(local);
    await assert.rejects(context.service.preview({ ...input('anything'), signal: controller.signal }));
    assert.equal(cleanupCalls, 1);
    assert.equal((await context.service.configure({ ...local, timeoutSeconds: 90 })).config.timeoutSeconds, 90);
  } finally { await context.dispose(); }
});

test('disposing the service aborts and drains active preparation before returning', async () => {
  const began = deferred<void>(); const release = deferred<PreparedSource>(); let preparationSignal: AbortSignal | undefined; let cleaned = 0;
  const context = await fixture({ prepare: async source => { preparationSignal = source.signal; began.resolve(); return release.promise; } });
  try {
    await context.service.configure(local);
    const preview = context.service.preview(input('pending preparation')).then(() => ({ succeeded: true }), error => ({ succeeded: false, error }));
    await began.promise;
    let disposed = false; const shutdown = context.service.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(preparationSignal?.aborted, true); assert.equal(disposed, false);
    release.resolve(prepared('pending.txt', ['fixture'], async () => { cleaned++; }));
    assert.equal((await preview).succeeded, false); await shutdown; assert.equal(cleaned, 1);
    await assert.rejects(context.service.configure(local), /shutting down/);
  } finally { release.resolve(prepared('pending.txt', ['fixture'])); await context.dispose(); }
});

test('disposing the service aborts and drains a search before closing the index', async () => {
  const began = deferred<void>(); const release = deferred<number[]>(); let searchSignal: AbortSignal | undefined;
  const context = await fixture({ embed: async (_config, _source, options) => {
    if (options.purpose === 'query') { searchSignal = options.signal; began.resolve(); return release.promise; }
    return [1, 0, 0];
  } });
  try {
    await context.service.configure(local); const preview = await context.service.preview(input('Searchable paragraph.')); await context.service.index(preview.id, false); await finished(context.service);
    const search = context.service.search({ query: 'paragraph' }, new AbortController().signal).then(() => ({ succeeded: true }), error => ({ succeeded: false, error }));
    await began.promise;
    let disposed = false; const shutdown = context.service.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(searchSignal?.aborted, true); assert.equal(disposed, false);
    release.resolve([1, 0, 0]); assert.equal((await search).succeeded, false); await shutdown;
    assert.equal(context.service.status().sources.length, 1);
  } finally { release.resolve([1, 0, 0]); await context.dispose(); }
});

test('shutdown during preview expiry cannot admit a later preparation or embedding request', async () => {
  for (const action of ['preview', 'index'] as const) {
    const began = deferred<void>(); const release = deferred<void>(); let embeds = 0; let preparations = 0;
    const context = await fixture({ prepare: async source => { preparations++; return prepared(source.name, ['fixture']); }, embed: async config => { embeds++; return unit(config.dimensions); } });
    try {
      await context.service.configure(local); const preview = await context.service.preview(input('existing'));
      const internal = context.service as unknown as { expire: () => Promise<void> }; const expire = internal.expire.bind(context.service);
      internal.expire = async () => { began.resolve(); await release.promise; await expire(); };
      const operation = (action === 'preview' ? context.service.preview(input('later')) : context.service.index(preview.id, false))
        .then(() => ({ admitted: true }), error => ({ admitted: false, error }));
      await began.promise; const shutdown = context.service.dispose(); release.resolve();
      const result = await operation; assert.equal(result.admitted, false); await shutdown;
      assert.equal(preparations, 1); assert.equal(embeds, 0); assert.equal(context.service.status().sources.length, 0);
    } finally { release.resolve(); await context.dispose(); }
  }
});

test('the HTTP preview route rejects a second upload before buffering while an earlier preparation is active', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-knowledge-upload-admission-'));
  const began = deferred<void>(); const release = deferred<void>(); let preparations = 0;
  const runtime = await createApp({ statePath: path.join(directory, 'state.json'), knowledgeOptions: { prepare: async source => {
    if (++preparations === 1) { began.resolve(); await release.promise; }
    return prepared(source.name, ['fixture']);
  }, embed: async config => unit(config.dimensions) } });
  const server = runtime.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const upload = (name: string) => fetch(`${base}/knowledge/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Type': 'text/plain' }, body: 'A source paragraph.' });
  try {
    const first = upload('first.txt'); await began.promise;
    const rejected = await upload('blocked.txt'); assert.equal(rejected.status, 409); assert.equal(preparations, 1);
    release.resolve(); const firstResponse = await first; assert.equal(firstResponse.status, 200); await firstResponse.json();
    const admitted = await upload('second.txt'); assert.equal(admitted.status, 200); assert.equal(preparations, 2); await admitted.json();
  } finally {
    release.resolve(); await runtime.shutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});

test('a failed index save removes already written media artifacts and retains no partial source', async () => {
  const document = await PDFDocument.create(); document.addPage([200, 200]);
  const context = await fixture(); const update = context.service.store.update.bind(context.service.store);
  try {
    await context.service.configure(cloud);
    const preview = await context.service.preview({ name: 'save-failure.pdf', mimeType: 'application/pdf', data: Buffer.from(await document.save()), signal: new AbortController().signal });
    context.service.store.update = async () => { throw new Error('Simulated disk failure with private details.'); };
    await context.service.index(preview.id, true); const state = await finished(context.service);
    assert.equal(state.job?.status, 'failed'); assert.equal(state.job?.completedChunks, 1); assert.equal(state.sources.length, 0);
    assert.equal((await readdir(context.directory)).some(name => name.startsWith('source-')), false);
    assert.ok(!JSON.stringify(state).includes('private details'));
    assert.equal(JSON.parse(await readFile(path.join(context.directory, 'index.json'), 'utf8')).sources.length, 0);
  } finally { context.service.store.update = update; await context.dispose(); }
});

test('the HTTP knowledge flow previews locally, embeds explicitly, searches, downloads, exports and deletes persisted chunks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-knowledge-api-')); let calls = 0;
  const runtime = await createApp({ statePath: path.join(directory, 'state.json'), knowledgeOptions: { embed: async config => { calls++; return unit(config.dimensions); } } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (route: string, method = 'GET', body?: unknown) => fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await request('/knowledge/config', 'PUT', local)).status, 200);
    const textResponse = await request('/knowledge/preview', 'POST', { name: 'reference.txt', text: 'A reusable source paragraph.' }); assert.equal(textResponse.status, 200);
    const textPreview = await textResponse.json(); assert.equal(calls, 0); assert.equal(textPreview.chunks.length, 1);
    const started = await request('/knowledge/index', 'POST', { previewId: textPreview.id, allowCloudUpload: false }); assert.equal(started.status, 202);
    const state = await finished(runtime.knowledge); const sourceId = state.sources[0].id; assert.equal(state.job?.status, 'completed');
    assert.equal((await request('/knowledge/index', 'POST', { previewId: textPreview.id })).status, 404);
    const search = await request('/knowledge/search', 'POST', { query: 'paragraph', limit: 2 }); assert.equal(search.status, 200);
    const results = (await search.json()).results; assert.equal(results[0].sourceName, 'reference.txt'); assert.equal(results[0].score, 1); assert.ok(!JSON.stringify(results).includes('vector'));
    const content = await request(`/knowledge/sources/${sourceId}/chunks/${textPreview.chunks[0].id}/content`);
    assert.equal(content.status, 200); assert.equal(content.headers.get('x-content-type-options'), 'nosniff'); assert.match(content.headers.get('content-disposition') ?? '', /\.txt/);
    assert.equal(await content.text(), 'A reusable source paragraph.');
    const exported = await request(`/knowledge/sources/${sourceId}/export`); assert.equal(exported.status, 200); assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
    const download = await exported.json(); assert.deepEqual(download.source.chunks[0].vector, [1, 0, 0]); assert.ok(download.source.chunks[0].contentUrl.includes('/content'));
    const ordinaryState = await (await request('/state')).text(); assert.ok(!ordinaryState.includes('"vector"')); assert.ok(!ordinaryState.includes('A reusable source paragraph.'));
    assert.equal((await fetch(`${base}/knowledge/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify(local) })).status, 403);
    assert.equal((await fetch(`${base}/knowledge/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': '%bad', 'X-File-Type': 'text/plain' }, body: 'text' })).status, 400);

    await request('/knowledge/config', 'PUT', cloud);
    const document = await PDFDocument.create(); document.addPage([200, 200]);
    const rawPreviewResponse = await fetch(`${base}/knowledge/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('guide.pdf'), 'X-File-Type': 'application/pdf' }, body: new Uint8Array(await document.save()) });
    assert.equal(rawPreviewResponse.status, 200); const rawPreview = await rawPreviewResponse.json(); const beforeCalls = calls;
    assert.equal((await request('/knowledge/index', 'POST', { previewId: rawPreview.id, allowCloudUpload: false })).status, 400); assert.equal(calls, beforeCalls);
    assert.equal((await request('/knowledge/index', 'POST', { previewId: rawPreview.id, allowCloudUpload: true })).status, 202); const pdfState = await finished(runtime.knowledge);
    const pdfId = pdfState.sources.find(source => source.name === 'guide.pdf')!.id;
    assert.equal((await request('/knowledge/search', 'POST', { query: 'guide', allowCloudUpload: false })).status, 400);
    assert.equal((await request('/knowledge/search', 'POST', { query: 'guide', allowCloudUpload: true })).status, 200);
    const pdfContent = await request(`/knowledge/sources/${pdfId}/chunks/${rawPreview.chunks[0].id}/content`); assert.equal(pdfContent.status, 200); assert.match(pdfContent.headers.get('content-disposition') ?? '', /\.pdf/);
    assert.equal((await PDFDocument.load(await pdfContent.arrayBuffer())).getPageCount(), 1);
    assert.equal((await request(`/knowledge/sources/${sourceId}`, 'DELETE')).status, 200); assert.equal((await request(`/knowledge/sources/${pdfId}`, 'DELETE')).status, 200);
    assert.equal((await request(`/knowledge/sources/${sourceId}/export`)).status, 404);
    for (const filename of ['index.json', 'index.json.bak']) assert.equal(JSON.parse(await readFile(path.join(directory, 'knowledge', filename), 'utf8')).sources.length, 0);
    assert.equal((await readdir(path.join(directory, 'knowledge'))).some(name => name.startsWith('source-')), false);
  } finally {
    await runtime.shutdown();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});
