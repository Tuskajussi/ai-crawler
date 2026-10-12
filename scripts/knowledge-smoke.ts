import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../server/index';
import { defaultEmbeddingConfig, type EmbeddingConfig, type KnowledgeChunk, type KnowledgePreview, type KnowledgeSearchResult, type KnowledgeStatus } from '../shared/knowledge';

// These fixtures test browser consent and presentation. Backend/provider tests cover real embeddings and media preparation.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-knowledge-ui-'));
const providerRequests: string[] = [];
const provider = createHttpServer(async (request, response) => {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { input: string; model: string };
  assert.equal(request.url, '/v1/embeddings'); assert.equal(body.model, 'ui-fixture-embedding');
  providerRequests.push(body.input);
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ model: body.model, data: [{ index: 0, embedding: [1, 0, 0] }] }));
});
provider.listen(0, '127.0.0.1');
await new Promise<void>(resolve => provider.once('listening', resolve));
const providerAddress = provider.address(); assert(providerAddress && typeof providerAddress !== 'string');
const { app, shutdown } = await createApp({ statePath: path.join(temporary, 'state.json') });
const apiServer = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => apiServer.once('listening', resolve));
const address = apiServer.address();
assert(address && typeof address !== 'string');
const vite = await createServer({ server: { host: '127.0.0.1', port: 5191, strictPort: true, proxy: { '/api': `http://127.0.0.1:${address.port}` } } });
await vite.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
try {
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  page = await browser.newPage({ viewport: { width: 1512, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const status: KnowledgeStatus = { config: { ...defaultEmbeddingConfig }, readiness: { ready: true, message: 'UI fixture: configuration valid; no provider contacted.' }, sources: [], limits: { uploadBytes: 100 * 1024 * 1024, chunksPerSource: 100, totalChunks: 1000, sources: 100 } };
  const previews = new Map<string, KnowledgePreview>();
  const chunks = new Map<string, KnowledgeChunk[]>();
  const createBodies: { previewId: string; allowCloudUpload: boolean }[] = [];
  const searchBodies: { query: string; allowCloudUpload: boolean }[] = [];
  const uploads: { name: string; mimeType: string; bytes: number }[] = [];
  let polls = 0;
  let cancelCalls = 0;
  let configSaves = 0;
  let deletionCalls = 0;
  let pendingPreview: KnowledgePreview | undefined;
  let holdJob = false;
  let completeOnCancel = false;
  let holdPreparation = false;
  let releasePreparation: (() => void) | undefined;
  const knowledgeRoutePattern = /\/api\/knowledge(?:\/|$)/;
  await page.context().route(knowledgeRoutePattern, async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace('/api/knowledge', '');
    const method = request.method();
    if (endpoint === '' && method === 'GET') {
      if (status.job?.status === 'running' && !holdJob && ++polls >= 2 && pendingPreview) {
        const sourceId = randomUUID();
        status.sources.push({ id: sourceId, name: pendingPreview.name, modality: pendingPreview.modality, bytes: pendingPreview.bytes, chunkCount: pendingPreview.chunks.length, dimensions: status.config.dimensions, modelId: status.config.modelId, spaceKey: 'fixture', createdAt: new Date().toISOString(), compatible: true });
        chunks.set(sourceId, pendingPreview.chunks);
        status.job = { ...status.job, status: 'completed', completedChunks: status.job.totalChunks, finishedAt: new Date().toISOString(), sourceId };
      }
      await route.fulfill({ json: status });
    } else if (endpoint === '/config' && method === 'PUT') {
      const next = request.postDataJSON() as EmbeddingConfig;
      const identity = (config: EmbeddingConfig) => `${config.provider}/${config.baseUrl}/${config.modelId}/${config.dimensions}`;
      if (identity(next) !== identity(status.config)) for (const source of status.sources) source.compatible = false;
      status.config = next; configSaves++;
      await route.fulfill({ json: status });
    } else if (endpoint === '/preview' && method === 'POST') {
      if (holdPreparation) await new Promise<void>(resolve => { releasePreparation = resolve; });
      const raw = request.postDataBuffer() ?? Buffer.alloc(0);
      const isText = request.headers()['content-type']?.startsWith('application/json');
      const body = isText ? request.postDataJSON() as { name: string; text: string } : undefined;
      const name = body?.name || decodeURIComponent(request.headers()['x-file-name'] || 'Source');
      const mimeType = body ? 'text/plain' : request.headers()['x-file-type'];
      const modality = body || mimeType?.startsWith('text/') ? 'text' : mimeType === 'application/pdf' ? 'pdf' : mimeType?.startsWith('image/') ? 'image' : mimeType?.startsWith('audio/') ? 'audio' : 'video';
      const prepared: KnowledgeChunk[] = modality === 'video' ? [
        { id: randomUUID(), index: 0, modality: 'video', mimeType: 'video/mp4', preview: 'Video frames from the selected clip.', locator: { startSeconds: 0, endSeconds: 15, track: 'video' } },
        { id: randomUUID(), index: 1, modality: 'audio', mimeType: 'audio/wav', preview: 'Soundtrack from the selected clip.', locator: { startSeconds: 0, endSeconds: 15, track: 'audio' } },
      ] : [{ id: randomUUID(), index: 0, modality, mimeType: mimeType || 'text/plain', ...(body ? { text: body.text } : {}), preview: body?.text || `${modality} fixture chunk`, locator: modality === 'pdf' ? { pageStart: 1, pageEnd: 1 } : modality === 'audio' ? { startSeconds: 0, endSeconds: 20, track: 'audio' } : modality === 'text' ? { startLine: 1, endLine: 2, startChar: 0, endChar: body?.text.length || raw.length } : {} }];
      const preview: KnowledgePreview = { id: randomUUID(), name, modality, bytes: raw.length, chunks: prepared, expiresAt: new Date(Date.now() + 900000).toISOString() };
      previews.set(preview.id, preview); uploads.push({ name, mimeType: mimeType || '', bytes: raw.length });
      await route.fulfill({ json: preview }).catch(() => {});
    } else if (endpoint === '/index' && method === 'POST') {
      const body = request.postDataJSON() as { previewId: string; allowCloudUpload: boolean };
      createBodies.push(body); pendingPreview = previews.get(body.previewId); assert(pendingPreview);
      status.job = { id: randomUUID(), sourceName: pendingPreview.name, status: 'running', completedChunks: 0, totalChunks: pendingPreview.chunks.length, startedAt: new Date().toISOString() }; polls = 0;
      await route.fulfill({ status: 202, json: status.job });
    } else if (/^\/jobs\/[^/]+\/cancel$/.test(endpoint)) {
      cancelCalls++; assert(status.job);
      if (completeOnCancel) {
        assert(pendingPreview);
        const sourceId = randomUUID();
        status.sources.push({ id: sourceId, name: pendingPreview.name, modality: pendingPreview.modality, bytes: pendingPreview.bytes, chunkCount: pendingPreview.chunks.length, dimensions: status.config.dimensions, modelId: status.config.modelId, spaceKey: 'fixture', createdAt: new Date().toISOString(), compatible: true });
        chunks.set(sourceId, pendingPreview.chunks);
        status.job = { ...status.job, status: 'completed', completedChunks: status.job.totalChunks, finishedAt: new Date().toISOString(), sourceId };
      } else status.job = { ...status.job, status: 'cancelled', finishedAt: new Date().toISOString() };
      await route.fulfill({ json: status });
    } else if (endpoint === '/search') {
      const body = request.postDataJSON() as { query: string; allowCloudUpload: boolean; sourceIds?: string[] };
      searchBodies.push(body);
      const results: KnowledgeSearchResult[] = status.sources.filter(source => source.compatible && (!body.sourceIds || body.sourceIds.includes(source.id))).flatMap(source => (chunks.get(source.id) || []).map(chunk => ({ sourceId: source.id, sourceName: source.name, chunk, score: 0.875 })));
      await route.fulfill({ json: { results } });
    } else if (/^\/sources\/[^/]+$/.test(endpoint) && method === 'DELETE') {
      const id = endpoint.split('/')[2]; status.sources = status.sources.filter(source => source.id !== id); chunks.delete(id); deletionCalls++;
      await route.fulfill({ json: status });
    } else if (/^\/previews\/[^/]+$/.test(endpoint) && method === 'DELETE') {
      previews.delete(endpoint.split('/')[2]); await route.fulfill({ status: 204 });
    } else if (/^\/sources\/[^/]+\/chunks\/[^/]+\/content$/.test(endpoint)) {
      await route.fulfill({ contentType: 'audio/wav', headers: { 'Content-Disposition': 'attachment; filename="demo-audio.wav"' }, body: Buffer.from('audio download fixture') });
    } else if (/^\/sources\/[^/]+\/export$/.test(endpoint)) {
      await route.fulfill({ contentType: 'application/json', headers: { 'Content-Disposition': 'attachment; filename="knowledge-fixture.json"' }, body: JSON.stringify({ source: status.sources[0], chunks: [] }) });
    } else throw new Error(`Unexpected Knowledge fixture endpoint ${method} ${endpoint}`);
  });
  await mkdir('.crawlspace/previews', { recursive: true });
  await page.goto('http://127.0.0.1:5191', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByText(status.readiness.message, { exact: true }).waitFor();
  assert.equal(createBodies.length + searchBodies.length, 0, 'Opening Knowledge must not call an embedding provider');
  await page.getByRole('textbox', { name: 'Source name', exact: true }).fill('Käytön notes');
  await page.getByRole('textbox', { name: 'Text to index', exact: true }).fill('Local and cloud workers share useful context.\nThe search index records source locations.');
  await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
  await page.getByRole('heading', { name: 'Käytön notes', exact: true }).waitFor();
  assert.equal(createBodies.length + searchBodies.length, 0, 'Chunk preparation must stay local');
  const create = page.getByRole('button', { name: 'Create embeddings', exact: true });
  assert.equal(await create.isDisabled(), true, 'Cloud embedding creation requires explicit consent');
  await page.getByRole('checkbox', { name: /Send these 1 chunks/ }).check();
  await create.click();
  await page.getByText('Käytön notes saved with 1 searchable chunks.', { exact: true }).waitFor();
  assert.equal(createBodies[0].allowCloudUpload, true);
  await page.getByRole('textbox', { name: 'Search query', exact: true }).fill('source locations');
  const search = page.getByRole('button', { name: 'Search chunks', exact: true });
  assert.equal(await search.isDisabled(), true, 'Cloud queries require separate explicit consent');
  await page.getByRole('checkbox', { name: /Send this search query/ }).check();
  await search.click();
  await page.getByLabel('Search results', { exact: true }).getByText('Similarity 0.875', { exact: true }).waitFor();
  assert.equal(searchBodies[0].allowCloudUpload, true);
  assert.match(await page.locator('.knowledge-result cite').innerText(), /Käytön notes · Chunk 1 · Text · Lines 1-2/);
  assert.equal(await page.getByRole('checkbox', { name: /Send this search query/ }).isChecked(), false, 'Consent is scoped to one search');

  const pdf = await PDFDocument.create(); pdf.addPage();
  const files = [
    { name: 'Source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()), location: 'Page 1' },
    { name: 'Picture.png', mimeType: 'image/png', buffer: Buffer.from('image fixture'), location: 'Whole source' },
    { name: 'Interview.wav', mimeType: 'audio/wav', buffer: Buffer.from('audio fixture'), location: 'Audio 0:00-0:20' },
    { name: 'Demo.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video fixture'), location: 'Video 0:00-0:15' },
  ];
  for (const input of files) {
    await page.getByRole('button', { name: 'Choose a file', exact: true }).click();
    await page.getByLabel('File', { exact: true }).setInputFiles({ name: input.name, mimeType: input.mimeType, buffer: input.buffer });
    await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
    await page.getByLabel('Prepared chunks', { exact: true }).getByText(input.location, { exact: true }).waitFor();
    if (input.mimeType === 'application/pdf') await page.getByText("Dense PDF pages can exceed the model's input limit and may be truncated. Split or simplify those pages for complete coverage.", { exact: true }).waitFor();
    if (input.mimeType === 'video/mp4') await page.getByLabel('Prepared chunks', { exact: true }).getByText('Audio 0:00-0:15', { exact: true }).waitFor();
    assert.equal(createBodies.length, 1, 'Selecting and previewing media never embeds it automatically');
  }
  await page.getByRole('checkbox', { name: /Send these 2 chunks/ }).check();
  await create.click();
  await page.getByText('Demo.mp4 saved with 2 searchable chunks.', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: /Send this search query/ }).check();
  await search.click();
  await page.locator('.knowledge-result cite').filter({ hasText: 'Demo.mp4 · Chunk 2 · Audio · Audio 0:00-0:15' }).waitFor();
  assert.match(await page.getByRole('link', { name: 'Download chunk 2 from Demo.mp4', exact: true }).getAttribute('href') || '', /^\/api\/knowledge\/sources\/[^/]+\/chunks\/[^/]+\/content$/);
  assert.deepEqual(uploads.slice(1).map(input => input.name), files.map(input => input.name));
  assert(uploads[1].bytes > 100, 'A real PDF can be selected and uploaded in the browser');
  await page.screenshot({ path: '.crawlspace/previews/knowledge-desktop.png', fullPage: true });

  await page.getByLabel('Embedding provider', { exact: true }).selectOption('vertex');
  await page.getByLabel('Google Cloud project ID', { exact: true }).fill('fixture-project');
  await page.getByLabel('Vertex location', { exact: true }).selectOption('eu');
  await page.getByRole('button', { name: 'Save embedding settings', exact: true }).click();
  await page.getByText('Embedding settings saved.', { exact: true }).waitFor();
  assert.equal(status.config.provider, 'vertex'); assert.equal(status.config.apiKeyEnv, '');
  await page.getByLabel('Embedding provider', { exact: true }).selectOption('compatible');
  await page.getByRole('button', { name: 'Save embedding settings', exact: true }).click();
  await page.getByText('Embedding settings saved.', { exact: true }).waitFor();
  assert.equal(configSaves, 2); assert.equal(status.config.kind, 'local');
  await page.getByText('Uses another embedding space. Switch back to its provider, model and dimensions to search it.', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('checkbox').count(), 0, 'Local server actions do not show cloud upload consent');
  await page.getByRole('button', { name: 'Paste text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Source name', exact: true }).fill('Local notes');
  await page.getByRole('textbox', { name: 'Text to index', exact: true }).fill('A local embedding source.');
  await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
  await page.getByRole('heading', { name: 'Local notes', exact: true }).waitFor();
  await create.click();
  await page.getByText('Local notes saved with 1 searchable chunks.', { exact: true }).waitFor();
  assert.equal(createBodies.at(-1)?.allowCloudUpload, false);
  await search.click();
  await page.getByLabel('Search results', { exact: true }).getByText('A local embedding source.', { exact: true }).waitFor();
  assert.equal(searchBodies.at(-1)?.allowCloudUpload, false);

  holdJob = true;
  await page.getByRole('textbox', { name: 'Source name', exact: true }).fill('Cancelled source');
  await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
  await page.getByRole('heading', { name: 'Cancelled source', exact: true }).waitFor();
  await create.click();
  await page.getByRole('button', { name: 'Cancel creation', exact: true }).click();
  await page.getByText('Creation cancelled', { exact: true }).waitFor();
  assert.equal(cancelCalls, 1); assert.equal(status.sources.some(source => source.name === 'Cancelled source'), false);
  assert.equal(await page.getByLabel('Prepared chunks', { exact: true }).count(), 0, 'Accepted jobs consume their preview, including cancelled jobs');
  completeOnCancel = true;
  await page.getByRole('textbox', { name: 'Source name', exact: true }).fill('Finishing source');
  await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
  await page.getByRole('heading', { name: 'Finishing source', exact: true }).waitFor();
  await create.click();
  await page.getByRole('button', { name: 'Cancel creation', exact: true }).click();
  await page.getByText('Finishing source saved with 1 searchable chunks.', { exact: true }).waitFor();
  assert.equal(cancelCalls, 2); assert.equal(status.sources.some(source => source.name === 'Finishing source'), true, 'Completion wins a cancellation race');
  assert.equal(await page.getByText('Creation cancelled', { exact: true }).count(), 0, 'A cancellation race must report the actual completed state');
  holdPreparation = true;
  await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
  const preparationDeadline = Date.now() + 5000;
  while (!releasePreparation && Date.now() < preparationDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(releasePreparation, 'The preparation request reached the local fixture');
  await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
  await page.getByText('File preparation cancelled.', { exact: true }).waitFor();
  releasePreparation?.(); holdPreparation = false;

  await page.getByRole('button', { name: 'Delete Local notes', exact: true }).click();
  await page.getByRole('button', { name: 'Keep source', exact: true }).click();
  assert.equal(deletionCalls, 0, 'Deleting a saved source requires the inline confirmation');
  await page.getByRole('button', { name: 'Delete Local notes', exact: true }).click();
  await page.getByRole('button', { name: 'Delete source', exact: true }).click();
  await page.getByText('Source and its saved embeddings deleted.', { exact: true }).waitFor();
  assert.equal(deletionCalls, 1);
  assert.match(await page.getByRole('link', { name: 'Export Käytön notes', exact: true }).getAttribute('href') || '', /^\/api\/knowledge\/sources\/[^/]+\/export$/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('heading', { name: 'Käytön notes', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Embedding provider', { exact: true }).inputValue(), 'compatible');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.crawlspace/previews/knowledge-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Knowledge must fit a mobile screen');
  assert.equal(providerRequests.length, 0, 'Transport fixtures never contact an embedding model');

  // Exercise the actual UI -> API -> chunker -> compatible adapter -> persisted index path against a loopback provider.
  await page.context().unroute(knowledgeRoutePattern);
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByLabel('Embedding provider', { exact: true }).selectOption('compatible');
  await page.getByLabel('Embedding server URL', { exact: true }).fill(`http://127.0.0.1:${providerAddress.port}/v1`);
  await page.getByLabel('Embedding model ID', { exact: true }).fill('ui-fixture-embedding');
  await page.getByLabel('Vector dimensions', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save embedding settings', exact: true }).click();
  await page.getByText('Embedding settings saved.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Source name', exact: true }).fill('API integration source');
  const integrationText = 'Actual local preparation preserves this source.\nSearch citations identify the original lines.';
  await page.getByRole('textbox', { name: 'Text to index', exact: true }).fill(integrationText);
  await page.getByRole('button', { name: 'Preview chunks', exact: true }).click();
  await page.getByLabel('Prepared chunks', { exact: true }).getByText(integrationText, { exact: true }).waitFor();
  assert.equal(providerRequests.length, 0, 'Actual preparation remains local');
  await create.click();
  await page.getByText('API integration source saved with 1 searchable chunks.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Search query', exact: true }).fill('original source lines');
  await search.click();
  await page.getByLabel('Search results', { exact: true }).getByText(integrationText, { exact: true }).waitFor();
  assert.equal(providerRequests.length, 2, 'The actual adapter handles one document and one query request');
  assert(providerRequests[0].includes(integrationText));
  const contentPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download chunk 1 from API integration source', exact: true }).click();
  const contentPath = await (await contentPromise).path(); assert(contentPath);
  assert.equal(await readFile(contentPath, 'utf8'), integrationText, 'Saved text chunks can be downloaded exactly');
  const actualExportPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export API integration source', exact: true }).click();
  const exportPath = await (await actualExportPromise).path(); assert(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8')) as { source: { chunks: { vector: number[] }[] } };
  assert.deepEqual(exported.source.chunks[0].vector, [1, 0, 0], 'Export contains actual saved normalized vectors');
  const saved = JSON.parse(await readFile(path.join(temporary, 'knowledge', 'index.json'), 'utf8')) as { sources: { name: string }[] };
  assert.equal(saved.sources[0].name, 'API integration source', 'The browser action commits a durable local source');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('heading', { name: 'API integration source', exact: true }).waitFor();
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Knowledge UI smoke passed: local transport fixtures verify all five media types, per-action cloud consent, citations, Vertex setup, separate search spaces, progress/cancel, deletion, downloads, UTF-8 names and mobile layout. A real UI/API/chunker/provider-adapter flow against a loopback embedding fixture verifies saved vectors, search, exact chunk download, JSON export, durable disk state and reload. No cloud provider was contacted.');
} catch (failure) {
  await page?.screenshot({ path: '.crawlspace/previews/knowledge-failure.png', fullPage: true });
  throw failure;
} finally {
  await browser?.close(); await vite.close(); await shutdown();
  await new Promise<void>(resolve => apiServer.close(() => resolve()));
  await new Promise<void>(resolve => provider.close(() => resolve()));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith('crawlspace-knowledge-ui-'));
  await rm(temporary, { recursive: true, force: true });
}
