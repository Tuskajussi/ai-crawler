import test from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddingConfig } from '../shared/knowledge';
import { defaultEmbeddingConfig } from '../shared/knowledge';
import { createEmbeddingExecutor, embeddingReadiness, embeddingSpaceKey, validateEmbeddingConfig } from './embedding-provider';

const native: EmbeddingConfig = { ...defaultEmbeddingConfig, dimensions: 128 };
const local: EmbeddingConfig = { ...native, provider: 'compatible', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', modelId: 'embeddinggemma', dimensions: 3 };
const vertex: EmbeddingConfig = { ...native, provider: 'vertex', apiKeyEnv: '', projectId: 'example-project', location: 'eu' };
const environment = { GEMINI_API_KEY: 'test-credential-must-not-leak' };
const requestOptions = () => ({ purpose: 'document' as const, signal: new AbortController().signal, allowCloudUpload: true });
const vector = () => Array.from({ length: 128 }, (_value, index) => index === 0 ? 3 : index === 1 ? 4 : 0);
const nativeResponse = () => Response.json({ embedding: { values: vector() } });
const compatibleResponse = (embedding: unknown = [3, 4, 0]) => Response.json({ model: local.modelId, data: [{ index: 0, embedding }] });

test('embedding configuration isolates native credentials and bounds vector and request sizes', () => {
  for (const config of [native, local, vertex, { ...vertex, location: 'global' }, { ...local, kind: 'cloud', baseUrl: 'https://example.test/v1' }]) {
    assert.doesNotThrow(() => validateEmbeddingConfig(config));
  }
  for (const config of [
    null, [], { ...native, apiKey: 'never-save-secrets' }, { ...native, apiKeyEnv: 'raw-key-value' }, { ...native, apiKeyEnv: '' },
    { ...native, dimensions: 127 }, { ...native, dimensions: 3073 }, { ...native, kind: 'local' }, { ...native, modelId: 'gemini-embedding-001' },
    { ...native, baseUrl: 'https://example.test' }, { ...native, projectId: 'unneeded-project' },
    { ...vertex, apiKeyEnv: 'GOOGLE_ACCESS_TOKEN' }, { ...vertex, projectId: '' }, { ...vertex, projectId: '../project' }, { ...vertex, projectId: 'x'.repeat(31) }, { ...vertex, location: 'us-east1' },
    { ...local, baseUrl: '' }, { ...local, dimensions: 0 }, { ...local, dimensions: 8193 }, { ...local, dimensions: 3.5 },
    { ...local, timeoutSeconds: 4 }, { ...local, timeoutSeconds: 301 }, { ...local, timeoutSeconds: null },
    { ...local, baseUrl: 'file:///model' }, { ...local, baseUrl: 'http://user:secret@127.0.0.1:11434/v1' },
    { ...local, baseUrl: 'http://127.0.0.1:11434/v1?key=secret' }, { ...local, baseUrl: 'http://127.0.0.1:11434/v1#secret' },
    { ...local, kind: 'cloud', baseUrl: 'http://public.example/v1' },
  ]) assert.throws(() => validateEmbeddingConfig(config));
});

test('local endpoints cannot disguise public destinations and skip cloud consent', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '192.168.1.22', '10.0.0.8', '172.16.0.4', '172.31.255.1', '[::1]', '[fd12::2]', '[fe80::2]', '[::ffff:192.168.1.1]']) {
    assert.doesNotThrow(() => validateEmbeddingConfig({ ...local, baseUrl: `http://${host}:11434/v1` }));
  }
  for (const host of ['example.com', 'private-machine', 'localhost.example.com', 'localhost.', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '169.254.169.254', '[2001:4860:4860::8888]', '[::ffff:8.8.8.8]']) {
    assert.throws(() => validateEmbeddingConfig({ ...local, baseUrl: `http://${host}:11434/v1` }), /private LAN IP/);
  }
});

