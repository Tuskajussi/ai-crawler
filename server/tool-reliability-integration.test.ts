import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ReliabilitySnapshot } from '../shared/reliability';
import type { ExecutionContext } from './engine';
import { createApp } from './index';
import { createPiExecutor } from './pi';
import { ReliabilityStore } from './reliability';

const privateSource = 'PRIVATE_PROJECT_RESULT_MUST_NOT_ENTER_RELIABILITY';
const privateArgument = 'PRIVATE_TOOL_ARGUMENT_MUST_NOT_ENTER_RELIABILITY';
const privateTool = 'PRIVATE_INVENTED_TOOL_MUST_NOT_ENTER_RELIABILITY';
const privateReport = 'PRIVATE_BAD_REPORT_MUST_NOT_ENTER_RELIABILITY';
const privateProvider = 'PRIVATE_PROVIDER_ERROR_MUST_NOT_ENTER_RELIABILITY';
const privateCode = 'PRIVATE_CODE_ERROR_MUST_NOT_ENTER_RELIABILITY';
const emptyReport = JSON.stringify({ findings: [], messages: [], assignments: [] });

function chunk(response: ServerResponse, delta: object, finishReason: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: 'reliability-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-coder', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finish(response: ServerResponse, reason: 'stop' | 'tool_calls') {
  chunk(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: 'reliability-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-coder', choices: [], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function completion(response: ServerResponse, text = emptyReport) {
  chunk(response, { content: text });
  finish(response, 'stop');
}

function toolCalls(response: ServerResponse, calls: { id: string; name: string; args: unknown }[]) {
  chunk(response, { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
  finish(response, 'tool_calls');
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

type ModelRequest = { messages: { role: string; tool_call_id?: string; content: unknown }[]; tools: { function: { name: string } }[] };

/** Exercise the installed Pi runtime against a loopback model; no model service is required. */
async function fixture(t: TestContext, respond: (request: ModelRequest, response: ServerResponse, count: number) => void | Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-tool-reliability-'));
  const projectPath = path.join(directory, 'project');
  const reliabilityPath = path.join(directory, 'reliability.json');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'app.ts'), `export const value = '${privateSource}';\n`);
  await writeFile(path.join(directory, 'outside.ts'), 'PRIVATE_OUTSIDE_SOURCE');
  let requests = 0;
  const errors: unknown[] = [];
  const beforeCleanup: (() => Promise<void>)[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      assert.equal(body.stream, true);
      assert.equal(body.model, 'fixture-coder');
      await respond(body, response, ++requests);
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Local fixture assertion failed' } }));
    }
  });
  const origin = await listen(server);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, '127.0.0.1', 'Reliability integration tests must never contact an external provider.');
    return originalFetch(input, init);
  };
  const reliability = await ReliabilityStore.open(reliabilityPath);
  const node: ExecutionContext['node'] = {
    id: 'reviewer', type: 'agent', position: { x: 0, y: 0 },
    data: { label: 'Fixture reviewer', role: 'reviewer', description: 'Deterministic model fixture', persona: 'Review source evidence.', prompt: 'Inspect app.ts and return the required JSON report.', responsibilities: ['Source review'], modelId: 'fixture', color: '#00a99d', tools: ['read'], status: 'idle' },
  };
  const context: ExecutionContext = {
    workflow: { id: 'fixture', name: 'Reliability fixture', description: 'Local tool integration', nodes: [node], edges: [], settings: { mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: node.id, projectPath, previewUrl: '', executionMode: 'pi', codeMode: false } },
    models: [{ id: 'fixture', name: 'Fixture model', provider: 'custom', modelId: 'fixture-coder', kind: 'local', baseUrl: `${origin}/v1`, apiKeyEnv: '', enabled: true, contextWindow: 32768, maxOutputTokens: 1024, timeoutSeconds: 30, supportsImages: false }],
    node, run: { id: 'fixture-run', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 }, cycle: 1, messages: [], findings: [], upstreamResults: [], signal: new AbortController().signal,
  };
  t.after(async () => {
    for (const cleanup of beforeCleanup) await cleanup();
    globalThis.fetch = originalFetch;
    await close(server);
    await reliability.flush();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('crawlspace-tool-reliability-'));
    await rm(resolved, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'Every model request must satisfy the deterministic fixture.');
  });
  return { directory, reliabilityPath, reliability, context, beforeCleanup };
}

