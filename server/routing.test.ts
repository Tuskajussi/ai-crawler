import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoutingSettings, initialState } from '../shared/defaults';
import type { RoutingAnswer, RoutingSettings } from '../shared/types';
import type { ExecutionContext } from './engine';
import { createRoutingExecutor, ROUTING_QUESTION_VERSION, routingModel, validateRoutingAnswer } from './routing';
import { requestSize } from './request-budget';

function context(settings: Partial<RoutingSettings> = {}, signal = new AbortController().signal): ExecutionContext {
  const state = structuredClone(initialState);
  state.workflow.settings.routing = { ...defaultRoutingSettings, mode: 'shadow', timeoutSeconds: 5, ...settings };
  state.workflow.settings.projectPath = 'C:\\private\\project';
  state.workflow.settings.supervisorModelId = 'claude';
  state.workflow.nodes[0].data.modelId = 'qwen';
  return { ...state, node: state.workflow.nodes[0], cycle: 1, signal, upstreamResults: [],
    run: { id: 'routing-run', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 } };
}

function nativeBody(answer: Record<string, unknown> = {}) {
  return { model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: 'assigned',
    probabilities: { assigned: 0.9, supervisor: 0.08, review: 0.02 }, confidence: 0.85, ...answer } },
  usage: { input_tokens: 42, output_tokens: 4 } };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const mockFetch = (operation: (request: Request) => Response | Promise<Response>): typeof fetch => async (input, init) => operation(new Request(input, init));
const environment = { TYPESAFE_API_KEY: 'routing-secret', ANTHROPIC_API_KEY: 'supervisor-secret' };
const validAnswer: RoutingAnswer = { choice: 'assigned', probabilities: { assigned: 0.9, supervisor: 0.08, review: 0.02 },
  confidence: 0.85, modelId: 'jev-1.13.0', durationMs: 1, inputTokens: 42 };

test('native SDK sends the closed routing rubric and captures the resolved model version', async () => {
  const current = context({ modelId: 'jev-latest' });
  let requests = 0;
  const execute = createRoutingExecutor({ environment, fetch: mockFetch(async request => {
    requests++;
    assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.get('authorization'), 'Bearer routing-secret');
    const body = await request.json();
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.state.questionVersion, ROUTING_QUESTION_VERSION);
    assert.equal(body.state.assigned.modelId, 'qwen3:8b');
    assert.equal(body.state.supervisor.modelId, 'claude-sonnet-4-5');
    assert.deepEqual(Object.keys(body.questions), ['route']);
    assert.deepEqual(Object.keys(body.questions.route.criteria), ['assigned', 'supervisor', 'review']);
    assert.match(body.questions.route.instructions, /read-only/);
    return json(nativeBody());
  }) });
  const result = await execute(current);
  assert.equal(requests, 1);
  assert.equal(result.modelId, 'jev-1.13.0');
  assert.equal(result.choice, 'assigned');
  assert.equal(result.confidence, 0.85);
  assert.equal(result.inputTokens, 42);
  assert.ok(result.durationMs >= 0);
});

test('self-hosted native decision models need no hosted account and share configured endpoint capacity', async () => {
  const current = context({ baseUrl: 'http://192.168.1.2:8080/v1/', modelId: 'local-decision', apiKeyEnv: '', maxConcurrentRequests: 2 });
  const execute = createRoutingExecutor({ environment: {}, fetch: mockFetch(request => {
    assert.equal(request.url, 'http://192.168.1.2:8080/v1/systemone');
    assert.equal(request.headers.get('authorization'), 'Bearer crawlspace-local');
    return json({ ...nativeBody(), model: 'local-decision-v2' });
  }) });
  assert.equal((await execute(current)).modelId, 'local-decision-v2');
  const model = routingModel(current.workflow.settings.routing!);
  assert.equal(model.baseUrl, current.workflow.settings.routing!.baseUrl);
  assert.equal(model.maxConcurrentRequests, 2);
  assert.equal(model.kind, 'local');
  assert.equal(model.supportsImages, false);
  assert.equal(routingModel(defaultRoutingSettings).kind, 'cloud');
});

