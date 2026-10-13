import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { makeAgent } from '../shared/defaults';
import { createPiExecutor } from './pi';
import type { ExecutionContext } from './engine';

function stream(response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls') {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [value, reason] of [[delta, null], [{}, finish]] as const) response.write(`data: ${JSON.stringify({ id: 'project-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

for (const codeMode of [false, true]) test(`installed Pi ${codeMode ? 'CodeMode' : 'direct tools'} edits source, creates files and records real tests`, { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-pi-project-'));
  const projectPath = path.join(directory, 'source');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'app.js'), 'export const value = 1;\n');
  await writeFile(path.join(projectPath, 'verify.cjs'), `const fs=require('node:fs');if(!fs.readFileSync('app.js','utf8').includes('value = 2'))process.exit(1);console.log('REAL_TEST_PASSED');`);
  let count = 0;
  const errors: unknown[] = [];
  const activity: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const available = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      for (const name of ['project_read', 'project_edit', 'project_write', 'project_test']) assert.ok(available.includes(name));
      assert.ok(!available.includes('bash') && !available.includes('write'));
      const prompts = JSON.stringify(body.messages);
      assert.match(prompts, /explicitly enabled capabilities/);
      assert.match(prompts, /Configured test commands/);
      assert.doesNotMatch(prompts, /verify\.cjs/, 'Only configured command IDs and names are sent to the model, not raw shell command text.');
      count++;
      const calls = codeMode ? [{ name: 'codemode', args: { code: `await tools.project_read({path:'app.js'});text(await tools.project_edit({path:'app.js',oldText:'value = 1',newText:'value = 2'}));text(await tools.project_write({path:'new.js',content:'export const created = true;\\n'}));text(await tools.project_test({commandId:'unit'}));` } }]
        : [{ name: 'project_read', args: { path: 'app.js' } }, { name: 'project_edit', args: { path: 'app.js', oldText: 'value = 1', newText: 'value = 2' } }, { name: 'project_write', args: { path: 'new.js', content: 'export const created = true;\n' } }, { name: 'project_test', args: { commandId: 'unit' } }];
      const stage = codeMode ? 0 : count - 1;
      if (count <= (codeMode ? 1 : calls.length)) {
        const call = calls[stage];
        stream(response, { tool_calls: [{ index: 0, id: `tool-${count}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, 'tool_calls');
      } else {
        assert.match(prompts, /REAL_TEST_PASSED/);
        // Provider-provided test and change fields must never replace tool evidence.
        stream(response, { content: JSON.stringify({ output: 'Updated and verified source.', findings: [], messages: [], assignments: [], tests: [{ commandId: 'invented', passed: true }], changes: [{ path: 'invented.js' }] }) }, 'stop');
      }
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const node: ExecutionContext['node'] = { id: 'coder', type: 'agent', position: { x: 0, y: 0 }, data: { ...makeAgent('custom', 'fixture'), tools: ['read', 'edit', 'test'], prompt: 'Fix app.js, create new.js and run the unit command.' } };
  const context: ExecutionContext = {
    workflow: { id: 'project', name: 'Project tools', description: '', nodes: [node], edges: [], settings: { mode: 'once', maxCycles: 1, intervalSeconds: 0, entryNodeId: node.id, projectPath, previewUrl: '', executionMode: 'pi', codeMode } },
    models: [{ id: 'fixture', name: 'Local fixture', provider: 'custom', modelId: 'fixture', kind: 'local', baseUrl: `${origin}/v1`, apiKeyEnv: '', enabled: true, contextWindow: 32768, maxOutputTokens: 2048, timeoutSeconds: 30 }],
    node, run: { id: 'fixture-run', status: 'running', mode: 'pi', startedAt: new Date().toISOString(), cycle: 1, steps: 0 }, cycle: 1, messages: [], findings: [], upstreamResults: [], signal: new AbortController().signal,
    project: { path: projectPath, previewUrl: '', allowEdits: true, allowTests: true, testCommands: [{ id: 'unit', name: 'Unit tests', command: `"${process.execPath}" verify.cjs`, timeoutSeconds: 10 }] },
    onProjectActivity: async value => { activity.push(value); },
  };
  try {
    const report = await createPiExecutor(path.join(directory, 'state'), { fetch: (input, init) => {
      assert.equal(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).origin, origin);
      return fetch(input, init);
    } })(context);
    assert.equal(await readFile(path.join(projectPath, 'app.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(await readFile(path.join(projectPath, 'new.js'), 'utf8'), 'export const created = true;\n');
    assert.deepEqual(report.changes, [{ path: 'app.js', action: 'edited' }, { path: 'new.js', action: 'created' }]);
    assert.equal(report.tests?.length, 1); assert.equal(report.tests[0].commandId, 'unit'); assert.equal(report.tests[0].passed, true); assert.equal(report.tests[0].exitCode, 0);
    assert.match(report.tests[0].output, /REAL_TEST_PASSED/); assert.equal(activity.length, 3);
    assert.deepEqual(errors, []);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
