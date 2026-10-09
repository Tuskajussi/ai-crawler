/** Exercise the installed Pi adapter with a localhost-only, deterministic model. */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutionContext } from '../server/engine';
import { createPiExecutor, piAvailable } from '../server/pi';

console.log(`Pi smoke process ${process.pid}: loading the installed SDK.`);
if (!(await piAvailable())) throw new Error('Install @earendil-works/pi-coding-agent and typebox before running this smoke test.');
console.log('Pi SDK loaded.');

const temporaryParent = path.resolve(tmpdir());
const temporaryRoot = await mkdtemp(path.join(temporaryParent, 'crawlspace-pi-smoke-'));
const projectPath = path.join(temporaryRoot, 'project');
const statePath = path.join(temporaryRoot, 'state');
await mkdir(projectPath);
await mkdir(statePath);
await writeFile(path.join(projectPath, 'app.ts'), 'export const total = items[0].price; // SMOKE_PROJECT_CONTENT\n');
await writeFile(path.join(temporaryRoot, 'outside.ts'), 'SMOKE_OUTSIDE_CONTENT_MUST_STAY_PRIVATE\n');

let mode: 'tools' | 'screenshot' | 'abort' = 'tools';
let requestCount = 0;
let screenshotRequests = 0;
let requestFailure: unknown;
let startedAbortRequest!: () => void;
const abortRequestStarted = new Promise<void>(resolve => { startedAbortRequest = resolve; });
const openResponses = new Set<ServerResponse>();
const expectedTools = ['project_read', 'project_ls', 'project_find', 'project_grep', 'list_staff'];