test('missing credentials and already cancelled routing fail before issuing a request', async () => {
  let requests = 0;
  const execute = createRoutingExecutor({ environment: {}, fetch: mockFetch(() => { requests++; return json(nativeBody()); }) });
  await assert.rejects(execute(context()), /TYPESAFE_API_KEY/);
  await assert.rejects(execute(context({ apiKeyEnv: '' })), /TypeSafe API key/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(execute(context({}, controller.signal)), { name: 'AbortError' });
  assert.equal(requests, 0);
});

test('routing answer validation rejects malformed, non-normalized and non-maximal choices', () => {
  validateRoutingAnswer(validAnswer);
  // Native confidence is independent metadata, not required to equal a probability formula.
  validateRoutingAnswer({ ...validAnswer, confidence: 0.17 });
  validateRoutingAnswer({ ...validAnswer, probabilities: { assigned: 0.90005, supervisor: 0.08, review: 0.02 } });
  const invalid: unknown[] = [null, [], { ...validAnswer, choice: 'other' }, { ...validAnswer, confidence: NaN },
    { ...validAnswer, confidence: 1.01 }, { ...validAnswer, modelId: '' }, { ...validAnswer, modelId: 'a'.repeat(301) },
    { ...validAnswer, durationMs: Infinity }, { ...validAnswer, durationMs: -1 }, { ...validAnswer, inputTokens: 0.1 },
    { ...validAnswer, inputTokens: -1 }, { ...validAnswer, unexpected: true },
    { ...validAnswer, probabilities: { assigned: 0.9, supervisor: 0.1 } },
    { ...validAnswer, probabilities: { assigned: 0.9, supervisor: 0.08, other: 0.02 } },
    { ...validAnswer, probabilities: { assigned: 0.9002, supervisor: 0.08, review: 0.02 } },
    { ...validAnswer, probabilities: { assigned: 1.1, supervisor: -0.1, review: 0 } },
    { ...validAnswer, choice: 'review' }, { ...validAnswer, probabilities: { assigned: 0.9, supervisor: Infinity, review: 0.02 } }];
  for (const value of invalid) assert.throws(() => validateRoutingAnswer(value), /invalid routing/);
});

test('native SDK results are checked beyond its parser before being trusted', async () => {
  for (const answer of [
    { choice: 'unknown' }, { choice: 'review' }, { confidence: 1.2 },
    { probabilities: { assigned: 0.9, supervisor: 0.08, review: 0.0202 } },
    { probabilities: { assigned: 0.9, supervisor: 0.08, review: 0.02, injected: 0 } },
  ]) {
    const execute = createRoutingExecutor({ environment, fetch: mockFetch(() => json(nativeBody(answer))) });
    await assert.rejects(execute(context()), /invalid routing/);
  }
  const missing = nativeBody() as Partial<ReturnType<typeof nativeBody>>;
  delete missing.model;
  await assert.rejects(createRoutingExecutor({ environment, fetch: mockFetch(() => json(missing)) })(context()), /identify its model/);
});

test('provider failures never retry or expose configured credentials and local project roots', async () => {
  let requests = 0;
  const execute = createRoutingExecutor({ environment, fetch: mockFetch(() => {
    requests++;
    return json({ error: { message: 'routing-secret supervisor-secret C:\\private\\project Bearer arbitrary-token' } }, 503);
  }) });
  await assert.rejects(execute(context()), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /routing-secret|supervisor-secret|private|arbitrary-token/);
    return true;
  });
  assert.equal(requests, 1);
});

test('native responses cannot redirect or exceed the declared or streamed body allowance', async () => {
  const responses = [
    () => new Response('', { status: 302, headers: { location: 'https://another.example/systemone' } }),
    () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(1024 * 1024 + 1)),
  ];
  for (const response of responses) {
    let requests = 0;
    const execute = createRoutingExecutor({ environment, fetch: mockFetch(() => { requests++; return response(); }) });
    await assert.rejects(execute(context()), /redirects|1 MiB allowance/);
    assert.equal(requests, 1);
  }
});

