import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppState, ProjectSettings } from '../shared/types';
import { createApp } from './index';

const SECRET = 'project-api-fixture-registration-secret-at-least-32-characters';
const PASSWORD = 'project fixture sufficiently long password';

async function withServer(run: (context: { instance: Awaited<ReturnType<typeof createApp>>; base: string; directory: string; project: string }) => Promise<void>) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'crawlspace-project-api-'));
  const project = path.join(directory, 'existing-local-repository');
  await mkdir(project);
  try {
    const instance = await createApp({ dataDir: path.join(directory, 'data'), registrationSecret: SECRET, demoStepMs: 60_000, config: { hosted: false } });
    const server = instance.app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      await run({ instance, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, directory, project });
    } finally {
      try { await instance.shutdown(); }
      finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  } finally {
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('crawlspace-project-api-'));
    await rm(directory, { recursive: true, force: true });
  }
}

function browser(base: string) {
  let cookie = '';
  let csrfToken = '';
  const request = async (route: string, method = 'GET', body?: unknown, options: { csrf?: boolean; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
        ...(csrfToken && options.csrf !== false && method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  return { request, register: async (username: string) => {
    const response = await request('/auth/register', 'POST', { username, password: PASSWORD, registrationSecret: SECRET });
    const session = await response.json();
    assert.equal(response.status, 201, JSON.stringify(session));
    csrfToken = session.csrfToken;
    return session as { user: { id: string }; csrfToken: string };
  } };
}

function settings(project: string, overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return { path: project, previewUrl: 'http://127.0.0.1:4173', allowEdits: false, allowTests: false, testCommands: [], ...overrides };
}

async function state(client: ReturnType<typeof browser>): Promise<AppState> {
  const response = await client.request('/state');
  assert.equal(response.status, 200);
  return response.json();
}

test('project APIs require signed-in accounts and CSRF before validation or saving permissions', async () => {
  await withServer(async ({ base, project }) => {
    const client = browser(base);
    const projectSettings = settings(project, { allowEdits: true, allowTests: true, testCommands: [{ id: 'unit', name: 'Unit tests', command: 'npm test', timeoutSeconds: 120 }] });
    for (const [route, method] of [['/project', 'PUT'], ['/project/validate', 'POST']]) {
      assert.equal((await client.request(route, method, projectSettings)).status, 401);
    }
    await client.register('project-security');
    for (const [route, method] of [['/project', 'PUT'], ['/project/validate', 'POST']]) {
      assert.equal((await client.request(route, method, projectSettings, { csrf: false })).status, 403);
      assert.equal((await client.request(route, method, projectSettings, { headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
    }
    assert.equal((await state(client)).project, undefined);
    const validated = await client.request('/project/validate', 'POST', projectSettings);
    assert.equal(validated.status, 200);
    assert.equal((await validated.json()).path, await realpath(project));
    assert.equal((await state(client)).project, undefined, 'Checking a folder must not silently grant edit or test permission.');
    const saved = await client.request('/project', 'PUT', projectSettings);
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).project, { ...projectSettings, path: await realpath(project) });
  });
});

test('project-wide folder selection persists outside private roots and overrides old workflow paths', async () => {
  await withServer(async ({ instance, base, project }) => {
    const client = browser(base);
    const session = await client.register('project-folder');
    const projectSettings = settings(project, { allowEdits: true, allowTests: true, testCommands: [{ id: 'unit', name: 'Unit tests', command: 'npm test', timeoutSeconds: 45 }] });
    const original = await state(client);
    assert.ok(original.workspace);
    assert.ok(path.relative(original.workspace.projectsRoot, project).startsWith('..'));
    const saved = await client.request('/project', 'PUT', projectSettings);
    assert.equal(saved.status, 200);
    const selected = await saved.json() as AppState;
    const canonical = await realpath(project);
    assert.equal(selected.workflow.settings.projectPath, canonical);
    assert.equal(selected.workflow.settings.previewUrl, projectSettings.previewUrl);
    selected.workflow.settings.projectPath = path.join(project, 'old-workflow-path');
    selected.workflow.settings.previewUrl = 'http://localhost:9999';
    selected.workflow.settings.executionMode = 'demo';
    const workflowSaved = await client.request('/workflow', 'PUT', selected.workflow);
    assert.equal(workflowSaved.status, 200);
    const after = await workflowSaved.json() as AppState;
    assert.deepEqual(after.project, { ...projectSettings, path: canonical });
    assert.equal(after.workflow.settings.projectPath, canonical);
    assert.equal(after.workflow.settings.previewUrl, projectSettings.previewUrl);
    const workspace = await instance.workspaces.get(session.user.id);
    const disk = JSON.parse(await readFile(workspace.store.filePath, 'utf8')) as AppState;
    assert.deepEqual(disk.project, after.project, 'Folder choice and command permissions must survive a controller restart.');
  });
});

test('invalid project selections cannot overwrite saved folder permissions or approved commands', async () => {
  await withServer(async ({ instance, base, project }) => {
    const client = browser(base);
    const session = await client.register('project-invalid');
    const selected = settings(project);
    assert.equal((await client.request('/project', 'PUT', selected)).status, 200);
    const workspace = await instance.workspaces.get(session.user.id);
    const dependencyRoot = path.join(project, 'node_modules', 'nested');
    await mkdir(dependencyRoot, { recursive: true });
    const attempts = [
      settings('relative/repository'), settings(path.join(project, 'missing')),
      settings(dependencyRoot), settings(workspace.directory),
      { ...selected, testCommands: [{ id: 'test', name: 'Unit tests', command: 'npm test', timeoutSeconds: 601 }] },
      { ...selected, allowEdits: 'yes' },
    ];
    const before = (await state(client)).project;
    for (const input of attempts) {
      assert.equal((await client.request('/project/validate', 'POST', input)).status, 400);
      assert.equal((await client.request('/project', 'PUT', input)).status, 400);
      assert.deepEqual((await state(client)).project, before);
    }
    await workspace.store.flush();
  });
});

test('active work locks project settings while another account retains independent configuration', async () => {
  await withServer(async ({ instance, base, directory, project }) => {
    const alice = browser(base), bob = browser(base);
    const aliceSession = await alice.register('project-alice');
    await bob.register('project-bob');
    const bobProject = path.join(directory, 'bob-local-repository');
    await mkdir(bobProject);
    const aliceSettings = settings(project, { allowEdits: true, allowTests: true, testCommands: [{ id: 'alice-unit', name: 'Alice tests', command: 'npm test', timeoutSeconds: 90 }] });
    const bobSettings = settings(bobProject);
    assert.equal((await alice.request('/project', 'PUT', aliceSettings)).status, 200);
    assert.equal((await state(bob)).project, undefined);
    assert.equal((await bob.request('/project', 'PUT', bobSettings)).status, 200);
    assert.deepEqual((await state(alice)).project, { ...aliceSettings, path: await realpath(project) });
    const before = (await state(alice)).project;
    assert.equal((await alice.request('/runs', 'POST', { mode: 'demo' })).status, 202);
    const blocked = await alice.request('/project', 'PUT', settings(bobProject));
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /Stop the active run/);
    assert.deepEqual((await state(alice)).project, before);
    assert.equal((await bob.request('/project', 'PUT', { ...bobSettings, previewUrl: '' })).status, 200);
    assert.deepEqual((await state(alice)).project, before);
    assert.equal((await alice.request('/runs/stop', 'POST', {})).status, 200);
    await (await instance.workspaces.get(aliceSession.user.id)).engine.waitForIdle();
    assert.equal((await alice.request('/project', 'PUT', { ...aliceSettings, allowEdits: false })).status, 200);
    assert.equal((await state(alice)).project!.allowEdits, false);
    assert.deepEqual((await state(bob)).project, { ...bobSettings, previewUrl: '', path: await realpath(bobProject) });
  });
});
