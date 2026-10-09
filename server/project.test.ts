import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import { ProjectReader } from './project';
import { parseAgentReport } from './report';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-project-'));
  const root = path.join(directory, 'project');
  const outside = path.join(directory, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'app.ts'), 'export const count = 1;\nconsole.log(count);\n');
  await writeFile(path.join(root, '.env'), 'SECRET=do-not-read');
  await writeFile(path.join(outside, 'secret.txt'), 'outside-data');
  const project = await ProjectReader.open(root);
  return { root, outside, project, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('project tools block traversal and secrets while reading numbered source lines', async () => {
  const { project, cleanup } = await fixture();
  try {
    await assert.rejects(() => project.read('../outside/secret.txt'), /outside/);
    await assert.rejects(() => project.read('.env'), /secret files/);
    assert.match(await project.read('app.ts', 2, 1), /2: console.log/);
    assert.equal(await project.list(), 'app.ts');
    assert.match(await project.find('app'), /app.ts/);
    assert.match(await project.grep('count ='), /app.ts:1/);
    assert.doesNotMatch(await project.grep('SECRET'), /do-not-read/);
  } finally { await cleanup(); }
});

test('canonical paths reject directory symlinks leading outside the project', async context => {
  const { root, outside, project, cleanup } = await fixture();
  try {
    try { await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Host does not allow creating symlinks.'); return; } throw error; }
    await assert.rejects(() => project.read('linked/secret.txt'), /outside/);
    assert.doesNotMatch((await project.files()).join('\n'), /secret.txt/);
  } finally { await cleanup(); }
});

test('report parser rejects malformed, unverified, and escaping evidence', async () => {
  const { project, cleanup } = await fixture();
  try {
    const report = (finding: Record<string, unknown>) => JSON.stringify({ findings: [finding], messages: [], assignments: [] });
    const valid = { title: 'An observed issue', description: 'Specific evidence from the file.', severity: 'medium', file: 'app.ts', line: 1 };
    await assert.rejects(() => parseAgentReport('not-json', initialState.workflow, project), /invalid report/);
    await assert.rejects(() => parseAgentReport(report(valid), initialState.workflow, project), /did not inspect/);
    await project.read('app.ts');
    await assert.rejects(() => parseAgentReport(report({ ...valid, file: '../outside/secret.txt' }), initialState.workflow, project), /outside/);
    await assert.rejects(() => parseAgentReport(report({ ...valid, severity: 'banana' }), initialState.workflow, project), /malformed/);
    await assert.rejects(() => parseAgentReport(report({ ...valid, line: 999 }), initialState.workflow, project), /beyond/);
    await assert.rejects(() => parseAgentReport(JSON.stringify({ findings: [], messages: [{ to: 'missing', text: 'hello' }], assignments: [] }), initialState.workflow, project), /recipient/);
    const parsed = await parseAgentReport(report(valid), initialState.workflow, project);
    assert.equal(parsed.findings?.[0].file, 'app.ts');
    const ui = await parseAgentReport(report({ title: 'Visible overlap', description: 'Two labels overlap in the attached screenshot.', severity: 'low' }), initialState.workflow, project, '/api/screenshots/actual.png');
    assert.equal(ui.findings?.[0].screenshot, '/api/screenshots/actual.png');
  } finally { await cleanup(); }
});