test('the total deadline cancels a response body that never finishes', { timeout: 3000 }, async () => {
  let cancelled = false;
  const execute = createRoutingExecutor({ environment, fetch: mockFetch(() => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }))) });
  const started = Date.now();
  await assert.rejects(execute(context({ timeoutSeconds: 1 })), /1-second deadline/);
  assert.ok(cancelled);
  assert.ok(Date.now() - started < 2500);
});

test('stop cancels and drains a pending native response body', async () => {
  const controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false;
  const execute = createRoutingExecutor({ environment, fetch: mockFetch(() => {
    entered();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }) });
  const operation = execute(context({}, controller.signal));
  await started;
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.ok(cancelled);
});

test('Stop retains its endpoint permit until underlying response cancellation cleanup finishes', async () => {
  const controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let releaseCleanup!: () => void; const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let cancellationStarted!: () => void; const cancelling = new Promise<void>(resolve => { cancellationStarted = resolve; });
  let finished = false;
  let settled = false;
  const execute = createRoutingExecutor({ environment, fetch: mockFetch(() => {
    entered();
    return new Response(new ReadableStream({ async cancel() { cancellationStarted(); await cleanup; finished = true; } }));
  }) });
  const operation = execute(context({}, controller.signal));
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  void operation.finally(() => { settled = true; }).catch(() => {});
  await started;
  controller.abort();
  await cancelling;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(finished, false);
  releaseCleanup();
  await rejected;
  assert.equal(finished, true);
});

test('routing sends bounded relevant metadata without source paths, screenshot data or key configuration', async () => {
  const current = context({ contextWindow: 4096 });
  current.node.data.prompt = 'Review C:\\private\\project with routing-secret supervisor-secret data:image/png;base64,AAAA /api/screenshots/run/image.png ' + 'x'.repeat(8000);
  current.node.data.responsibilities = ['Review ' + 'x'.repeat(2000)];
  current.messages = Array.from({ length: 30 }, (_, index) => ({ id: String(index), from: 'tester', to: current.node.id,
    runId: current.run.id, type: 'message', text: `message-${index} ` + 'x'.repeat(200), createdAt: new Date(index * 1000).toISOString() }));
  current.messages.push({ id: 'unrelated', from: 'other', to: 'tester', type: 'message', text: 'unrelated-message', createdAt: '' });
  current.messages.push({ id: 'old-run', from: 'tester', to: current.node.id, runId: 'old-run', type: 'message', text: 'old-run-message', createdAt: '' });
  current.findings = Array.from({ length: 15 }, (_, index) => ({ id: String(index), nodeId: current.node.id,
    title: `finding-${index}`, description: 'Review routing-secret', severity: 'medium', status: 'open',
    file: 'C:\\private\\source.ts', screenshot: 'data:image/png;base64,SECRET', createdAt: new Date(index * 1000).toISOString() }));
  const execute = createRoutingExecutor({ environment, fetch: mockFetch(async request => {
    const body = await request.json();
    const state = body.state;
    const text = JSON.stringify(state);
    assert.doesNotMatch(text, /private|routing-secret|supervisor-secret|data:image|screenshots|SECRET|apiKeyEnv|baseUrl|unrelated-message|old-run-message/);
    assert.ok(state.omitted.metadata);
    assert.ok(state.omitted.inbox >= 18);
    assert.ok(state.omitted.findings >= 3);
    assert.ok(state.inbox.some((item: { text: string }) => item.text.startsWith('message-29')));
    assert.ok(state.findings.some((item: { title: string }) => item.title === 'finding-14'));
    assert.ok(requestSize(body) <= 4096 - 256);
    return json(nativeBody());
  }) });
  await execute(current);
});

