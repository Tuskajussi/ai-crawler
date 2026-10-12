/** Exercise the installed Pi adapter with a localhost-only, deterministic model. */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine, type ExecutionContext } from '../server/engine';
import { createPiExecutor, piAvailable } from '../server/pi';
import { ProjectReader } from '../server/project';
import { StateStore } from '../server/store';
import { probeModel } from '../server/probe';

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

let mode: 'tools' | 'codemode' | 'budget' | 'cpu-abort' | 'screenshot' | 'screenshot-code' | 'abort' | 'retry' | 'repair' | 'bad-report' | 'probe' | 'quota' | 'backoff-abort' | 'limits' | 'retry-budget' = 'tools';
let faultRequests = 0;
let retryToolExecutions = 0;
let requestCount = 0;
let codemodeRequests = 0;
let budgetRequests = 0;
let budgetToolExecutions = 0;
let cpuRequests = 0;
let screenshotRequests = 0;
let screenshotCodeRequests = 0;
let requestFailure: unknown;
let startedAbortRequest!: () => void;
const abortRequestStarted = new Promise<void>(resolve => { startedAbortRequest = resolve; });
let startedCpuTool!: () => void;
const cpuToolStarted = new Promise<void>(resolve => { startedCpuTool = resolve; });
const openResponses = new Set<ServerResponse>();
const expectedTools = ['project_read', 'project_ls', 'project_find', 'project_grep', 'list_staff'];
const originalList = ProjectReader.prototype.list;
ProjectReader.prototype.list = async function (...args) {
  if (mode === 'budget') budgetToolExecutions++;
  if (mode === 'retry-budget') retryToolExecutions++;
  const result = await originalList.apply(this, args);
  if (mode === 'cpu-abort') startedCpuTool();
  return result;
};

const codeReview = `
if (load('visit-marker') !== undefined) throw new Error('Code Mode store leaked from an earlier visit');
store('visit-marker', 'this-visit');
let sum = 0;
for (let index = 0; index < 5; index++) sum += index;
const results = await Promise.allSettled([
  tools.project_read({path:'app.ts',offset:1,limit:5}),
  tools.list_staff({}),
  tools.project_read({path:'../outside.ts'})
]);
const globals = {models:typeof models,process:typeof process,require:typeof require,fetch:typeof fetch};
for (const [name, value] of Object.entries(globals)) if (value !== 'undefined') throw new Error('Forbidden global: '+name);
for (const name of ['bash','powershell','write','edit','codemode']) {
  if (ALL_TOOLS.some(tool=>tool.name===name)) throw new Error('Forbidden tool exposed: '+name);
  try { await tools[name]({}); throw new Error('Forbidden tool executed: '+name); }
  catch (error) { if (String(error).includes('Forbidden tool executed')) throw error; }
}
text({sum,tools:ALL_TOOLS.map(tool=>tool.name).sort(),globals,storeWasFresh:true,source:results[0],staff:results[1],traversal:results[2].status==='rejected'?String(results[2].reason):results[2]});
`;

function callCode(response: ServerResponse, id: string, code: string) {
  event(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] });
  finish(response, 'tool_calls');
}

