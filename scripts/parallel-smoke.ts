/** Exercise simultaneous installed-Pi sessions using only two loopback model servers. */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from '../server/engine';
import { createPiExecutor, piAvailable } from '../server/pi';
import { StateStore } from '../server/store';
import { createRoutingExecutor } from '../server/routing';
import { defaultRoutingSettings } from '../shared/defaults';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, explanation: string, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(explanation)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function until(condition: () => boolean, explanation: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(explanation);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function event(response: ServerResponse, delta: object, finishReason: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'parallel-smoke', object: 'chat.completion.chunk', created: 1, model: 'parallel-coder', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finish(response: ServerResponse, reason: string) {
  event(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: 'parallel-smoke', object: 'chat.completion.chunk', created: 1, model: 'parallel-coder', choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function code(response: ServerResponse, id: string, source: string) {
  event(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: source }) } }] });
  finish(response, 'tool_calls');
}

console.log('Loading installed Pi SDK for concurrent-session verification.');
assert.ok(await piAvailable(), 'The installed Pi SDK is required.');
const temporaryParent = path.resolve(tmpdir());
const root = await mkdtemp(path.join(temporaryParent, 'crawlspace-parallel-smoke-'));
const projectPath = path.join(root, 'project');
const stateDirectory = path.join(root, 'state');
await mkdir(projectPath); await mkdir(stateDirectory);
await writeFile(path.join(projectPath, 'app.ts'), 'export const value = items[0].price; // PARALLEL_SOURCE_EVIDENCE\n');
const store = await StateStore.open(path.join(stateDirectory, 'state.json'));
let engine: WorkflowEngine | undefined;
let mode: 'complete' | 'cancel' = 'complete';
let requestCount = 0;
let decisionCount = 0;
let requestFailure: unknown;
const branchRequests = new Set<string>();
const firstBranches = deferred();
const releaseBranches = deferred();
const cancelBranches = deferred();
const openResponses = new Set<ServerResponse>();
const cancelledResponses = new Set<string>();

