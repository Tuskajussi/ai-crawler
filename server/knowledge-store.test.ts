import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EmbeddingConfig } from '../shared/knowledge';
import { defaultEmbeddingConfig } from '../shared/knowledge';
import { embeddingSpaceKey } from './embedding-provider';
import { KnowledgeStore, knowledgeLimits, knowledgeStorageBytes, sourceDirectoryName, type StoredKnowledgeSource } from './knowledge-store';

const config: EmbeddingConfig = { ...defaultEmbeddingConfig, provider: 'compatible', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', modelId: 'test-embedding', dimensions: 3 };
function source(): StoredKnowledgeSource {
  return { id: randomUUID(), name: 'reference.txt', modality: 'text', bytes: 5, storedBytes: 5, chunkCount: 1, dimensions: 3,
    modelId: config.modelId, spaceKey: embeddingSpaceKey(config), hash: 'a'.repeat(64), createdAt: new Date().toISOString(),
    chunks: [{ id: randomUUID(), index: 0, modality: 'text', mimeType: 'text/plain', text: 'hello', preview: 'hello', locator: { startChar: 0, endChar: 5, startLine: 1, endLine: 1 }, vector: [0.6, 0.8, 0] }] };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-knowledge-store-'));
  const store = await KnowledgeStore.open(directory);
  return { directory, store, file: path.join(directory, 'index.json'), async dispose() {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('a new knowledge store has isolated defaults and commits real vectors atomically across reopen', async () => {
  const context = await fixture();
  try {
    assert.deepEqual(context.store.snapshot(), { version: 1, config: defaultEmbeddingConfig, sources: [] });
    const record = source();
    await context.store.update(state => { state.config = config; state.sources.push(record); }); await context.store.flush();
    const reopened = await KnowledgeStore.open(context.directory);
    assert.deepEqual(reopened.snapshot().sources, [record]);
    const snapshot = reopened.snapshot(); snapshot.sources[0].chunks[0].vector[0] = 500;
    assert.deepEqual(reopened.snapshot().sources[0].chunks[0].vector, [0.6, 0.8, 0]);
    assert.deepEqual(JSON.parse(await readFile(context.file, 'utf8')).sources, [record]);
    await assert.rejects(readFile(`${context.file}.tmp`), /ENOENT/);
  } finally { await context.dispose(); }
});

test('failed schema updates preserve both in-memory and saved data and do not poison later valid updates', async () => {
  const context = await fixture();
  try {
    await context.store.update(state => { state.config = config; state.sources = [source()]; });
    const before = context.store.snapshot(); const saved = await readFile(context.file, 'utf8'); const backup = await readFile(`${context.file}.bak`, 'utf8');
    for (const mutate of [
      (state: ReturnType<KnowledgeStore['snapshot']>) => { state.sources[0].chunks[0].vector = [0, 0, 0]; },
      (state: ReturnType<KnowledgeStore['snapshot']>) => { state.sources[0].chunkCount = 2; },
      (state: ReturnType<KnowledgeStore['snapshot']>) => { state.sources[0].id = '../outside'; },
      (state: ReturnType<KnowledgeStore['snapshot']>) => { state.config.apiKeyEnv = 'raw-key-value'; },
    ]) {
      await assert.rejects(context.store.update(mutate));
      assert.deepEqual(context.store.snapshot(), before); assert.equal(await readFile(context.file, 'utf8'), saved); assert.equal(await readFile(`${context.file}.bak`, 'utf8'), backup);
    }
    await context.store.update(state => { state.config.timeoutSeconds = 90; }); await context.store.flush();
    assert.equal(context.store.snapshot().config.timeoutSeconds, 90);
  } finally { await context.dispose(); }
});

test('concurrent store updates serialize against the latest durable snapshot', async () => {
  const context = await fixture();
  try {
    await context.store.update(state => { state.config = config; });
    const one = source(); const two = source(); two.hash = 'b'.repeat(64);
    await Promise.all([context.store.update(state => { state.sources.push(one); }), context.store.update(state => { state.sources.push(two); })]);
    assert.deepEqual((await KnowledgeStore.open(context.directory)).snapshot().sources.map(item => item.id), [one.id, two.id]);
  } finally { await context.dispose(); }
});

test('corrupt primary indices recover from a validated backup and preserve it on the next save', async () => {
  const context = await fixture();
  try {
    await context.store.update(state => { state.config = config; state.sources = [source()]; });
    const recoveredData = context.store.snapshot();
    await context.store.update(state => { state.config.timeoutSeconds = 90; });
    await writeFile(context.file, '{not-valid-json');
    const reopened = await KnowledgeStore.open(context.directory);
    assert.deepEqual(reopened.snapshot(), recoveredData);
    await reopened.update(state => { state.config.timeoutSeconds = 100; });
    assert.deepEqual(JSON.parse(await readFile(`${context.file}.bak`, 'utf8')), recoveredData);
    assert.equal((await KnowledgeStore.open(context.directory)).snapshot().config.timeoutSeconds, 100);
  } finally { await context.dispose(); }
});

test('invalid primary and backup indices fail closed without resetting or overwriting evidence', async () => {
  const context = await fixture();
  try {
    for (const invalid of ['{broken', JSON.stringify({ version: 999, config, sources: [] }), JSON.stringify({ version: 1, config, sources: [{ ...source(), chunks: [] }] })]) {
      await writeFile(context.file, invalid); await writeFile(`${context.file}.bak`, invalid);
      await assert.rejects(KnowledgeStore.open(context.directory), /backup could not be validated/);
      assert.equal(await readFile(context.file, 'utf8'), invalid); assert.equal(await readFile(`${context.file}.bak`, 'utf8'), invalid);
    }
    await rm(context.file);
    await assert.rejects(KnowledgeStore.open(context.directory), /backup could not be validated/);
  } finally { await context.dispose(); }
});

test('stored vectors must preserve the normalization and dimensions assumed by cosine search', async () => {
  const context = await fixture();
  try {
    for (const vector of [[0, 0, 0], [1, 0], [1, 2, 0], [NaN, 1, 0], [Infinity, 1, 0]]) {
      await assert.rejects(context.store.update(state => { state.config = config; const item = source(); item.chunks[0].vector = vector; state.sources = [item]; }));
    }
    await context.store.update(state => { state.config = config; const item = source(); item.modelId = 'x'.repeat(300); state.sources = [item]; });
    assert.equal(context.store.snapshot().sources[0].modelId.length, 300);
  } finally { await context.dispose(); }
});

test('stored chunk identity, media references and locations cannot select arbitrary files', async () => {
  const context = await fixture();
  try {
    const mutations: ((item: StoredKnowledgeSource) => void)[] = [
      item => { item.chunks[0].mediaFile = '../secret.txt'; },
      item => { item.chunks[0].mediaFile = 'C:\\private.txt'; },
      item => { item.chunks[0].modality = 'pdf'; item.chunks[0].mimeType = 'application/pdf'; delete item.chunks[0].text; },
      item => { item.chunks[0].locator = { startSeconds: -1 }; },
      item => { item.chunks[0].locator = { track: 'subtitle' as 'audio' }; },
      item => { item.chunkCount = 2; item.chunks.push({ ...structuredClone(item.chunks[0]), id: randomUUID(), index: 0 }); },
      item => { item.chunkCount = 2; item.chunks.push({ ...structuredClone(item.chunks[0]), index: 1 }); },
    ];
    for (const mutate of mutations) {
      await assert.rejects(context.store.update(state => { state.config = config; const item = source(); mutate(item); state.sources = [item]; }));
    }
    await context.store.update(state => { state.config = config; const item = source(); item.modality = 'pdf'; item.chunks[0].modality = 'pdf'; item.chunks[0].mimeType = 'application/pdf'; item.chunks[0].mediaFile = 'chunk-0.bin'; item.chunks[0].locator = { pageStart: 1, pageEnd: 1 }; delete item.chunks[0].text; state.sources = [item]; });
    assert.equal(context.store.snapshot().sources[0].chunks[0].mediaFile, 'chunk-0.bin');
    for (const id of ['../outside', 'bad', '/absolute', 'c'.repeat(37)]) assert.throws(() => sourceDirectoryName(id));
  } finally { await context.dispose(); }
});

test('source and aggregate storage allowances reject excessive saved content before disk publication', async () => {
  const context = await fixture();
  try {
    for (const mutate of [
      (item: StoredKnowledgeSource) => { item.bytes = knowledgeLimits.uploadBytes + 1; },
      (item: StoredKnowledgeSource) => { item.storedBytes = knowledgeStorageBytes + 1; },
      (item: StoredKnowledgeSource) => { item.chunkCount = knowledgeLimits.chunksPerSource + 1; item.chunks = Array.from({ length: item.chunkCount }, (_value, index) => ({ ...structuredClone(item.chunks[0]), id: randomUUID(), index })); },
    ]) await assert.rejects(context.store.update(state => { state.config = config; const item = source(); mutate(item); state.sources = [item]; }));
    await assert.rejects(context.store.update(state => { state.config = config; state.sources = Array.from({ length: knowledgeLimits.sources + 1 }, source); }));
    assert.equal(context.store.snapshot().sources.length, 0); await assert.rejects(readFile(context.file), /ENOENT/);
  } finally { await context.dispose(); }
});

test('stored schema rejects unknown fields so arbitrary blobs cannot escape in status or exports', async () => {
  const context = await fixture();
  try {
    for (const mutate of [
      (state: ReturnType<KnowledgeStore['snapshot']>) => { (state as unknown as Record<string, unknown>).unexpected = 'private-blob'; },
      (state: ReturnType<KnowledgeStore['snapshot']>) => { (state.sources[0] as unknown as Record<string, unknown>).unexpected = 'private-blob'; },
      (state: ReturnType<KnowledgeStore['snapshot']>) => { (state.sources[0].chunks[0] as unknown as Record<string, unknown>).unexpected = 'private-blob'; },
      (state: ReturnType<KnowledgeStore['snapshot']>) => { (state.sources[0].chunks[0].locator as unknown as Record<string, unknown>).unexpected = 'private-blob'; },
    ]) await assert.rejects(context.store.update(state => { state.config = config; state.sources = [source()]; mutate(state); }));
    assert.equal(context.store.snapshot().sources.length, 0);
  } finally { await context.dispose(); }
});

test('stored locators preserve ordered integer positions and positive page and line references', async () => {
  const context = await fixture();
  try {
    for (const locator of [[], { startChar: 10, endChar: 5 }, { startChar: 1.5, endChar: 5 }, { startLine: 0, endLine: 1 },
      { startLine: 10, endLine: 5 }, { pageStart: 0, pageEnd: 1 }, { pageStart: 2, pageEnd: 1 }, { pageStart: 1.5, pageEnd: 2 },
      { startSeconds: 5, endSeconds: 2 }, { startSeconds: NaN, endSeconds: 2 },
    ]) await assert.rejects(context.store.update(state => { state.config = config; const item = source(); item.chunks[0].locator = locator as StoredKnowledgeSource['chunks'][number]['locator']; state.sources = [item]; }));
  } finally { await context.dispose(); }
});

test('stored chunk modality must match its MIME instead of mislabeling downloadable content', async () => {
  const context = await fixture();
  try {
    for (const [modality, mimeType] of [['text', 'image/png'], ['pdf', 'text/plain'], ['image', 'application/pdf'], ['audio', 'video/mp4'], ['video', 'audio/wav']] as const) {
      await assert.rejects(context.store.update(state => {
        state.config = config; const item = source(); item.modality = modality; item.chunks[0].modality = modality; item.chunks[0].mimeType = mimeType;
        if (modality !== 'text') { item.chunks[0].mediaFile = 'chunk-0.bin'; delete item.chunks[0].text; }
        item.chunks[0].locator = modality === 'pdf' ? { pageStart: 1, pageEnd: 1 } : modality === 'audio' || modality === 'video' ? { startSeconds: 0, endSeconds: 1, track: modality } : modality === 'image' ? {} : { startLine: 1, endLine: 1 };
        state.sources = [item];
      }));
    }
  } finally { await context.dispose(); }
});
