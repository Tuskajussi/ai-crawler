import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import type { ModelConfig } from '../shared/types';
import { readServerConfig } from './config';
import { confineProject, validateEmbeddingAccess, validateModelAccess, validateRoutingAccess, validateRunAccess } from './policy';
import type { EmbeddingConfig } from '../shared/knowledge';
import type { RoutingSettings } from '../shared/types';

const productionEnv = {
  NODE_ENV: 'production',
  CRAWLSPACE_PUBLIC_URL: 'https://crawl.example.com',
  CRAWLSPACE_REGISTRATION_SECRET: 'a-private-registration-secret-at-least-32-characters',
};

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { id: 'model', name: 'Review model', provider: 'anthropic', modelId: 'example-model', kind: 'cloud', baseUrl: '', apiKeyEnv: 'ANTHROPIC_API_KEY', enabled: true, ...overrides };
}

async function projectFixture() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'crawlspace-policy-'));
  const projectsRoot = path.join(directory, 'users', 'account-a', 'projects');
  const project = path.join(projectsRoot, 'reviewed-repo');
  const otherAccount = path.join(directory, 'users', 'account-b', 'projects', 'private-repo');
  const siblingPrefix = path.join(path.dirname(projectsRoot), 'projects-other', 'private-repo');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(otherAccount, { recursive: true }), mkdir(siblingPrefix, { recursive: true })]);
  await writeFile(path.join(project, 'source.ts'), 'export const value = 1;');
  return {
    projectsRoot, project, otherAccount, siblingPrefix,
    cleanup: async () => {
      assert.equal(path.dirname(directory), temporaryRoot);
      assert.ok(path.basename(directory).startsWith('crawlspace-policy-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('account project policy accepts private folders and rejects another account and sibling-prefix folders', async () => {
  const fixture = await projectFixture();
  try {
    assert.equal(await confineProject(fixture.project, fixture.projectsRoot), await realpath(fixture.project));
    await assert.rejects(() => confineProject(fixture.otherAccount, fixture.projectsRoot), /private projects folder/);
    await assert.rejects(() => confineProject(fixture.siblingPrefix, fixture.projectsRoot), /private projects folder/);
    await assert.rejects(() => confineProject('reviewed-repo', fixture.projectsRoot), /absolute project path/);
    await assert.rejects(() => confineProject(path.join(fixture.project, 'source.ts'), fixture.projectsRoot), /must be a folder/);
  } finally { await fixture.cleanup(); }
});

test('account project policy resolves symlinks before approving a selected project', async context => {
  const fixture = await projectFixture();
  try {
    const link = path.join(fixture.projectsRoot, 'linked-private-repo');
    try { await symlink(fixture.otherAccount, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Host does not allow creating symlinks.'); return; }
      throw error;
    }
    await assert.rejects(() => confineProject(link, fixture.projectsRoot), /private projects folder/);
  } finally { await fixture.cleanup(); }
});

test('model access blocks arbitrary process secrets while accepting approved provider credential names', () => {
  const config = readServerConfig(productionEnv);
  for (const apiKeyEnv of ['CRAWLSPACE_REGISTRATION_SECRET', 'DATABASE_PASSWORD', 'HOME', 'UNAPPROVED_MODEL_KEY']) {
    assert.throws(() => validateModelAccess([model({ apiKeyEnv })], config), /host has not enabled credential/, apiKeyEnv);
  }
  assert.doesNotThrow(() => validateModelAccess([model()], config));
  const approved = readServerConfig({ ...productionEnv, CRAWLSPACE_MODEL_KEY_ALLOWLIST: 'TEAM_MODEL_KEY' });
  assert.doesNotThrow(() => validateModelAccess([model({ apiKeyEnv: 'TEAM_MODEL_KEY' })], approved));
  assert.throws(() => validateModelAccess([model()], approved), /host has not enabled credential/);
});

test('hosted model access checks resolved local defaults even when the base URL is empty', () => {
  const config = readServerConfig(productionEnv);
  for (const provider of ['custom', 'ollama'] as const) {
    const local = model({ provider, kind: 'local', apiKeyEnv: '', baseUrl: '' });
    assert.throws(() => validateModelAccess([local], config), /host has not enabled model endpoint/, provider);
    const allowed = readServerConfig({ ...productionEnv, CRAWLSPACE_MODEL_ENDPOINT_ORIGINS: 'http://127.0.0.1:11434' });
    assert.doesNotThrow(() => validateModelAccess([local], allowed));
  }
});

test('built-in model origins work while custom and provider-override origins require explicit approval', () => {
  const config = readServerConfig(productionEnv);
  assert.doesNotThrow(() => validateModelAccess([
    model(),
    model({ provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' }),
  ], config));
  const override = model({ baseUrl: 'https://private-model.example/v1' });
  assert.throws(() => validateModelAccess([override], config), /host has not enabled model endpoint/);
  assert.throws(() => validateModelAccess([model({ baseUrl: 'https://api.anthropic.com.attacker.example/v1' })], config), /host has not enabled model endpoint/);
  const approved = readServerConfig({ ...productionEnv, CRAWLSPACE_MODEL_ENDPOINT_ORIGINS: 'https://private-model.example' });
  assert.doesNotThrow(() => validateModelAccess([override], approved));
});

test('real screenshot runs require an approved exact loopback origin in production', async () => {
  const fixture = await projectFixture();
  try {
    const workflow = structuredClone(initialState.workflow);
    workflow.settings.projectPath = fixture.project;
    workflow.settings.previewUrl = 'http://127.0.0.1:4173/review?mode=ui';
    const models = [model()];
    const closed = readServerConfig(productionEnv);
    await assert.rejects(() => validateRunAccess(workflow, models, fixture.projectsRoot, closed), /has not enabled this screenshot preview origin/);
    const approved = readServerConfig({ ...productionEnv, CRAWLSPACE_PREVIEW_ORIGINS: 'http://127.0.0.1:4173' });
    assert.equal(await validateRunAccess(workflow, models, fixture.projectsRoot, approved), await realpath(fixture.project));
    workflow.settings.previewUrl = 'http://127.0.0.1:4174';
    await assert.rejects(() => validateRunAccess(workflow, models, fixture.projectsRoot, approved), /has not enabled this screenshot preview origin/);
    workflow.settings.previewUrl = 'https://public-preview.example';
    await assert.rejects(() => validateRunAccess(workflow, models, fixture.projectsRoot, approved), /Preview URL must use/);
  } finally { await fixture.cleanup(); }
});

test('development screenshot runs retain loopback access without production preview approval', async () => {
  const fixture = await projectFixture();
  try {
    const workflow = structuredClone(initialState.workflow);
    workflow.settings.projectPath = fixture.project;
    workflow.settings.previewUrl = 'http://localhost:4173';
    const config = readServerConfig({ NODE_ENV: 'development' });
    assert.equal(await validateRunAccess(workflow, [model()], fixture.projectsRoot, config), await realpath(fixture.project));
    workflow.settings.previewUrl = 'http://example.com';
    await assert.rejects(() => validateRunAccess(workflow, [model()], fixture.projectsRoot, config), /Preview URL must use/);
  } finally { await fixture.cleanup(); }
});

test('production startup requires a single HTTPS public origin and normalizes the default HTTPS port', () => {
  assert.throws(() => readServerConfig({ NODE_ENV: 'production' }), /Set CRAWLSPACE_PUBLIC_URL/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_PUBLIC_URL: 'http://crawl.example.com' }), /requires an HTTPS/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_PUBLIC_URL: 'https://crawl.example.com/workflow' }), /origins without paths/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_PUBLIC_URL: 'https://first.example,https://second.example' }));
  assert.equal(readServerConfig({ ...productionEnv, CRAWLSPACE_PUBLIC_URL: 'https://crawl.example.com:443' }).publicUrl, 'https://crawl.example.com');
});