test('readiness only examines configuration and environment references without resolving ADC', () => {
  assert.equal(embeddingReadiness(local, {}).ready, true);
  assert.equal(embeddingReadiness(native, {}).ready, false);
  assert.equal(embeddingReadiness(native, { GEMINI_API_KEY: ' ' }).ready, false);
  assert.equal(embeddingReadiness(native, environment).ready, true);
  assert.equal(embeddingReadiness(vertex, {}).ready, true);
  assert.match(embeddingReadiness(vertex, {}).message, /only when you request/);
  assert.equal(embeddingReadiness({ ...native, dimensions: 0 }, {}).ready, false);
  assert.ok(!JSON.stringify(embeddingReadiness(native, environment)).includes(environment.GEMINI_API_KEY));
});

test('vector space identity follows endpoint, model, dimensions and prompt contract while credential rotation preserves it', () => {
  const key = embeddingSpaceKey(local);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(embeddingSpaceKey({ ...local, baseUrl: 'http://127.0.0.1:11434/v1/' }), key);
  assert.equal(embeddingSpaceKey({ ...local, apiKeyEnv: 'ROTATED_CREDENTIAL', timeoutSeconds: 90 }), key);
  for (const config of [{ ...local, dimensions: 4 }, { ...local, modelId: 'other-embedding-model' }, { ...local, baseUrl: 'http://192.168.1.22:11434/v1' }, native, vertex]) {
    assert.notEqual(embeddingSpaceKey(config), key);
  }
  assert.notEqual(embeddingSpaceKey({ ...vertex, location: 'global' }), embeddingSpaceKey(vertex));
  assert.notEqual(embeddingSpaceKey({ ...vertex, projectId: 'another-project' }), embeddingSpaceKey(vertex));
});

test('Gemini uses native retrieval formatting and server-only key headers for documents and queries', async () => {
  const calls: Request[] = [];
  const execute = createEmbeddingExecutor({ environment, fetch: async input => { calls.push(input as Request); return nativeResponse(); } });
  const result = await execute(native, { title: 'Example', text: 'A useful paragraph.' }, requestOptions());
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent');
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.get('x-goog-api-key'), environment.GEMINI_API_KEY);
  assert.deepEqual(await calls[0].json(), { content: { parts: [{ text: 'title: Example | text: A useful paragraph.' }] }, embedContentConfig: { outputDimensionality: 128, autoTruncate: false } });
  assert.equal(result.length, 128); assert.equal(result[0], 0.6); assert.equal(result[1], 0.8);
  await execute(native, { text: 'Where is the paragraph?' }, { ...requestOptions(), purpose: 'query' });
  assert.deepEqual(await calls[1].json(), { content: { parts: [{ text: 'task: search result | query: Where is the paragraph?' }] }, embedContentConfig: { outputDimensionality: 128, autoTruncate: false } });
});

test('native media bytes are embedded in the same document request without a Files API upload', async () => {
  const calls: Request[] = [];
  const execute = createEmbeddingExecutor({ environment, fetch: async input => { calls.push(input as Request); return nativeResponse(); } });
  const data = Buffer.from('tiny fixture, actual media validation happens while chunking');
  for (const mimeType of ['image/png', 'image/jpeg', 'application/pdf', 'audio/mpeg', 'audio/wav', 'video/mp4']) {
    await execute(native, { title: 'Media', media: { mimeType, data } }, requestOptions());
    assert.deepEqual((await calls.at(-1)!.json()).content.parts, [{ text: 'title: Media | text: ' }, { inlineData: { mimeType, data: data.toString('base64') } }]);
  }
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.url.endsWith(':embedContent')));
});