function finalReport(response: ServerResponse) {
  event(response, { content: JSON.stringify({ findings: [{ title: 'Missing empty-list handling', description: 'app.ts line 1 reads items[0].price without verifying that an item exists.', severity: 'medium', file: 'app.ts', line: 1 }], messages: [{ to: 'all', text: 'Reviewed the source evidence.' }], assignments: [] }) });
  finish(response, 'stop');
}

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
    if (mode === 'retry-budget') {
      faultRequests++;
      if (faultRequests === 2) {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        response.end(JSON.stringify({ error: { message: 'Temporary provider failure after tools' } }));
      } else {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        event(response, { role: 'assistant' });
        callCode(response, `retry_budget_${faultRequests}`, `for (let index = 0; index < 39; index++) await tools.project_ls({path:''});`);
      }
      return;
    }
    if (['retry', 'repair', 'bad-report', 'quota', 'backoff-abort', 'limits', 'probe'].includes(mode)) {
      faultRequests++;
      if ((mode === 'retry' && faultRequests < 3) || mode === 'quota' || mode === 'backoff-abort') {
        response.writeHead(mode === 'retry' ? 503 : 429, { 'Content-Type': 'application/json', 'Retry-After': mode === 'backoff-abort' ? '5' : '0' });
        response.end(JSON.stringify({ error: { message: mode === 'quota' ? 'insufficient_quota: subscription usage limit reached' : 'Temporary inference server overload' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      event(response, { role: 'assistant' });
      if (mode === 'probe') {
        assert.equal(body.reasoning_effort, 'medium');
        assert.equal(body.max_tokens, 2048);
        assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['connection_check']);
        const tool = body.messages.find((message: any) => message.role === 'tool');
        if (!tool) {
          event(response, { tool_calls: [{ index: 0, id: 'probe-call', type: 'function', function: { name: 'connection_check', arguments: '{}' } }] });
          finish(response, 'tool_calls');
        } else {
          const value = typeof tool.content === 'string' ? tool.content : tool.content.find((part: any) => part.type === 'text').text;
          event(response, { content: JSON.stringify({ ready: true, value }) });
          finish(response, 'stop');
        }
        return;
      }
      if (mode === 'bad-report' || (mode === 'repair' && faultRequests === 1)) {
        event(response, { content: 'Not valid report JSON' });
      } else {
        if (mode === 'limits') {
          assert.equal(body.max_tokens, 2048);
          assert.equal(body.reasoning_effort, 'medium');
          assert.ok(JSON.stringify(body.messages).length < 32_000, 'Large shared history must be omitted before sending.');
        }
        if (mode === 'repair') assert.match(JSON.stringify(body.messages), /rejected|Correct it once/);
        event(response, { content: JSON.stringify({ findings: [], messages: [{ to: 'all', text: 'Completed bounded check' }], assignments: [] }) });
      }
      finish(response, 'stop');
      return;
    }
    const codeEnabled = ['codemode', 'budget', 'cpu-abort', 'screenshot-code'].includes(mode);
    const baseTools = mode === 'screenshot' || mode === 'screenshot-code' ? ['capture_ui', 'list_staff'] : expectedTools;
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), [...baseTools, ...(codeEnabled ? ['codemode'] : [])].sort());
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    event(response, { role: 'assistant' });
    if (mode === 'codemode') {
      const step = codemodeRequests++ % 3;
      if (step === 0) {
        assert.ok(!body.messages.some((message: any) => message.role === 'tool'), 'Each workflow visit starts with a fresh Pi session.');
        callCode(response, 'call_code_review', codeReview);
      } else if (step === 1) {
        const output = JSON.stringify(body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_code_review'));
        assert.match(output, /Script completed/);
        assert.match(output, /SMOKE_PROJECT_CONTENT/);
        assert.match(output, /Boundary review/);
        assert.match(output, /outside the selected project folder is blocked/i);
        assert.doesNotMatch(output, /SMOKE_OUTSIDE_CONTENT_MUST_STAY_PRIVATE/);
        assert.match(output, /storeWasFresh/);
        assert.match(output, /\\"sum\\":10/);
        callCode(response, 'call_code_store', `if (load('visit-marker') !== 'this-visit') throw new Error('Code Mode store was lost within a visit'); text('SESSION_STORE_WITHIN_VISIT');`);
      } else {
        assert.match(JSON.stringify(body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_code_store')), /SESSION_STORE_WITHIN_VISIT/);
        finalReport(response);
      }
      return;
    }
    if (mode === 'budget') {
      budgetRequests++;
      assert.equal(budgetRequests, 1, 'A terminated budget violation must not trigger another model request.');
      callCode(response, 'call_code_budget', `for (let index = 0; index < 45; index++) await tools.project_ls({path:''}); text('UNEXPECTED_BUDGET_SUCCESS');`);
      return;
    }
    if (mode === 'cpu-abort') {
      cpuRequests++;
      assert.equal(cpuRequests, 1);
      callCode(response, 'call_code_cpu', `await tools.project_ls({path:''}); while (true) {}`);
      return;
    }
    if (mode === 'screenshot' || mode === 'screenshot-code') {
      const images = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === 'image_url');
      assert.match(images[0]?.image_url?.url ?? '', /^data:image\/(?:png|jpeg);base64,/);
      assert.ok(Buffer.from(images[0].image_url.url.split(',')[1], 'base64').length > 1000, 'The model must receive an actual screenshot payload.');
      if (mode === 'screenshot-code') {
        screenshotCodeRequests++;
        if (screenshotCodeRequests === 1) {
          callCode(response, 'call_code_capture', `const capture = await tools.capture_ui({}); if (capture.image?.type !== 'image' || capture.image.mimeType !== 'image/png') throw new Error('Screenshot tool must expose structured image output'); image(capture.image); text(capture.text); text('CODEMODE_CAPTURE_IMAGE');`);
          return;
        }
        assert.equal(screenshotCodeRequests, 2);
        assert.match(JSON.stringify(body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_code_capture')), /CODEMODE_CAPTURE_IMAGE/);
        assert.ok(images.length >= 2, 'The follow-up request must include both the initial screenshot and the image emitted by Code Mode.');
        const emittedImage = Buffer.from(images.at(-1).image_url.url.split(',')[1], 'base64');
        assert.ok(emittedImage.length > 1000);
        assert.deepEqual([...emittedImage.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      } else screenshotRequests++;
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
    finalReport(response);
  } catch (error) {
    requestFailure = error;
    console.error('Local model assertion failed:', error);
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
    workflow: { id: 'smoke', name: 'Pi smoke', description: 'Local adapter test', nodes: [node], edges: [], settings: { mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: node.id, projectPath, previewUrl: '', executionMode: 'pi', codeMode: false } },
    // Hosting location does not imply authentication: custom servers may be keyless.
    models: [{ id: 'smoke', name: 'User-provided compatible model', provider: 'custom', modelId: 'smoke-coder', kind: 'cloud', baseUrl: `${origin}/v1`, apiKeyEnv: '', enabled: true, contextWindow: 32768, supportsImages: false }],
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

  mode = 'codemode';
  console.log('Direct-only regression passed. Starting an actual two-cycle Code Mode workflow.');
  // Omitted codeMode preserves the default for workflows saved before this setting existed.
  const { codeMode: _disabled, ...defaultSettings } = context.workflow.settings;
  const codeWorkflow = { ...context.workflow, settings: defaultSettings };
  const loopStore = await StateStore.open(path.join(statePath, 'loop-state.json'));
  await loopStore.update(state => {
    state.workflow = { ...codeWorkflow, settings: { ...codeWorkflow.settings, mode: 'loop', maxCycles: 2, intervalSeconds: 0 } };
    state.models = context.models;
    state.findings = []; state.messages = []; state.runs = [];
  });
  const loopEngine = new WorkflowEngine(loopStore, { piExecutor: executor });
  try {
    await loopEngine.start('pi');
    await loopEngine.waitForIdle();
    if (requestFailure) throw requestFailure;
    const loopState = loopStore.get();
    assert.equal(loopState.runs[0]?.status, 'completed', loopState.runs[0]?.error);
    assert.equal(loopState.runs[0]?.cycle, 2);
    assert.equal(loopState.runs[0]?.steps, 2);
    assert.equal(loopState.findings[0]?.file, 'app.ts');
    assert.equal(loopState.findings[0]?.line, 1);
    assert.ok(loopState.messages.some(message => message.to === 'all' && message.text === 'Reviewed the source evidence.'));
  } finally { await loopEngine.stop(); await loopEngine.waitForIdle(); await loopStore.flush(); }
  assert.equal(codemodeRequests, 6);
  console.log('PASS: actual Pi workflow completed two Code Mode cycles and two agent steps, parallel confined tools, source/staff evidence, denied traversal/tools/globals, validated reports, per-visit store isolation.');

  mode = 'budget';
  console.log('Starting nested Code Mode budget probe.');
  await assert.rejects(executor({ ...context, workflow: codeWorkflow }), /40-tool-call limit/);
  if (requestFailure) throw requestFailure;
  assert.equal(budgetToolExecutions, 39, 'The outer Code Mode call plus 39 nested calls consume the 40-call budget; the 41st total call must not execute.');
  assert.equal(budgetRequests, 1);
  console.log('PASS: Code Mode cannot bypass the 40-call budget; the 41st tool body never executes.');

  mode = 'cpu-abort';
  console.log('Starting pure CPU Code Mode cancellation probe.');
  const cpuController = new AbortController();
  const cpuRun = executor({ ...context, workflow: codeWorkflow, signal: cpuController.signal });
  const cpuFailure = cpuRun.then(() => { throw new Error('Aborted Code Mode script unexpectedly succeeded.'); }, error => error);
  let cpuTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([cpuToolStarted, new Promise<never>((_resolve, reject) => { cpuTimer = setTimeout(() => reject(new Error('Code Mode CPU probe never started its tool.')), 20_000); })]);
    if (cpuTimer) clearTimeout(cpuTimer);
    // Let the worker return from its final tool and enter the non-yielding JS loop.
    await new Promise(resolve => setTimeout(resolve, 100));
    const abortedAt = Date.now();
    cpuController.abort();
    const error = await Promise.race([cpuFailure, new Promise<never>((_resolve, reject) => { cpuTimer = setTimeout(() => reject(new Error('Code Mode CPU loop did not stop within five seconds.')), 5000); })]);
    assert.ok(error instanceof Error);
    assert.match(error.message, /stopped|abort/i);
    assert.ok(Date.now() - abortedAt < 5000);
  } finally { cpuController.abort(); if (cpuTimer) clearTimeout(cpuTimer); }
  if (requestFailure) throw requestFailure;
  assert.equal(cpuRequests, 1);
  console.log('PASS: Stop interrupts a pure CPU Code Mode loop promptly.');

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
    mode = 'screenshot-code';
    console.log('Starting Code Mode screenshot image round-trip probe.');
    const codeVisualReport = await executor({ ...context, node: visualNode, models: [{ ...context.models[0], supportsImages: true }], workflow: { ...codeWorkflow, nodes: [visualNode], settings: { ...codeWorkflow.settings, previewUrl: `${origin}/preview` } } });
    if (requestFailure) throw requestFailure;
    assert.equal(screenshotCodeRequests, 2);
    assert.equal(codeVisualReport.findings?.[0]?.title, 'Invisible button label');
    assert.match(codeVisualReport.findings?.[0]?.screenshot ?? '', /^\/api\/screenshots\/[a-f0-9-]+\.png$/);
    console.log('PASS: Code Mode consumed structured capture_ui output and image(capture.image) sent a real PNG back to the provider.');
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
  assert.equal(fetchCount, screenshotAvailable ? 14 : 11, 'Only the expected direct, Code Mode, budget, CPU cancellation, screenshot, and stream cancellation requests should reach the local provider.');
  console.log('PASS: installed Pi SDK → localhost SSE provider → confined source/staff tools → validated finding report; outside-project read blocked; active model stream aborted. No external requests or credentials used.');

  mode = 'retry'; faultRequests = 0;
  const retried = await executor(context);
  assert.equal(faultRequests, 3, 'Temporary errors have a three-attempt allowance.');
  assert.equal(retried.execution?.attempts, 3);
  assert.equal(retried.execution?.requests, 3);
  assert.equal(retried.messages?.[0].text, 'Completed bounded check');
  mode = 'repair'; faultRequests = 0;
  const repaired = await executor(context);
  assert.equal(faultRequests, 2);
  assert.equal(repaired.execution?.attempts, 1);
  mode = 'bad-report'; faultRequests = 0;
  await assert.rejects(executor(context), /remained invalid after one repair/);
  assert.equal(faultRequests, 2, 'Bad JSON must not create unlimited repair or visit retries.');
  mode = 'quota'; faultRequests = 0;
  await assert.rejects(executor(context), /insufficient_quota/);
  assert.equal(faultRequests, 1, 'Exhausted subscription allowance is not a transient retry.');
  mode = 'limits'; faultRequests = 0;
  await executor({ ...context, models: [{ ...context.models[0], maxOutputTokens: 2048, reasoningEffort: 'medium' }], messages: Array.from({ length: 40 }, (_, index) => ({ id: String(index), from: 'you', to: 'all', text: 'Large review history '.repeat(1000), type: 'message', createdAt: new Date().toISOString() })) });
  assert.equal(faultRequests, 1);
  mode = 'probe'; faultRequests = 0;
  const probe = await probeModel({ ...context.models[0], reasoningEffort: 'medium', maxOutputTokens: 2048 }, statePath);
  assert.equal(probe.ready, true, probe.message);
  assert.equal(faultRequests, 2, 'Connection readiness requires a real native tool/result round-trip.');
  mode = 'backoff-abort'; faultRequests = 0;
  const backoffController = new AbortController();
  const backoffRun = executor({ ...context, signal: backoffController.signal });
  const stoppedBackoff = backoffRun.then(() => { throw new Error('Backoff cancellation unexpectedly succeeded.'); }, error => error);
  while (faultRequests === 0) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 100));
  const stoppedAt = Date.now();
  backoffController.abort();
  const backoffError = await stoppedBackoff;
  assert.match(backoffError.message, /stopped|abort/i);
  assert.ok(Date.now() - stoppedAt < 1000, 'Retry backoff must stop promptly.');
  assert.equal(faultRequests, 1);
  mode = 'retry-budget'; faultRequests = 0;
  await assert.rejects(executor({ ...context, workflow: codeWorkflow }), /40-tool-call limit/);
  assert.equal(faultRequests, 3);
  assert.equal(retryToolExecutions, 39, 'Transient retries share the original tool budget; the replacement Code Mode body must not run.');
  if (requestFailure) throw requestFailure;
  console.log('PASS: bounded transient retries, one JSON repair, quota exhaustion, model reasoning/output limits, large inbox budgeting, native connection probe, cancellation during Retry-After backoff, and shared tool limits across retries.');
} finally {
  globalThis.fetch = originalFetch;
  ProjectReader.prototype.list = originalList;
  for (const response of openResponses) response.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const absoluteCleanup = path.resolve(temporaryRoot);
  assert.equal(path.dirname(absoluteCleanup), temporaryParent);
  assert.ok(path.basename(absoluteCleanup).startsWith('crawlspace-pi-smoke-'));
  await rm(absoluteCleanup, { recursive: true, force: true });
}