function event(response: ServerResponse, delta: object, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke-coder', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finish(response: ServerResponse, reason: string): void {
  event(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke-coder', choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = createServer(async (request, response) => {
  console.log(`Local model request (${mode}).`);
  try {
    if (request.method === 'GET' && request.url === '/preview') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><head><title>Screenshot smoke fixture</title></head><body style="font:20px Arial;padding:40px"><h1>Local screenshot fixture</h1><button style="padding:20px;color:white;background:white;border:1px solid #ddd">Invisible label</button></body></html>');
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'smoke-coder');
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), mode === 'screenshot' ? ['capture_ui', 'list_staff'] : [...expectedTools].sort());
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    event(response, { role: 'assistant' });
    if (mode === 'screenshot') {
      screenshotRequests++;
      const image = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((part: any) => part.type === 'image_url');
      assert.match(image?.image_url?.url ?? '', /^data:image\/(?:png|jpeg);base64,/);
      assert.ok(Buffer.from(image.image_url.url.split(',')[1], 'base64').length > 1000, 'The model must receive an actual screenshot payload.');
      event(response, { content: JSON.stringify({ findings: [{ title: 'Invisible button label', description: 'The screenshot fixture renders white button text on its white background.', severity: 'medium' }], messages: [], assignments: [] }) });
      finish(response, 'stop');
      return;
    }
    if (mode === 'abort') {
      openResponses.add(response);
      response.once('close', () => openResponses.delete(response));
      startedAbortRequest();
      return;
    }
    requestCount++;
    if (requestCount === 1) {
      event(response, { tool_calls: [
        { index: 0, id: 'call_project', type: 'function', function: { name: 'project_read', arguments: JSON.stringify({ path: 'app.ts', offset: 1, limit: 5 }) } },
        { index: 1, id: 'call_escape', type: 'function', function: { name: 'project_read', arguments: JSON.stringify({ path: '../outside.ts' }) } },
        { index: 2, id: 'call_staff', type: 'function', function: { name: 'list_staff', arguments: '{}' } },
      ] });
      finish(response, 'tool_calls');
      return;
    }
    assert.equal(requestCount, 2, 'An unexpected additional model request occurred.');
    const readResult = body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_project');
    const blockedResult = body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_escape');
    const staffResult = body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_staff');
    assert.match(JSON.stringify(readResult), /SMOKE_PROJECT_CONTENT/);
    assert.match(JSON.stringify(blockedResult), /outside the selected project folder is blocked/i);
    assert.doesNotMatch(JSON.stringify(blockedResult), /SMOKE_OUTSIDE_CONTENT_MUST_STAY_PRIVATE/);
    assert.match(JSON.stringify(staffResult), /Boundary review/);
    event(response, { content: JSON.stringify({ findings: [{ title: 'Missing empty-list handling', description: 'app.ts line 1 reads items[0].price without verifying that an item exists.', severity: 'medium', file: 'app.ts', line: 1 }], messages: [{ to: 'all', text: 'Reviewed the source evidence.' }], assignments: [] }) });
    finish(response, 'stop');
  } catch (error) {
    requestFailure = error;
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

const originalFetch = globalThis.fetch;
let fetchCount = 0;
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, origin, `External request blocked by smoke harness: ${url.origin}`);
    fetchCount++;
    return originalFetch(input, init);
  };

  const node: ExecutionContext['node'] = { id: 'reviewer', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Smoke reviewer', role: 'reviewer', description: 'Deterministic integration reviewer', persona: 'You review source evidence.', prompt: 'Review app.ts and return a JSON report.', responsibilities: ['Boundary review'], modelId: 'smoke', color: '#00a99d', tools: ['read'], status: 'idle' } };
  const context: ExecutionContext = {
    workflow: { id: 'smoke', name: 'Pi smoke', description: 'Local adapter test', nodes: [node], edges: [], settings: { mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: node.id, projectPath, previewUrl: '', executionMode: 'pi' } },
    models: [{ id: 'smoke', name: 'Local deterministic stub', provider: 'custom', modelId: 'smoke-coder', kind: 'local', baseUrl: `${origin}/v1`, apiKeyEnv: '', enabled: true, contextWindow: 32768, supportsImages: false }],
    node, run: { id: 'smoke', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 }, cycle: 1, messages: [], findings: [], signal: new AbortController().signal,
  };
  const executor = createPiExecutor(statePath);
  console.log('Starting actual Pi adapter with the local stub.');
  const report = await executor(context);
  if (requestFailure) throw requestFailure;
  assert.equal(requestCount, 2);
  assert.equal(report.findings?.[0]?.file, 'app.ts');
  assert.equal(report.findings?.[0]?.line, 1);
  assert.equal(report.findings?.[0]?.title, 'Missing empty-list handling');
  assert.equal(report.messages?.[0]?.to, 'all');
  assert.deepEqual(report.assignments, []);

  const { chromium } = await import('playwright');
  let screenshotAvailable = true;
  try { await access(chromium.executablePath()); } catch { screenshotAvailable = false; }
  if (screenshotAvailable) {
    mode = 'screenshot';
    console.log('Source tool path passed. Starting actual Chromium screenshot probe.');
    const visualNode = { ...node, data: { ...node.data, tools: ['screenshot'] as ('read' | 'screenshot')[] } };
    const visualReport = await executor({ ...context, node: visualNode, models: [{ ...context.models[0], supportsImages: true }], workflow: { ...context.workflow, nodes: [visualNode], settings: { ...context.workflow.settings, previewUrl: `${origin}/preview` } } });
    if (requestFailure) throw requestFailure;
    assert.equal(screenshotRequests, 1);
    assert.equal(visualReport.findings?.[0]?.title, 'Invisible button label');
    const screenshotUrl = visualReport.findings?.[0]?.screenshot;
    assert.match(screenshotUrl ?? '', /^\/api\/screenshots\/[a-f0-9-]+\.png$/);
    const png = await readFile(path.join(statePath, 'screenshots', path.basename(screenshotUrl!)));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 1440);
    assert.equal(png.readUInt32BE(20), 1000);
    console.log('PASS: Chromium captured 1440×1000 PNG, Pi attached image input, and UI report received the actual screenshot evidence URL.');
  } else console.log('SKIP: screenshot integration needs the Playwright Chromium installation.');

  mode = 'abort';
  console.log('Tool and report path passed. Starting cancellation probe.');
  const controller = new AbortController();
  const abortRun = executor({ ...context, signal: controller.signal, run: { ...context.run, id: 'abort-smoke' } });
  const pendingFailure = abortRun.then(() => { throw new Error('Aborted Pi run unexpectedly succeeded.'); }, error => error);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([abortRequestStarted, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Pi abort probe never reached its local provider.')), 20_000); })]);
    controller.abort();
    const error = await Promise.race([pendingFailure, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Pi did not stop within five seconds.')), 5000).unref())]);
    assert.ok(error instanceof Error);
    assert.match(error.message, /stopped|abort/i);
  } finally { controller.abort(); if (timer) clearTimeout(timer); }
  if (requestFailure) throw requestFailure;
  assert.equal(fetchCount, screenshotAvailable ? 4 : 3, 'Only the expected tool-review, screenshot, and abort requests should reach the local provider.');
  console.log('PASS: installed Pi SDK → localhost SSE provider → confined source/staff tools → validated finding report; outside-project read blocked; active model stream aborted. No external requests or credentials used.');
} finally {
  globalThis.fetch = originalFetch;
  for (const response of openResponses) response.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const absoluteCleanup = path.resolve(temporaryRoot);
  assert.equal(path.dirname(absoluteCleanup), temporaryParent);
  assert.ok(path.basename(absoluteCleanup).startsWith('crawlspace-pi-smoke-'));
  await rm(absoluteCleanup, { recursive: true, force: true });
}