const servers = [0, 1].map(machine => createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, `parallel-machine-${machine}`);
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(), ['codemode', 'list_staff', 'project_find', 'project_grep', 'project_ls', 'project_read']);
    const assignment = body.messages.filter((message: any) => message.role === 'user').map((message: any) => typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text ?? '').join('\n')).join('\n');
    const marker = assignment.match(/Your assignment:\s*PARALLEL_(ENTRY|LEFT|RIGHT|JOIN)/)?.[1];
    assert.ok(marker, 'Each session must receive only its assigned node.');
    assert.equal(machine, marker === 'RIGHT' ? 1 : 0, 'Model catalogs must not leak between sessions.');
    requestCount++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.flushHeaders(); event(response, { role: 'assistant' });
    const toolMessages = body.messages.filter((message: any) => message.role === 'tool');
    if (toolMessages.length === 0) {
      if (marker === 'JOIN') {
        assert.match(assignment, /Verified branch LEFT/); assert.match(assignment, /Verified branch RIGHT/);
        assert.match(assignment, /LEFT_DONE/); assert.match(assignment, /RIGHT_DONE/);
      }
      if (marker === 'LEFT' || marker === 'RIGHT') {
        branchRequests.add(marker);
        if (mode === 'cancel') {
          openResponses.add(response);
          response.once('close', () => { openResponses.delete(response); cancelledResponses.add(marker); });
          if (branchRequests.size === 2) cancelBranches.resolve();
          return;
        }
        if (branchRequests.size === 2) firstBranches.resolve();
        await releaseBranches.promise;
      }
      code(response, `inspect_${marker}`, `
if (load('visit-marker') !== undefined) throw new Error('Store leaked from another visit');
store('visit-marker', '${marker}');
let sum = 0; for (let index = 0; index < 5; index++) sum += index;
const evidence = await Promise.all([tools.project_read({path:'app.ts',offset:1,limit:5}),tools.list_staff({})]);
text({marker:load('visit-marker'),sum,evidence});`);
    } else if (toolMessages.length === 1) {
      const output = JSON.stringify(toolMessages[0]);
      assert.equal(toolMessages[0].tool_call_id, `inspect_${marker}`);
      assert.match(output, /Script completed/); assert.match(output, /PARALLEL_SOURCE_EVIDENCE/);
      assert.match(output, new RegExp(`\\\\"marker\\\\":\\\\"${marker}\\\\"`));
      code(response, `remember_${marker}`, `if(load('visit-marker')!=='${marker}')throw new Error('Store crossed sessions');text('REMEMBERED_${marker}');`);
    } else {
      assert.equal(toolMessages.length, 2);
      assert.equal(toolMessages[1].tool_call_id, `remember_${marker}`);
      assert.match(JSON.stringify(toolMessages[1]), new RegExp(`REMEMBERED_${marker}`));
      event(response, { content: JSON.stringify({
        findings: marker === 'LEFT' || marker === 'RIGHT' ? [{ title: `Verified branch ${marker}`, description: `app.ts line 1 accesses items[0] without an empty-list guard, observed by ${marker}.`, severity: 'low', file: 'app.ts', line: 1 }] : [],
        messages: marker === 'LEFT' || marker === 'RIGHT' ? [{ to: 'join', text: `${marker}_DONE` }] : [], assignments: [],
      }) });
      finish(response, 'stop');
    }
  } catch (error) {
    requestFailure ??= error;
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end();
  }
}));
const decisionServer = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/systemone');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, 'decision-fixture');
    assert.equal(body.state.questionVersion, 'worker-route-v1');
    assert.deepEqual(Object.keys(body.questions.route.criteria).sort(), ['assigned', 'review', 'supervisor']);
    decisionCount++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'decision-fixture-1', answers: { route: { type: 'choice', choice: 'assigned', probabilities: { assigned: 0.99, supervisor: 0.005, review: 0.005 }, confidence: 0.98 } }, usage: { input_tokens: 40, output_tokens: 0 } }));
  } catch (error) { requestFailure ??= error; response.writeHead(500); response.end(); }
});
const services = [...servers, decisionServer];
const originalFetch = globalThis.fetch;
try {
  for (const server of services) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origins = services.map(server => `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.ok(origins.includes(url.origin), `External request denied by smoke fixture: ${url.origin}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  await store.update(state => {
    const template = state.workflow.nodes[0];
    state.models = origins.slice(0, 2).map((origin, index) => ({ id: `machine-${index}`, name: `Machine ${index}`, provider: 'custom', modelId: `parallel-machine-${index}`, kind: 'local', baseUrl: `${origin}/v1`, apiKeyEnv: '', enabled: true, contextWindow: 32768, supportsImages: false, maxConcurrentRequests: 1 }));
    state.workflow.nodes = ['entry', 'left', 'right', 'join'].map(id => ({ ...structuredClone(template), id, data: { ...structuredClone(template.data), label: id, modelId: id === 'right' ? 'machine-1' : 'machine-0', tools: ['read'], prompt: `PARALLEL_${id.toUpperCase()}: inspect app.ts and share verified evidence.` } }));
    state.workflow.edges = [ ['entry','left'], ['entry','right'], ['left','join'], ['right','join'] ].map(([source,target]) => ({ id: `${source}-${target}`, source, target }));
    state.workflow.settings = { ...state.workflow.settings, mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: 'entry', projectPath, previewUrl: '', executionMode: 'pi', codeMode: true, maxParallelAgents: 2, supervisorModelId: undefined,
      routing: { ...defaultRoutingSettings, mode: 'active', baseUrl: `${origins[2]}/v1`, modelId: 'decision-fixture', apiKeyEnv: '' },
    };
    state.runs = []; state.findings = []; state.messages = [];
  });
  engine = new WorkflowEngine(store, { piExecutor: createPiExecutor(stateDirectory), routingExecutor: createRoutingExecutor() });
  await engine.start('pi');
  await bounded(firstBranches.promise, 'Both machines must receive simultaneous branch requests.');
  assert.deepEqual(store.get().runs[0].activeNodeIds?.sort(), ['left', 'right']);
  const runtime = path.join(stateDirectory, 'pi', 'visits');
  const activeDirectories = await readdir(runtime);
  assert.equal(activeDirectories.length, 2, 'Each active Pi session must have its own runtime directory.');
  assert.equal(new Set(activeDirectories).size, 2);
  releaseBranches.resolve();
  await bounded(engine.waitForIdle(), 'The concurrent workflow must complete.');
  if (requestFailure) throw requestFailure;
  assert.equal(store.get().runs[0].status, 'completed', store.get().runs[0].error);
  assert.equal(store.get().runs[0].steps, 4); assert.equal(store.get().findings.length, 2);
  assert.equal(decisionCount, 4); assert.equal(store.get().runs[0].decisionCount, 4);
  assert.ok(store.get().runs[0].decisions?.every(decision => decision.status === 'completed' && decision.modelId === 'decision-fixture-1' && decision.recommendation === 'assigned'));
  assert.equal(requestCount, 12); assert.deepEqual(await readdir(runtime), []);
  console.log('PASS: a self-hosted native decision endpoint routes four actual Pi visits; concurrent Code Mode stores stay isolated; the join receives both durable reports; runtime files are removed.');

  mode = 'cancel'; branchRequests.clear();
  await engine.start('pi');
  await bounded(cancelBranches.promise, 'Both machines must be active before Stop.');
  const stoppedAt = Date.now();
  await bounded(engine.stop(), 'Stop must abort and drain both Pi sessions within five seconds.', 5000);
  await engine.waitForIdle();
  await until(() => cancelledResponses.size === 2, 'Both loopback model streams must close after Stop.');
  if (requestFailure) throw requestFailure;
  assert.ok(Date.now() - stoppedAt < 5000);
  assert.equal(store.get().runs[0].status, 'stopped'); assert.equal(store.get().runs[0].steps, 1);
  assert.equal(store.get().runs[0].activeNodeIds, undefined); assert.equal(store.get().runs[0].activeNodeId, undefined);
  assert.equal(store.get().findings.length, 2, 'Cancelled branches cannot publish findings.');
  assert.equal(requestCount, 17); assert.deepEqual(await readdir(runtime), []);
  assert.equal(decisionCount, 7); assert.equal(store.get().runs[0].decisionCount, 3);
  console.log('PASS: Stop closes both actual model streams, drains SDK sessions, clears activity and runtime files, and publishes no cancelled branch report.');
} finally {
  releaseBranches.resolve();
  for (const response of openResponses) response.destroy();
  await engine?.stop(); await engine?.waitForIdle(); await store.flush();
  globalThis.fetch = originalFetch;
  for (const server of services) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const checked = path.resolve(root);
  assert.equal(path.dirname(checked), temporaryParent);
  assert.ok(path.basename(checked).startsWith('crawlspace-parallel-smoke-'));
  await rm(checked, { recursive: true, force: true });
}