function stream(response: ServerResponse) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.flushHeaders();
  chunk(response, { role: 'assistant' });
}

function assertPrivateContentExcluded(serialized: string, projectPath: string) {
  for (const privateValue of [privateSource, privateArgument, privateTool, privateReport, privateProvider, privateCode, 'PRIVATE_OUTSIDE_SOURCE', projectPath, JSON.stringify(projectPath).slice(1, -1)]) {
    assert.ok(!serialized.includes(privateValue), `Reliability records must exclude private execution content: ${privateValue}`);
  }
  assert.doesNotMatch(serialized, /"(?:arguments|args|result|content|toolCallId|parentToolCallId)"\s*:/);
}

test('actual Pi separates invalid arguments and unknown tools from implementation errors, persists only safe outcomes', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (body, response, count) => {
    stream(response);
    if (count === 1) {
      toolCalls(response, [
        { id: 'read-call-private-id', name: 'project_read', args: { path: 'app.ts' } },
        { id: 'invalid-private-id', name: 'project_read', args: { private: privateArgument } },
        { id: 'unknown-private-id', name: privateTool, args: { private: privateArgument } },
        { id: 'boundary-private-id', name: 'project_read', args: { path: '../outside.ts' } },
      ]);
    } else {
      assert.equal(count, 2);
      assert.match(JSON.stringify(body.messages.find(message => message.tool_call_id === 'read-call-private-id')), new RegExp(privateSource));
      assert.match(JSON.stringify(body.messages.find(message => message.tool_call_id === 'boundary-private-id')), /outside the selected project folder is blocked/i);
      completion(response);
    }
  });
  await createPiExecutor(current.directory, { reliability: current.reliability })(current.context);
  const snapshot = current.reliability.snapshot();
  const model = snapshot.models[0];
  assert.equal(model.visits, 1);
  assert.equal(model.statuses.success, 1, 'A repaired tool interaction can still produce a valid final report.');
  assert.equal(model.tools.total, 4);
  assert.equal(model.tools.outcomes.success, 1);
  assert.equal(model.tools.outcomes.invalid_arguments, 1);
  assert.equal(model.tools.outcomes.unknown_tool, 1);
  assert.equal(model.tools.outcomes.execution_error, 1);
  assert.equal(model.tools.successRate, 0.25);
  assert.equal(model.codeModeCalls.total, 0);
  assert.equal(model.byTool['[unknown tool]']?.total, 1);
  assert.equal(model.modelFailures, 0, 'An executed tool throwing must not be labelled a provider failure.');
  assert.equal(model.providerFailures, 0);
  await current.reliability.flush();
  const persisted = await readFile(current.reliabilityPath, 'utf8');
  assertPrivateContentExcluded(persisted, current.context.workflow.settings.projectPath);
  assert.doesNotMatch(persisted, /read-call-private-id|invalid-private-id|unknown-private-id|boundary-private-id/);
  const reopened = await ReliabilityStore.open(current.reliabilityPath);
  assert.deepEqual(reopened.snapshot().models, snapshot.models, 'Tool reliability survives restarting the local app.');
});