test('Vertex authenticates only on explicit approved requests and uses the documented regional v1 endpoint', async () => {
  let authCalls = 0; const calls: Request[] = [];
  const execute = createEmbeddingExecutor({ environment: {}, vertexHeaders: async (url, signal) => {
    assert.ok(url.includes('/projects/example-project/')); assert.equal(signal.aborted, false); authCalls++;
    return { Authorization: 'Bearer test-adc-token', 'x-goog-user-project': 'quota-project' };
  }, fetch: async input => { calls.push(input as Request); return nativeResponse(); } });
  assert.equal(authCalls, 0);
  await assert.rejects(execute(vertex, { text: 'Private content' }, { ...requestOptions(), allowCloudUpload: false }), /Confirm sending/);
  assert.equal(authCalls, 0); assert.equal(calls.length, 0);
  for (const location of ['eu', 'us', 'global'] as const) {
    await execute({ ...vertex, location }, { text: 'Approved content' }, requestOptions());
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `aiplatform.${location}.rep.googleapis.com`;
    assert.equal(calls.at(-1)!.url, `https://${host}/v1/projects/example-project/locations/${location}/publishers/google/models/gemini-embedding-2:embedContent`);
    assert.equal(calls.at(-1)!.headers.get('authorization'), 'Bearer test-adc-token');
    assert.equal(calls.at(-1)!.headers.get('x-goog-user-project'), 'quota-project');
    assert.equal(calls.at(-1)!.headers.get('x-goog-api-key'), null);
    const payload = await calls.at(-1)!.json(); assert.equal(payload.embedContentConfig.autoTruncate, false); assert.equal(payload.embedContentConfig.documentOcr, undefined);
  }
});

test('every cloud document and search operation needs consent before a provider or auth call', async () => {
  let calls = 0;
  const execute = createEmbeddingExecutor({ environment, fetch: async () => { calls++; return nativeResponse(); } });
  for (const purpose of ['document', 'query'] as const) {
    for (const config of [native, { ...local, kind: 'cloud' as const, baseUrl: 'https://cloud.example/v1' }]) {
      await assert.rejects(execute(config, { text: 'Private content' }, { ...requestOptions(), purpose, allowCloudUpload: false }), /Confirm sending/);
    }
  }
  assert.equal(calls, 0);
});

test('local compatible requests accept text only and preserve the model input format', async () => {
  const calls: Request[] = [];
  const execute = createEmbeddingExecutor({ environment: { LOCAL_KEY: 'local-test-key' }, fetch: async input => { calls.push(input as Request); return compatibleResponse(); } });
  assert.deepEqual(await execute(local, { text: 'Plain local text', title: 'Metadata is not injected' }, { ...requestOptions(), allowCloudUpload: false }), [0.6, 0.8, 0]);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.deepEqual(await calls[0].json(), { model: 'embeddinggemma', input: 'Plain local text', encoding_format: 'float', dimensions: 3 });
  await execute({ ...local, apiKeyEnv: 'LOCAL_KEY' }, { text: 'Query' }, { ...requestOptions(), purpose: 'query' });
  assert.equal(calls[1].headers.get('authorization'), 'Bearer local-test-key');
  await assert.rejects(execute(local, { media: { mimeType: 'image/png', data: Buffer.from('image') } }, requestOptions()), /text chunks only/);
  assert.equal(calls.length, 2);
});

