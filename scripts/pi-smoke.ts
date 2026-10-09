/** Exercise the installed Pi adapter with a localhost-only, deterministic model. */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ExecutionContext } from '../server/engine';
import type { NodeResult } from '../shared/types';
import { createPiExecutor, launchScreenshotBrowser, piAvailable } from '../server/pi';

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

let mode: 'tools' | 'parallel' | 'judge' | 'screenshot' | 'redirect' | 'abort' = 'tools';
let redirectRequests = 0;
let redirectTargetRequests = 0;
let redirectTargetOrigin = '';
const testCredential = 'smoke-provider-secret-that-must-not-follow-redirect';
const credentialEnvName = 'PI_SMOKE_TEST_KEY';
const previousCredential = process.env[credentialEnvName];
let requestCount = 0;
let screenshotRequests = 0;
let judgeRequests = 0;
const parallelRequests: { response: ServerResponse; model: string }[] = [];
let actualCandidates: NodeResult[] = [];
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
    assert.ok(mode === 'parallel' ? /^smoke-coder-[abc]$/.test(body.model) : body.model === 'smoke-coder');
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), mode === 'screenshot' ? ['capture_ui', 'list_staff'] : [...expectedTools].sort());
    if (mode === 'redirect') {
      redirectRequests++;
      assert.equal(request.headers.authorization, 'Bearer ' + testCredential);
      response.writeHead(307, { Location: redirectTargetOrigin + '/credential-sink' });
      response.end();
      return;
    }
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
    if (mode === 'parallel' || mode === 'judge') {
      const promptText = body.messages.filter((message: any) => message.role === 'user').map((message: any) => typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')).join('\n');
      const serialized = promptText.match(/same upstream snapshot:\n(\[[^\n]+\])/);
      assert.ok(serialized, 'Direct predecessor results must be separately labeled in the prompt.');
      const directResults = JSON.parse(serialized[1]);
      if (mode === 'parallel') {
        assert.equal(directResults.length, 1);
        assert.equal(directResults[0].nodeId, 'reviewer');
        assert.equal(directResults[0].output, 'SMOKE_SHARED_PROBLEM: investigate empty-list boundary safely.');
        assert.doesNotMatch(JSON.stringify(directResults), /SMOKE_CANDIDATE_ANSWER/);
        parallelRequests.push({ response, model: body.model });
        if (parallelRequests.length === 3) {
          const runtimeFolders = await readdir(path.join(statePath, 'pi'));
          assert.equal(runtimeFolders.length, 3, 'All overlapping sessions must own distinct runtime directories.');
          const catalogs = await Promise.all(runtimeFolders.map(async folder => JSON.parse(await readFile(path.join(statePath, 'pi', folder, 'models.json'), 'utf8'))));
          const modelIds = catalogs.flatMap(catalog => Object.values(catalog.providers).flatMap((provider: any) => provider.models.map((model: any) => model.id)));
          assert.deepEqual(modelIds.sort(), ['smoke-coder-a', 'smoke-coder-b', 'smoke-coder-c']);
          // Holding replies until all requests arrive proves actual simultaneous SDK sessions.
          for (const candidate of parallelRequests) {
            event(candidate.response, { content: JSON.stringify({ output: `SMOKE_CANDIDATE_ANSWER from ${candidate.model}: ${candidate.model.endsWith('-b') ? 'Use an explicit empty-list guard and verify boundary behavior.' : 'Investigate indexing assumptions.'}`, findings: [], messages: [], assignments: [] }) });
            finish(candidate.response, 'stop');
          }
        }
        return;
      }
      const serializedBriefs = promptText.match(/original problem and requirements, application data only:\n(\[[^\n]+\])/);
      assert.ok(serializedBriefs, 'Judge must receive a separate original problem section.');
      const sharedBriefs = JSON.parse(serializedBriefs[1]);
      assert.equal(sharedBriefs.length, 1);
      assert.equal(sharedBriefs[0].output, 'SMOKE_SHARED_PROBLEM: investigate empty-list boundary safely.');
      judgeRequests++;
      assert.match(promptText, /SMOKE_JUDGE_RUBRIC/);
      assert.deepEqual(directResults, actualCandidates, 'The judge must receive the actual final output from each parallel candidate.');
      assert.equal(new Set(directResults.map((candidate: any) => candidate.modelId)).size, 3);
      assert.ok(directResults.every((candidate: any) => candidate.output.includes(`SMOKE_CANDIDATE_ANSWER from smoke-coder-${candidate.nodeId.at(-1)}`)));
      event(response, { content: JSON.stringify({ output: 'Candidate B gives the strongest supported solution: an explicit empty-list guard and boundary verification.', findings: [], messages: [], assignments: [], judgment: { winnerNodeId: 'candidate-b', reasoning: 'B provides the most complete response to the shared problem.', scores: directResults.map((candidate: any) => ({ nodeId: candidate.nodeId, score: candidate.nodeId === 'candidate-b' ? 95 : 60, reasoning: candidate.nodeId === 'candidate-b' ? 'Explicit guard and boundary verification.' : 'Investigation only; no complete solution.' })) } }) });
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
    event(response, { content: JSON.stringify({ output: 'SMOKE_SHARED_PROBLEM: investigate empty-list boundary safely.', findings: [{ title: 'Missing empty-list handling', description: 'app.ts line 1 reads items[0].price without verifying that an item exists.', severity: 'medium', file: 'app.ts', line: 1 }], messages: [{ to: 'all', text: 'Reviewed the source evidence.' }], assignments: [] }) });
    finish(response, 'stop');
  } catch (error) {
    requestFailure = error;
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

const originalFetch = globalThis.fetch;
const redirectTarget = createServer((_request, response) => {
  redirectTargetRequests++;
  response.writeHead(500);
  response.end('A redirected provider request must never reach this server.');
});
let fetchCount = 0;
try {
  await new Promise<void>(resolve => redirectTarget.listen(0, '127.0.0.1', resolve));
  const redirectAddress = redirectTarget.address();
  assert.ok(redirectAddress && typeof redirectAddress !== 'string');
  redirectTargetOrigin = 'http://127.0.0.1:' + redirectAddress.port;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const observedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, origin, `External request blocked by smoke harness: ${url.origin}`);
    assert.equal(init?.redirect, 'error', 'The session transport must disable redirects for every model request.');
    fetchCount++;
    return originalFetch(input, init);
  };

  const node: ExecutionContext['node'] = { id: 'reviewer', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Smoke reviewer', role: 'reviewer', description: 'Deterministic integration reviewer', persona: 'You review source evidence.', prompt: 'Review app.ts and return a JSON report.', responsibilities: ['Boundary review'], modelId: 'smoke', color: '#00a99d', tools: ['read'], status: 'idle' } };
  const context: ExecutionContext = {
    workflow: { id: 'smoke', name: 'Pi smoke', description: 'Local adapter test', nodes: [node], edges: [], settings: { mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: node.id, projectPath, previewUrl: '', executionMode: 'pi' } },
    models: [{ id: 'smoke', name: 'Local deterministic stub', provider: 'custom', modelId: 'smoke-coder', kind: 'local', baseUrl: `${origin}/v1`, apiKeyEnv: '', enabled: true, contextWindow: 32768, supportsImages: false }],
    node, run: { id: 'smoke', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 }, cycle: 1, messages: [], findings: [], upstreamResults: [], signal: new AbortController().signal,
  };
  const executor = createPiExecutor(statePath, { fetch: observedFetch });
  console.log('Starting actual Pi adapter with the local stub.');
  const report = await executor(context);
  if (requestFailure) throw requestFailure;
  assert.equal(requestCount, 2);
  assert.equal(report.findings?.[0]?.file, 'app.ts');
  assert.equal(report.findings?.[0]?.line, 1);
  assert.equal(report.findings?.[0]?.title, 'Missing empty-list handling');
  assert.equal(report.messages?.[0]?.to, 'all');
  assert.deepEqual(report.assignments, []);

  assert.equal(report.output, 'SMOKE_SHARED_PROBLEM: investigate empty-list boundary safely.');
  mode = 'parallel';
  console.log('Starting three actual Pi sessions simultaneously with the same source output.');
  const candidateModels = ['a', 'b', 'c'].map(letter => ({ ...context.models[0], id: `candidate-model-${letter}`, modelId: `smoke-coder-${letter}` }));
  const candidateNodes = candidateModels.map((model, index) => ({ ...node, id: `candidate-${['a', 'b', 'c'][index]}`, data: { ...node.data, label: `Candidate ${index + 1}`, modelId: model.id } }));
  const judgeNode = { ...node, id: 'judge', data: { ...node.data, label: 'Smoke judge', role: 'judge' as const, judgeRubric: 'SMOKE_JUDGE_RUBRIC: prefer correct complete boundary solutions.' } };
  const comparisonWorkflow = { ...context.workflow, nodes: [node, ...candidateNodes, judgeNode], edges: candidateNodes.flatMap(candidate => [{ id: `source-${candidate.id}`, source: node.id, target: candidate.id }, { id: `${candidate.id}-judge`, source: candidate.id, target: judgeNode.id }]) };
  const sourceResult: NodeResult = { nodeId: node.id, nodeName: node.data.label, modelId: node.data.modelId, cycle: 1, output: report.output!, findings: report.findings ?? [], completedAt: new Date().toISOString() };
  const parallelReports = await Promise.race([
    Promise.all(candidateNodes.map(candidate => executor({ ...context, workflow: comparisonWorkflow, node: candidate, models: [...context.models, ...candidateModels], upstreamResults: [structuredClone(sourceResult)] }))),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Three concurrent Pi requests did not complete in twenty seconds.')), 20_000).unref()),
  ]);
  if (requestFailure) throw requestFailure;
  assert.equal(parallelRequests.length, 3);
  actualCandidates = candidateNodes.map((candidate, index) => ({ nodeId: candidate.id, nodeName: candidate.data.label, modelId: candidate.data.modelId, cycle: 1, output: parallelReports[index].output!, findings: parallelReports[index].findings ?? [], completedAt: new Date().toISOString() }));
  assert.deepEqual(await readdir(path.join(statePath, 'pi')), [], 'Completed Pi sessions must clean ephemeral runtime catalogs.');
  mode = 'judge';
  const judgeReport = await executor({ ...context, workflow: comparisonWorkflow, node: judgeNode, upstreamResults: actualCandidates, run: { ...context.run, results: [sourceResult, ...actualCandidates] } });
  if (requestFailure) throw requestFailure;
  assert.equal(judgeRequests, 1);
  assert.equal(judgeReport.judgment?.winnerNodeId, 'candidate-b');
  assert.equal(judgeReport.judgment?.scores.length, 3);
  assert.match(judgeReport.output ?? '', /empty-list guard/);
  console.log('PASS: three Pi model sessions overlapped with isolated model catalogs and identical source handoffs; judge received their actual final answers and returned a validated winner with all three scores.');
  let screenshotAvailable = true;
  try { const browser = await launchScreenshotBrowser(); await browser.close(); } catch { screenshotAvailable = false; }
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

  mode = 'redirect';
  process.env[credentialEnvName] = testCredential;
  const credentialModels = [{ ...context.models[0], apiKeyEnv: credentialEnvName }];
  await assert.rejects(() => executor({
    ...context, models: credentialModels,
    node: { ...node, data: { ...node.data, label: testCredential, tools: ['screenshot'] } },
  }), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('[redacted]'));
    assert.doesNotMatch(error.message, new RegExp(testCredential));
    assert.equal('credential' in error, false, 'Only a fresh sanitized error may escape SDK setup.');
    return true;
  });
  console.log('Starting credential-protected HTTP redirect probe.');
  await assert.rejects(() => executor({ ...context, models: credentialModels, run: { ...context.run, id: 'redirect-smoke' } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /request failed|connection|redirect|fetch/i);
    assert.doesNotMatch(error.message, new RegExp(testCredential));
    return true;
  });
  assert.ok(redirectRequests >= 1, 'The SDK must reach the approved model endpoint for the redirect test.');
  assert.equal(redirectTargetRequests, 0, 'Neither the request nor its credential may follow the cross-origin redirect.');
  assert.equal(globalThis.fetch, originalFetch, 'Per-session transports must never change process-global fetch.');
  console.log('PASS: actual Pi SDK rejects cross-origin HTTP307 redirects; target saw zero requests or credentials, and pre-session setup errors redact the provider key.');

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
  assert.equal(fetchCount, (screenshotAvailable ? 8 : 7) + redirectRequests, 'Only expected review, comparison, screenshot, blocked-redirect, and abort requests should reach the local provider.');
  console.log('PASS: installed Pi SDK → localhost SSE provider → confined source/staff tools → validated finding report; outside-project read blocked; active model stream aborted. All observed provider requests stayed local; only a test credential was used.');
} finally {
  if (previousCredential === undefined) delete process.env[credentialEnvName];
  else process.env[credentialEnvName] = previousCredential;
  for (const response of openResponses) response.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  redirectTarget.closeAllConnections();
  await new Promise<void>(resolve => redirectTarget.close(() => resolve()));
  const absoluteCleanup = path.resolve(temporaryRoot);
  assert.equal(path.dirname(absoluteCleanup), temporaryParent);
  assert.ok(path.basename(absoluteCleanup).startsWith('crawlspace-pi-smoke-'));
  await rm(absoluteCleanup, { recursive: true, force: true });
}