test('actual CodeMode records nested validations and executions separately from its successful wrapper', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (body, response, count) => {
    stream(response);
    if (count === 1) {
      assert.ok(body.tools.some(tool => tool.function.name === 'codemode'));
      toolCalls(response, [{ id: 'code-private-id', name: 'codemode', args: { code: `const results = await Promise.allSettled([tools.project_read({path:'app.ts'}),tools.project_read({private:'${privateArgument}'}),tools.project_read({path:'../outside.ts'})]); text(results.map(result => result.status));` } }]);
    } else {
      assert.equal(count, 2);
      assert.match(JSON.stringify(body.messages), /fulfilled|rejected/);
      completion(response);
    }
  });
  current.context.workflow.settings.codeMode = true;
  await createPiExecutor(current.directory, { reliability: current.reliability })(current.context);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.tools.total, 3, 'The wrapper must not inflate the ordinary tool success rate.');
  assert.equal(model.tools.outcomes.success, 1);
  assert.equal(model.tools.outcomes.invalid_arguments, 1);
  assert.equal(model.tools.outcomes.execution_error, 1);
  assert.equal(model.codeModeCalls.total, 1);
  assert.equal(model.codeModeCalls.outcomes.success, 1);
  assert.equal(model.tools.successRate, 1 / 3);
  assertPrivateContentExcluded(JSON.stringify(current.reliability.snapshot()), current.context.workflow.settings.projectPath);
});

test('actual Pi preserves retry and report-repair history without marking the recovered visit failed', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (body, response, count) => {
    if (count === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      response.end(JSON.stringify({ error: { message: privateProvider } }));
      return;
    }
    stream(response);
    if (count === 2) completion(response, privateReport);
    else {
      assert.equal(count, 3);
      assert.match(JSON.stringify(body.messages), /Correct it once/);
      completion(response);
    }
  });
  const report = await createPiExecutor(current.directory, { reliability: current.reliability })(current.context);
  assert.equal(report.execution?.attempts, 2);
  assert.equal(report.execution?.requests, 3);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.visits, 1, 'Retries belong to one visit instead of inflating model sample counts.');
  assert.equal(model.statuses.success, 1);
  assert.equal(model.modelFailures, 0);
  assert.equal(model.retryAttempts, 1);
  assert.equal(model.requests, 3);
  assert.equal(model.providerFailures, 1);
  assert.equal(model.reportRejections, 1);
  assert.equal(model.reportRepairs, 1);
  assert.equal(model.tools.total, 0);
  assert.equal(model.tools.successRate, null);
  assertPrivateContentExcluded(JSON.stringify(current.reliability.snapshot()), current.context.workflow.settings.projectPath);
});

test('a provider retry after successful tools retains both attempts in one model visit', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (_body, response, count) => {
    if (count === 2) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      response.end(JSON.stringify({ error: { message: privateProvider } }));
      return;
    }
    stream(response);
    if (count === 1 || count === 3) toolCalls(response, [{ id: 'reused-after-provider-retry', name: 'project_read', args: { path: 'app.ts' } }]);
    else {
      assert.equal(count, 4);
      completion(response);
    }
  });
  const report = await createPiExecutor(current.directory, { reliability: current.reliability })(current.context);
  assert.equal(report.execution?.attempts, 2);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.visits, 1);
  assert.equal(model.statuses.success, 1);
  assert.equal(model.requests, 4);
  assert.equal(model.retryAttempts, 1);
  assert.equal(model.providerFailures, 1);
  assert.equal(model.tools.total, 2);
  assert.equal(model.tools.outcomes.success, 2);
  assert.equal(model.tools.successRate, 1);
  assertPrivateContentExcluded(JSON.stringify(current.reliability.snapshot()), current.context.workflow.settings.projectPath);
});

test('an unhandled CodeMode script error is attributed to its wrapper while a later report can succeed', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (body, response, count) => {
    stream(response);
    if (count === 1) toolCalls(response, [{ id: 'code-error-private-id', name: 'codemode', args: { code: `throw new Error('${privateCode}');` } }]);
    else {
      assert.equal(count, 2);
      assert.match(JSON.stringify(body.messages), new RegExp(privateCode));
      completion(response);
    }
  });
  current.context.workflow.settings.codeMode = true;
  await createPiExecutor(current.directory, { reliability: current.reliability })(current.context);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.statuses.success, 1);
  assert.equal(model.modelFailures, 0);
  assert.equal(model.providerFailures, 0);
  assert.equal(model.tools.total, 0);
  assert.equal(model.tools.successRate, null);
  assert.equal(model.codeModeCalls.total, 1);
  assert.equal(model.codeModeCalls.outcomes.code_error, 1);
  assert.equal(model.codeModeCalls.successRate, 0);
  assertPrivateContentExcluded(JSON.stringify(current.reliability.snapshot()), current.context.workflow.settings.projectPath);
});

