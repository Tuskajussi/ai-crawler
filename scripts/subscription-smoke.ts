/** Exercise real Pi Responses + Code Mode using an in-memory subscription transport. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiExecutor } from '../server/pi';
import type { ChatgptService } from '../server/chatgpt';
import type { ExecutionContext } from '../server/engine';

const parent = path.resolve(os.tmpdir());
const directory = await mkdtemp(path.join(parent, 'crawlspace-subscription-smoke-'));
const projectPath = path.join(directory, 'project');
const stateDirectory = path.join(directory, 'state');
await mkdir(projectPath); await mkdir(stateDirectory);
await writeFile(path.join(projectPath, 'app.ts'), 'export const total = items[0].price; // SUBSCRIPTION_SOURCE_EVIDENCE\n');
const originalFetch = globalThis.fetch;
let requests = 0;
let tokenReads = 0;
let mode: 'complete' | 'incomplete' | 'late-failure' = 'complete';
const service = {
  profileReadiness: async () => ({ ready: true, message: 'Fixture subscription configured' }),
  accessToken: async () => `fixture-subscription-token-${++tokenReads}`,
} as unknown as ChatgptService;

function responseEvents(item: any, terminal: boolean, failed: boolean): Response {
  const response = { id: `resp_${requests}`, created_at: 1, model: 'fixture-supervisor', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } };
  const events: unknown[] = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }];
  if (terminal) events.push({ type: 'response.completed', response });
  if (failed) events.push({ type: 'response.failed', response: { ...response, status: 'failed', error: { code: 'invalid_request_error', message: 'Fixture final terminal failure' } } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

try {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.method, 'POST');
    requests++;
    assert.equal(request.headers.get('authorization'), `Bearer fixture-subscription-token-${tokenReads}`);
    assert.equal(request.redirect, 'error');
    const body = await request.json() as any;
    assert.equal(body.store, false); assert.equal(body.stream, true);
    for (const field of ['max_output_tokens', 'previous_response_id', 'tools', 'temperature', 'prompt_cache_retention']) assert.ok(!(field in body), `Unsupported subscription field ${field} must be omitted`);
    assert.ok(!body.input.some((item: any) => item.role === 'system'));
    const declaration = body.input.find((item: any) => item.type === 'additional_tools');
    assert.equal(declaration?.role, 'developer');
    assert.ok(declaration.tools.some((tool: any) => tool.name === 'codemode'));
    assert.ok(!declaration.tools.some((tool: any) => ['bash', 'write', 'edit'].includes(tool.name)));
    const toolOutput = body.input.find((item: any) => item.type === 'function_call_output');
    if (mode === 'complete' && !toolOutput) {
      return responseEvents({ type: 'function_call', id: 'fc_fixture', call_id: 'call_code', name: 'codemode', arguments: JSON.stringify({ code: `const source = await tools.project_read({path:'app.ts',limit:3}); text(source);` }), status: 'completed' }, true, false);
    }
    if (mode === 'complete') assert.match(JSON.stringify(toolOutput), /SUBSCRIPTION_SOURCE_EVIDENCE/);
    const text = JSON.stringify({ findings: mode === 'complete' ? [{ title: 'Missing empty check', description: 'app.ts line 1 reads items[0].price without an empty-list check.', severity: 'medium', file: 'app.ts', line: 1 }] : [], messages: [], assignments: [] });
    return responseEvents({ type: 'message', id: `msg_${requests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }, mode !== 'incomplete', mode === 'late-failure');
  };
  const node: ExecutionContext['node'] = { id: 'review', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Subscription reviewer', role: 'reviewer', description: '', persona: 'Review actual evidence.', prompt: 'Read app.ts and return the requested report.', responsibilities: ['Source review'], modelId: 'subscription', color: '#00a99d', tools: ['read'], status: 'idle' } };
  const context: ExecutionContext = {
    node, models: [{ id: 'subscription', name: 'Fixture subscription', provider: 'openai', modelId: 'fixture-supervisor', kind: 'cloud', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: '', enabled: true, authMethod: 'chatgpt', chatgptProfileId: 'fixture-profile', contextWindow: 32768 }],
    workflow: { id: 'fixture', name: 'Fixture', description: '', nodes: [node], edges: [], settings: { mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: node.id, projectPath, previewUrl: '', executionMode: 'pi', codeMode: true } },
    run: { id: 'fixture', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 }, cycle: 1, messages: [], findings: [], signal: new AbortController().signal,
  };
  const execute = createPiExecutor(stateDirectory, { chatgpt: service });
  const report = await execute(context);
  assert.equal(report.findings?.[0]?.file, 'app.ts');
  assert.equal(requests, 2);
  assert.equal(tokenReads, 2, 'Each HTTP request obtains the current profile token, including tool continuations.');
  assert.equal(report.execution?.inputTokens, 200);
  assert.equal((await readdir(path.join(stateDirectory, 'pi', 'visits'))).length, 0, 'Finished visits remove their isolated runtime files.');
  mode = 'incomplete'; requests = 0;
  await assert.rejects(execute(context), /terminal|completed|response event/i);
  assert.equal(requests, 3, 'A partial subscription response cannot become a successful report.');
  mode = 'late-failure'; requests = 0;
  await assert.rejects(execute(context), /Fixture final terminal failure/);
  assert.equal(requests, 1, 'A late terminal failure must override earlier apparent completion.');
  console.log('PASS: actual Pi Responses and Code Mode consumed confined source evidence through a scoped subscription transport; current token used per request, unsupported fields omitted, secrets not persisted, partial and late-failed responses rejected. No real authentication, network or subscription usage.');
} finally {
  globalThis.fetch = originalFetch;
  assert.equal(path.dirname(path.resolve(directory)), parent);
  assert.ok(path.basename(directory).startsWith('crawlspace-subscription-smoke-'));
  await rm(directory, { recursive: true, force: true });
}