test('startup rejects weak registration secrets and unrestricted proxy trust but permits closed registration', () => {
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_REGISTRATION_SECRET: 'short-secret' }), /at least 32 characters/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_TRUST_PROXY: 'true' }), /never true/);
  assert.equal(readServerConfig({ ...productionEnv, CRAWLSPACE_REGISTRATION_SECRET: '' }).registrationSecret, undefined);
  assert.equal(readServerConfig({ ...productionEnv, CRAWLSPACE_TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(readServerConfig({ ...productionEnv, CRAWLSPACE_TRUST_PROXY: 'false' }).trustProxy, false);
});

test('operator origin settings reject paths, credentials, and non-loopback screenshot targets', () => {
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_MODEL_ENDPOINT_ORIGINS: 'https://model.example/v1' }), /origins without paths/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_MODEL_ENDPOINT_ORIGINS: 'https://user:password@model.example' }), /origins without paths/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_PREVIEW_ORIGINS: 'http://10.0.0.1:4173' }), /explicit loopback origins/);
  assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_PREVIEW_ORIGINS: 'http://localhost:4173/private' }), /origins without paths/);
});

test('server secrets cannot become model credentials even through an accidentally permissive allowlist', () => {
  for (const apiKeyEnv of ['CRAWLSPACE_REGISTRATION_SECRET', 'CRAWLSPACE_SESSION_SECRET']) {
    assert.throws(() => readServerConfig({ ...productionEnv, CRAWLSPACE_MODEL_KEY_ALLOWLIST: apiKeyEnv }), /credential|secret|key|CRAWLSPACE_/i);
    const accidentallyPermissive = { ...readServerConfig(productionEnv), modelKeyNames: [apiKeyEnv] };
    assert.throws(() => validateModelAccess([model({ apiKeyEnv })], accidentallyPermissive), /credential|secret|key|CRAWLSPACE_/i);
  }
});