test('the shared tool-call budget records policy blocks without making CodeMode look like malformed model code', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (_body, response, count) => {
    assert.equal(count, 1, 'Exhausting the tool budget must not trigger another model request.');
    stream(response);
    toolCalls(response, [{ id: 'code-budget-private-id', name: 'codemode', args: { code: "for (let index = 0; index < 50; index++) await tools.project_ls({path:''});" } }]);
  });
  current.context.workflow.settings.codeMode = true;
  await assert.rejects(createPiExecutor(current.directory, { reliability: current.reliability })(current.context), /40-tool-call limit/);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.statuses.failed, 1);
  assert.equal(model.failures.report, 1);
  assert.equal(model.tools.outcomes.success, 39, 'The wrapper consumes one of the forty permitted calls.');
  assert.equal(model.tools.outcomes.blocked, 1);
  assert.equal(model.tools.successRate, 1, 'Policy blocks must not lower the completed-tool success rate.');
  assert.equal(model.codeModeCalls.total, 1);
  assert.equal(model.codeModeCalls.outcomes.blocked, 1);
  assert.equal(model.codeModeCalls.outcomes.code_error, 0);
  assert.equal(model.codeModeCalls.successRate, null);
  assert.equal(model.providerFailures, 0, 'Aborting a session for its tool budget is an adapter policy block, not a provider failure.');
});

test('stopping a real streaming model visit records cancellation without counting it as a model/tool failure', { timeout: 60_000 }, async t => {
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const current = await fixture(t, (_body, response, count) => {
    assert.equal(count, 1);
    stream(response);
    started();
  });
  const controller = new AbortController();
  current.context.signal = controller.signal;
  const executing = createPiExecutor(current.directory, { reliability: current.reliability })(current.context);
  await requestStarted;
  controller.abort();
  await assert.rejects(executing, { name: 'AbortError' });
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.visits, 1);
  assert.equal(model.statuses.cancelled, 1);
  assert.equal(model.modelFailures, 0);
  assert.equal(model.providerFailures, 0);
  assert.equal(model.tools.total, 0);
  assert.equal(model.tools.successRate, null);
});

test('two rejected final reports record one bounded repair and one failed visit without fabricated tool results', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (_body, response, count) => {
    assert.ok(count <= 2, 'Final report repair is bounded to one extra request.');
    stream(response);
    completion(response, privateReport);
  });
  await assert.rejects(createPiExecutor(current.directory, { reliability: current.reliability })(current.context), /remained invalid after one repair/);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.visits, 1);
  assert.equal(model.statuses.failed, 1);
  assert.equal(model.failures.report, 1);
  assert.equal(model.modelFailures, 1);
  assert.equal(model.reportRejections, 2);
  assert.equal(model.reportRepairs, 1);
  assert.equal(model.requests, 2);
  assert.equal(model.retryAttempts, 0);
  assert.equal(model.providerFailures, 0);
  assert.equal(model.tools.total, 0);
  assert.equal(model.tools.successRate, null);
  assertPrivateContentExcluded(JSON.stringify(current.reliability.snapshot()), current.context.workflow.settings.projectPath);
});