function llamaFetch(base: string, inspect?: (request: Request, body: any) => void, logprobs = [Math.log(0.8), Math.log(0.15), Math.log(0.05)]) {
  return mockFetch(async request => {
    assert.equal(new URL(request.url).origin, new URL(base).origin);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.redirect, 'error');
    const body = await request.json();
    inspect?.(request, body);
    const endpoint = new URL(request.url).pathname;
    if (endpoint === '/tokenize') return json({ tokens: body.content === '\n' ? [10] : [10, body.content.charCodeAt(body.content.length - 1)] });
    if (endpoint === '/apply-template') return json({ prompt: body.messages.map((message: { content: string }) => message.content).join('\n') });
    if (endpoint === '/completion') return json({ model: 'resolved-local', completion_probabilities: [{ top_logprobs:
      logprobs.map((logprob, index) => ({ id: 65 + index, logprob })) }] });
    throw new Error(`Unexpected request: ${request.url}`);
  });
}

test('actual llama.cpp SDK accepts root and /v1 endpoints and applies the configured temperature', async () => {
  for (const [index, suffix] of ['', '/v1/'].entries()) {
    const base = `http://127.0.0.1:${18080 + index}${suffix}`;
    let completion = 0;
    const execute = createRoutingExecutor({ environment: {}, fetch: llamaFetch(base, (request, body) => {
      if (request.url.endsWith('/completion')) {
        completion++;
        assert.equal(body.n_predict, 1);
        assert.equal(body.n_probs, 256);
        assert.equal(body.post_sampling_probs, false);
        assert.equal(body.temperature, 0);
      }
      if (request.url.endsWith('/apply-template')) assert.equal(body.chat_template_kwargs.enable_thinking, false);
    }) });
    const result = await execute(context({ backend: 'llama-cpp', baseUrl: base, apiKeyEnv: '', modelId: 'local-qwen', temperature: 2 }));
    const expected = Math.sqrt(0.8) / (Math.sqrt(0.8) + Math.sqrt(0.15) + Math.sqrt(0.05));
    assert.equal(result.choice, 'assigned');
    assert.ok(Math.abs(result.probabilities.assigned - expected) < 1e-10);
    assert.ok(Math.abs(result.confidence - (3 * expected - 1) / 2) < 1e-10);
    assert.equal(result.modelId, 'resolved-local');
    assert.equal(result.inputTokens, 0);
    assert.equal(completion, 1);
  }
});

test('llama.cpp missing answer labels exhausts bounded readout depths and fails', async () => {
  const base = 'http://127.0.0.1:18082';
  const depths: number[] = [];
  const execute = createRoutingExecutor({ environment: {}, fetch: llamaFetch(base, (request, body) => {
    if (request.url.endsWith('/completion')) depths.push(body.n_probs);
  }, [Math.log(0.8), Math.log(0.15)]) });
  await assert.rejects(execute(context({ backend: 'llama-cpp', baseUrl: base, apiKeyEnv: '', modelId: 'local-qwen' })), /did not rank labels C/);
  assert.deepEqual(depths, [256, 4096, 32768]);
});

test('llama.cpp small contexts reserve room for the fixed rubric and model chat template', async () => {
  const base = 'http://127.0.0.1:18084/v1';
  const current = context({ backend: 'llama-cpp', baseUrl: base, apiKeyEnv: '', modelId: 'local-small', contextWindow: 4096 });
  current.node.data.prompt = 'Review the assigned module. ' + 'x'.repeat(20000);
  const execute = createRoutingExecutor({ environment: {}, fetch: llamaFetch(base, (request, body) => {
    if (request.url.endsWith('/completion')) {
      assert.ok(requestSize(body) <= 4096 - 256);
      assert.match(body.prompt, /omitted/);
    }
  }) });
  assert.equal((await execute(current)).choice, 'assigned');
});

test('llama.cpp adapter drains sibling tokenization requests when another request fails', async () => {
  let pending = 0;
  let drained = 0;
  const execute = createRoutingExecutor({ environment: {}, fetch: mockFetch(async request => {
    if (request.url.endsWith('/apply-template')) return json({ error: 'invalid template' }, 500);
    pending++;
    return new Response(new ReadableStream({
      cancel() { pending--; drained++; },
    }));
  }) });
  await assert.rejects(execute(context({ backend: 'llama-cpp', baseUrl: 'http://127.0.0.1:18083', apiKeyEnv: '', modelId: 'local-qwen' })), /500/);
  assert.equal(pending, 0);
  assert.equal(drained, 6);
});