test('decision and embedding services preserve operator credential and endpoint approval in local and hosted copies', () => {
  const routing: RoutingSettings = { mode: 'shadow', backend: 'llama-cpp', baseUrl: 'http://192.168.1.22:8081/v1', modelId: 'fixture-decision', apiKeyEnv: 'TEAM_MODEL_KEY', timeoutSeconds: 30, confidenceThreshold: 0.8, maxDecisionsPerCycle: 10, maxDecisionsPerRun: 30, maxConcurrentRequests: 1, contextWindow: 4096, temperature: 0 };
  const embedding: EmbeddingConfig = { provider: 'compatible', kind: 'local', modelId: 'fixture-embedding', baseUrl: routing.baseUrl, apiKeyEnv: 'TEAM_MODEL_KEY', dimensions: 3, timeoutSeconds: 30, projectId: '', location: 'global' };
  for (const hosted of [false, true]) {
    const closed = readServerConfig(productionEnv, { hosted });
    assert.throws(() => validateRoutingAccess(routing, closed), /credential/);
    assert.throws(() => validateEmbeddingAccess(embedding, closed), /credential/);
    const keyOnly = { ...closed, modelKeyNames: ['TEAM_MODEL_KEY'] };
    assert.throws(() => validateRoutingAccess(routing, keyOnly), /endpoint/);
    assert.throws(() => validateEmbeddingAccess(embedding, keyOnly), /endpoint/);
    const approved = { ...keyOnly, modelEndpointOrigins: ['http://192.168.1.22:8081'] };
    assert.doesNotThrow(() => validateRoutingAccess(routing, approved));
    assert.doesNotThrow(() => validateEmbeddingAccess(embedding, approved));
    assert.throws(() => validateEmbeddingAccess({ ...embedding, apiKeyEnv: 'CRAWLSPACE_REGISTRATION_SECRET' }, { ...approved, modelKeyNames: ['CRAWLSPACE_REGISTRATION_SECRET'] }), /credential/);
  }
  const google = readServerConfig(productionEnv, { modelKeyNames: ['GOOGLE_API_KEY'], modelEndpointOrigins: ['https://generativelanguage.googleapis.com', 'https://aiplatform.eu.rep.googleapis.com'] });
  assert.doesNotThrow(() => validateEmbeddingAccess({ ...embedding, provider: 'gemini', kind: 'cloud', baseUrl: '', apiKeyEnv: 'GOOGLE_API_KEY' }, google));
  assert.doesNotThrow(() => validateEmbeddingAccess({ ...embedding, provider: 'vertex', kind: 'cloud', baseUrl: '', apiKeyEnv: '', projectId: 'fixture-project', location: 'eu' }, google));
  assert.throws(() => validateEmbeddingAccess({ ...embedding, provider: 'vertex', kind: 'cloud', baseUrl: '', apiKeyEnv: '', projectId: 'fixture-project', location: 'us' }, google), /endpoint/);
});