test('a real streaming visit exceeding its configured deadline records a timeout, not a cancelled tool', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (_body, response, count) => {
    assert.equal(count, 1);
    stream(response);
  });
  current.context.models[0].timeoutSeconds = 15;
  await assert.rejects(createPiExecutor(current.directory, { reliability: current.reliability })(current.context), /15-second limit/);
  const model = current.reliability.snapshot().models[0];
  assert.equal(model.statuses.failed, 1);
  assert.equal(model.statuses.cancelled, 0);
  assert.equal(model.failures.timeout, 1);
  assert.equal(model.modelFailures, 1);
  assert.equal(model.providerFailures, 0, 'The adapter deadline must not be counted as a separate provider error.');
  assert.equal(model.tools.total, 0);
  assert.equal(model.tools.successRate, null);
});

test('API reliability survives app restart and keeps configurations separate, including reused provider call IDs', { timeout: 60_000 }, async t => {
  const current = await fixture(t, (_body, response, count) => {
    stream(response);
    if (count % 3 !== 0) toolCalls(response, [{ id: 'reused-provider-call-id', name: 'project_read', args: { path: 'app.ts' } }]);
    else completion(response);
  });
  const dataDir = path.join(current.directory, 'api-accounts');
  const registrationSecret = 'fixture-registration-secret-with-at-least-32-characters';
  const options = { dataDir, registrationSecret, config: { modelEndpointOrigins: [new URL(current.context.models[0].baseUrl).origin] } };
  let application = await createApp(options);
  let http = createServer(application.app);
  let origin = await listen(http);
  current.beforeCleanup.push(async () => { await application.shutdown(); await close(http); });
  let cookie = '';
  let csrfToken = '';
  const request = async (endpoint: string, method = 'GET', body?: unknown) => fetch(`${origin}/api${endpoint}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const registered = await request('/auth/register', 'POST', { username: 'reliability-user', password: 'fixture sufficiently long account password', registrationSecret });
  assert.equal(registered.status, 201);
  cookie = registered.headers.get('set-cookie')!.split(';')[0];
  const session = await registered.json() as { user: { id: string }; csrfToken: string };
  csrfToken = session.csrfToken;
  let workspace = await application.workspaces.get(session.user.id);
  const projectPath = path.join(workspace.projectsRoot, 'fixture');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'app.ts'), await readFile(path.join(current.context.workflow.settings.projectPath, 'app.ts')));
  const apiSnapshot = async (): Promise<ReliabilitySnapshot> => {
    const response = await request('/reliability');
    assert.equal(response.status, 200);
    return response.json();
  };
  await workspace.store.update(state => {
    state.workflow = structuredClone(current.context.workflow);
    state.workflow.settings.projectPath = projectPath;
    state.models = structuredClone(current.context.models);
    state.messages = []; state.findings = []; state.runs = [];
  });
  assert.equal((await request('/runs', 'POST', { mode: 'pi' })).status, 202);
  await workspace.engine.waitForIdle();
  assert.equal(workspace.store.get().runs[0].status, 'completed', workspace.store.get().runs[0].error);
  let snapshot = await apiSnapshot();
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].tools.total, 2, 'A provider may reuse call IDs in later assistant messages.');
  assertPrivateContentExcluded(JSON.stringify(snapshot), projectPath);
  await application.shutdown();
  await close(http);
  application = await createApp(options);
  http = createServer(application.app);
  origin = await listen(http);
  workspace = await application.workspaces.get(session.user.id);
  assert.deepEqual((await apiSnapshot()).models, snapshot.models, 'The real authenticated session and private history survive restart.');
  await workspace.store.update(state => { state.models[0].reasoningEffort = 'low'; });
  assert.equal((await request('/runs', 'POST', { mode: 'pi' })).status, 202);
  await workspace.engine.waitForIdle();
  snapshot = await apiSnapshot();
  assert.equal(snapshot.models.length, 2, 'Changing model execution settings starts a distinct comparison group.');
  assert.deepEqual(snapshot.models.map(model => model.visits), [1, 1]);
  assert.deepEqual(snapshot.models.map(model => model.tools.total), [2, 2]);
  assert.equal(new Set(snapshot.models.map(model => model.model.fingerprint)).size, 2);
  assertPrivateContentExcluded(JSON.stringify(snapshot), projectPath);
});