test('invalid inputs and oversized text or inline media fail before any provider request', async () => {
  let calls = 0;
  const execute = createEmbeddingExecutor({ environment, fetch: async () => { calls++; return nativeResponse(); } });
  for (const input of [{}, { text: ' ' }, { text: 'x'.repeat(7500) }, { text: '😀'.repeat(2000) }, { title: 'x'.repeat(301), text: 'text' },
    { media: { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>') } }, { media: { mimeType: 'image/png', data: Buffer.alloc(0) } },
    { media: { mimeType: 'image/png', data: Buffer.alloc(12 * 1024 * 1024 + 1) } },
  ]) await assert.rejects(execute(native, input, requestOptions()));
  await assert.rejects(execute(native, { media: { mimeType: 'image/png', data: Buffer.from('image') } }, { ...requestOptions(), purpose: 'query' }), /Search requires/);
  assert.equal(calls, 0);
});

test('invalid, truncated, wrong-model and ambiguous embedding responses cannot enter an index', async () => {
  for (const payload of [
    { data: [{ index: 0, embedding: [0, 0, 0] }] }, { data: [{ index: 0, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: [1, null, 0] }] }, { data: [{ index: 0, embedding: [1, '2', 0] }] },
    { data: [{ index: 1, embedding: [1, 0, 0] }] }, { data: [{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [1, 0, 0] }] },
    { model: 'another-model', data: [{ index: 0, embedding: [1, 0, 0] }] }, { data: [{ index: 0, embedding: [1, 0, 0] }], truncated: true },
    { error: { message: 'Echoed credentials and document content' } }, null, {},
  ]) {
    const execute = createEmbeddingExecutor({ fetch: async () => Response.json(payload) });
    await assert.rejects(execute(local, { text: 'Document' }, requestOptions()));
  }
  const execute = createEmbeddingExecutor({ fetch: async () => compatibleResponse([1e308, 1e308, 0]) });
  const huge = await execute(local, { text: 'Document' }, requestOptions());
  assert.ok(huge.every(Number.isFinite)); assert.ok(Math.abs(Math.hypot(...huge) - 1) < 1e-10);
});

test('bounded responses, error bodies and redirects never reveal credentials or uploaded text', async () => {
  const secret = environment.GEMINI_API_KEY;
  const content = 'PRIVATE_DOCUMENT_MUST_NOT_LEAK';
  const responses = [
    () => new Response(secret + content, { status: 429 }),
    () => new Response(secret + content, { status: 307, headers: { location: 'https://public.example' } }),
    () => new Response(secret + content),
    () => new Response('small', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
  ];
  for (const response of responses) {
    const execute = createEmbeddingExecutor({ environment, fetch: async () => response() });
    await assert.rejects(execute(native, { text: content }, requestOptions()), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes(content)); return true;
    });
  }
  const execute = createEmbeddingExecutor({ environment, fetch: async () => { throw new Error(secret + content); } });
  await assert.rejects(execute(native, { text: content }, requestOptions()), /Check the endpoint/);
});

test('cancellation stops pending fetch and response reads without publishing vectors', async () => {
  const controller = new AbortController();
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let receivedSignal: AbortSignal | undefined;
  const execute = createEmbeddingExecutor({ fetch: async input => { receivedSignal = (input as Request).signal; started(); return new Promise<Response>(() => {}); } });
  const operation = execute(local, { text: 'Document' }, { ...requestOptions(), signal: controller.signal });
  await began; controller.abort();
  await assert.rejects(operation, /stopped or exceeded/); assert.equal(receivedSignal?.aborted, true);

  const secondController = new AbortController(); let cancelled = false; let readStarted!: () => void;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const stream = new ReadableStream<Uint8Array>({ pull() { readStarted(); }, cancel() { cancelled = true; } });
  const readingExecute = createEmbeddingExecutor({ fetch: async () => new Response(stream) });
  const readOperation = readingExecute(local, { text: 'Document' }, { ...requestOptions(), signal: secondController.signal });
  await reading; secondController.abort();
  await assert.rejects(readOperation, /stopped or exceeded/); assert.equal(cancelled, true);
});

test('a cancelled ADC lookup cannot upload content even if token resolution completes later', async () => {
  const controller = new AbortController(); let resolveHeaders!: (headers: HeadersInit) => void; let authStarted!: () => void;
  const began = new Promise<void>(resolve => { authStarted = resolve; }); let calls = 0;
  const execute = createEmbeddingExecutor({ vertexHeaders: async () => { authStarted(); return new Promise<HeadersInit>(resolve => { resolveHeaders = resolve; }); }, fetch: async () => { calls++; return nativeResponse(); } });
  const operation = execute(vertex, { text: 'Private content' }, { ...requestOptions(), signal: controller.signal });
  await began; controller.abort(); await assert.rejects(operation, /stopped or exceeded/);
  resolveHeaders({ Authorization: 'Bearer late-token' }); await Promise.resolve();
  assert.equal(calls, 0);
});

test('provider stream cleanup cannot keep an already cancelled embedding worker alive', async () => {
  const controller = new AbortController(); let readingStarted!: () => void; let cancellationRequested = false;
  const reading = new Promise<void>(resolve => { readingStarted = resolve; });
  const stream = new ReadableStream<Uint8Array>({ pull() { readingStarted(); }, cancel() { cancellationRequested = true; return new Promise<void>(() => {}); } });
  const execute = createEmbeddingExecutor({ fetch: async () => new Response(stream) });
  const operation = execute(local, { text: 'Document' }, { ...requestOptions(), signal: controller.signal });
  await reading; controller.abort();
  await assert.rejects(operation, /stopped or exceeded/);
  assert.equal(cancellationRequested, true);
});
