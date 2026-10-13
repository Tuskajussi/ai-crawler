import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectSettings, TestExecution } from '../shared/types';
import { ProjectReader } from './project';
import { ProjectTools } from './project-tools';

const command = (script: string) => `"${process.execPath}" "${script}"`;
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check: () => Promise<boolean> | boolean, milliseconds = 5000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error('Timed out waiting for a child-process condition.');
}
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-edit-'));
  const root = path.join(directory, 'project');
  const outside = path.join(directory, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'app.ts'), 'export const café = 1;\nconsole.log(café);\n');
  await writeFile(path.join(outside, 'outside.ts'), 'outside content\n');
  const project = await ProjectReader.open(root);
  const settings: ProjectSettings = { path: root, previewUrl: '', allowEdits: true, allowTests: true, testCommands: [] };
  return { root, outside, project, settings, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('edits require an observed unique original, preserve UTF-8, and record bounded summaries', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const activities: unknown[] = [];
    const tools = await ProjectTools.open(project, settings, async activity => { activities.push(activity); });
    await assert.rejects(() => tools.edit('app.ts', 'café = 1', 'café = 2'), /Read the file/);
    await project.read('app.ts');
    await assert.rejects(() => tools.edit('app.ts', '', 'x'), /non-empty/);
    await assert.rejects(() => tools.edit('app.ts', 'café', 'x'), /exactly once/);
    await assert.rejects(() => tools.edit('app.ts', 'absent', 'x'), /exactly once/);
    const summary = await tools.edit('app.ts', 'café = 1', 'café = 2');
    assert.match(await readFile(path.join(root, 'app.ts'), 'utf8'), /café = 2/);
    assert.match(summary, /Before: [0-9a-f]{64}/);
    assert.match(summary, /After: [0-9a-f]{64}/);
    assert.doesNotMatch(summary, /export const/);
    assert.deepEqual(tools.changes, [{ path: 'app.ts', action: 'edited' }]);
    assert.deepEqual(activities, [{ change: { path: 'app.ts', action: 'edited' } }]);
    await assert.rejects(() => tools.edit('app.ts', 'café = 2', 'café = 3'), /changed since it was read/);
    await project.read('app.ts');
    await tools.edit('app.ts', 'café = 2', 'café = 3');
    assert.equal(tools.changes.length, 1);
    assert.deepEqual((await readdir(root)).filter(file => file.endsWith('.tmp')), []);
  } finally { await cleanup(); }
});

test('external changes since observation cannot be overwritten by an edit', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    await project.read('app.ts');
    await writeFile(path.join(root, 'app.ts'), 'export const café = 1;\n// someone else changed this\n');
    await assert.rejects(() => tools.edit('app.ts', 'café = 1', 'café = 2'), /changed since it was read/);
    assert.match(await readFile(path.join(root, 'app.ts'), 'utf8'), /someone else/);
    assert.equal(tools.changes.length, 0);
  } finally { await cleanup(); }
});

test('failed reads do not authorize subsequent edits', async () => {
  const { project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    for (const [offset, limit] of [[0, 300], [1, 0], [1, 501], [1.5, 100]]) {
      await assert.rejects(() => project.read('app.ts', offset, limit), /Offset starts at 1/);
      await assert.rejects(() => tools.edit('app.ts', 'café = 1', 'café = 2'), /Read the file/);
    }
    await project.read('app.ts');
    await tools.edit('app.ts', 'café = 1', 'café = 2');
  } finally { await cleanup(); }
});

test('credential directories remain hidden and uneditable at any project depth', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    await mkdir(path.join(root, 'nested'));
    for (const directory of ['.codex', '.aws', '.ssh']) {
      for (const prefix of ['', 'nested/']) {
        const relative = `${prefix}${directory}`;
        await mkdir(path.join(root, relative));
        await writeFile(path.join(root, relative, 'config'), 'private account material');
        await assert.rejects(() => project.read(`${relative}/config`), /secret files/);
        await assert.rejects(() => tools.write(`${relative}/new.txt`, 'blocked'), /secret files/);
        await assert.rejects(() => tools.edit(`${relative}/config`, 'private', 'public'), /secret files/);
      }
    }
    assert.doesNotMatch(await project.list(), /\.codex|\.aws|\.ssh/);
    assert.doesNotMatch(await project.list('nested'), /\.codex|\.aws|\.ssh/);
    assert.doesNotMatch((await project.files()).join('\n'), /\.codex|\.aws|\.ssh/);
    assert.doesNotMatch(await project.grep('private account'), /private account material/);
    assert.deepEqual(tools.changes, []);
  } finally { await cleanup(); }
});

test('new files cannot overwrite existing files and need an existing safe parent', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    await assert.rejects(() => tools.write('app.ts', 'replacement'), /already exists/);
    await assert.rejects(() => tools.write('new-folder/app.ts', 'new'), /parent folder must already exist/);
    await mkdir(path.join(root, 'src'));
    await tools.write('src/new.ts', 'export const ✓ = "hello";\n');
    assert.equal(await readFile(path.join(root, 'src', 'new.ts'), 'utf8'), 'export const ✓ = "hello";\n');
    assert.deepEqual(tools.changes, [{ path: 'src/new.ts', action: 'created' }]);
    const copy = tools.changes; copy[0].path = 'tampered';
    assert.equal(tools.changes[0].path, 'src/new.ts');
  } finally { await cleanup(); }
});

test('editing excludes traversal, absolute paths, device names, generated files, and secrets', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    for (const filename of ['../outside/outside.ts', 'src/../app.ts', path.join(root, 'absolute.ts'), 'C:\\outside.ts', '.env', '.env.local', '.git/config', '.crawlspace/state.json', 'node_modules/new.ts', 'dist/new.ts', '.npmrc', 'secrets.json', 'id_rsa', 'private.pem', 'app.ts:secret', 'nul', 'CON.txt', 'app.ts ']) {
      await assert.rejects(() => tools.write(filename, 'blocked'), Error, filename);
    }
    assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'export const café = 1;\nconsole.log(café);\n');
    assert.deepEqual(tools.changes, []);
  } finally { await cleanup(); }
});

test('file edits reject hard links and directory junctions even when the destination is in the project', async context => {
  const { root, outside, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    await link(path.join(root, 'app.ts'), path.join(outside, 'hardlinked.ts'));
    await project.read('app.ts');
    await assert.rejects(() => tools.edit('app.ts', 'café = 1', 'café = 2'), /hard links/);
    await mkdir(path.join(root, 'inside'));
    try { await symlink(path.join(root, 'inside'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('Host does not permit symlinks.'); return; } throw error; }
    await assert.rejects(() => tools.write('linked/new.ts', 'blocked'), /symbolic links or junctions/);
    assert.equal(await readFile(path.join(outside, 'hardlinked.ts'), 'utf8'), 'export const café = 1;\nconsole.log(café);\n');
  } finally { await cleanup(); }
});

test('edits reject invalid UTF-8, binary and excessive content, and aborted operations', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x61]));
    await project.read('invalid.txt');
    await assert.rejects(() => tools.edit('invalid.txt', 'a', 'b'), /valid UTF-8/);
    await assert.rejects(() => tools.write('binary.txt', 'a\0b'), /Binary files/);
    await assert.rejects(() => tools.write('large.txt', 'a'.repeat(512 * 1024 + 1)), /512 KiB/);
    await assert.rejects(() => tools.write('unicode.txt', '\ud800'), /invalid Unicode/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => tools.write('stopped.txt', 'no', controller.signal), { name: 'AbortError' });
    await assert.rejects(() => tools.edit('app.ts', '1', '2', controller.signal), { name: 'AbortError' });
    assert.deepEqual(tools.changes, []);
  } finally { await cleanup(); }
});

test('Stop during an in-flight write or edit prevents committing source changes', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, settings);
    const createController = new AbortController();
    const create = tools.write('stopped.ts', 'a'.repeat(512 * 1024), createController.signal);
    createController.abort();
    await assert.rejects(create, { name: 'AbortError' });
    await assert.rejects(() => readFile(path.join(root, 'stopped.ts')), { code: 'ENOENT' });
    await project.read('app.ts');
    const editController = new AbortController();
    const edit = tools.edit('app.ts', 'café = 1', 'café = 2', editController.signal);
    editController.abort();
    await assert.rejects(edit, { name: 'AbortError' });
    assert.match(await readFile(path.join(root, 'app.ts'), 'utf8'), /café = 1/);
    assert.deepEqual(tools.changes, []);
    assert.deepEqual((await readdir(root)).filter(file => file.endsWith('.tmp')), []);
  } finally { await cleanup(); }
});

test('project capabilities and configured command IDs cannot be bypassed by agent inputs', async () => {
  const { project, settings, cleanup } = await fixture();
  try {
    const tools = await ProjectTools.open(project, { ...settings, allowEdits: false, allowTests: false });
    await assert.rejects(() => tools.write('new.ts', 'no'), /editing is disabled/);
    await assert.rejects(() => tools.edit('app.ts', '1', '2'), /editing is disabled/);
    await assert.rejects(() => tools.runTests('test', new AbortController().signal), /execution is disabled/);
    const enabled = await ProjectTools.open(project, settings);
    await assert.rejects(() => enabled.runTests('node -e "process.exit(0)"', new AbortController().signal), /configured test command ID/);
    assert.deepEqual(enabled.tests, []);
    await assert.rejects(() => ProjectTools.open(project, { ...settings, testCommands: [{ id: 'a', name: 'bad', command: 'test', timeoutSeconds: 0 }] }), /1–600/);
  } finally { await cleanup(); }
});

test('real test commands record success/failure, latest verdicts, activity, and invalidate on edits', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const script = path.join(root, 'test.cjs');
    await writeFile(script, 'console.log("actual failure"); process.exit(1);');
    settings.testCommands = [{ id: 'suite', name: 'Project suite', command: command(script), timeoutSeconds: 10 }];
    const activities: TestExecution[] = [];
    const tools = await ProjectTools.open(project, settings, async activity => { if (activity.test) activities.push(activity.test); });
    const signal = new AbortController().signal;
    const failed = await tools.runTests('suite', signal);
    assert.equal(failed.passed, false); assert.equal(failed.exitCode, 1); assert.match(failed.output, /actual failure/);
    await writeFile(script, 'console.log("actual success");');
    const passed = await tools.runTests('suite', signal);
    assert.equal(passed.passed, true); assert.equal(passed.exitCode, 0); assert.equal(passed.timedOut, false);
    assert.equal(tools.tests.length, 1); assert.equal(tools.tests[0].passed, true);
    assert.deepEqual(activities.map(result => result.passed), [false, true]);
    await project.read('app.ts');
    await tools.edit('app.ts', 'café = 1', 'café = 2');
    assert.deepEqual(tools.tests, []);
    await tools.runTests('suite', signal);
    await tools.write('new.ts', 'hello');
    assert.deepEqual(tools.tests, []);
  } finally { await cleanup(); }
});

test('test subprocesses omit server credentials and return bounded redacted output', async () => {
  const { root, project, settings, cleanup } = await fixture();
  const key = 'CRAWLSPACE_PROJECT_TOOLS_TEST_TOKEN';
  const old = process.env[key];
  const secret = `private-${Date.now()}-model-token`;
  process.env[key] = secret;
  try {
    const script = path.join(root, 'test.cjs');
    await writeFile(script, `console.log(process.cwd()); console.log(process.env.${key} || "NO_INHERITED_TOKEN"); process.stdout.write(${JSON.stringify(secret)}); process.stdout.write("x".repeat(80000));`);
    settings.testCommands = [{ id: 'suite', name: 'Output suite', command: command(script), timeoutSeconds: 10 }];
    const tools = await ProjectTools.open(project, settings);
    const result = await tools.runTests('suite', new AbortController().signal);
    assert.equal(result.passed, true);
    assert.match(result.output, /NO_INHERITED_TOKEN/);
    assert.match(result.output, /REDACTED/);
    assert.match(result.output, /truncated/);
    assert.doesNotMatch(result.output, new RegExp(secret));
    assert.ok(Buffer.byteLength(result.output) <= 16_000);
    assert.equal(result.output.split(/\r?\n/)[0].toLowerCase(), root.toLowerCase());
  } finally {
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
    await cleanup();
  }
});

async function longRunning(root: string): Promise<{ script: string; pids: string }> {
  const script = path.join(root, 'long.cjs');
  const pids = path.join(root, 'pids.json');
  await writeFile(script, `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'}); fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid])); console.log('started'); setInterval(() => {}, 1000);`);
  return { script, pids };
}

test('test timeout terminates the full process tree before returning a failed receipt', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const { script, pids } = await longRunning(root);
    settings.testCommands = [{ id: 'suite', name: 'Timeout suite', command: command(script), timeoutSeconds: 1 }];
    const tools = await ProjectTools.open(project, settings);
    const result = await tools.runTests('suite', new AbortController().signal);
    assert.equal(result.passed, false); assert.equal(result.timedOut, true);
    assert.match(result.output, /started/);
    const children = JSON.parse(await readFile(pids, 'utf8')) as number[];
    await until(() => children.every(pid => !running(pid)), 3000);
    assert.equal(tools.tests[0].timedOut, true);
  } finally { await cleanup(); }
});

test('Stop cancels test process trees and blocks overlapping mutations until cleanup completes', async () => {
  const { root, project, settings, cleanup } = await fixture();
  const controller = new AbortController();
  let execution: Promise<TestExecution> | undefined;
  try {
    const { script, pids } = await longRunning(root);
    settings.testCommands = [{ id: 'suite', name: 'Stopped suite', command: command(script), timeoutSeconds: 20 }];
    const tools = await ProjectTools.open(project, settings);
    execution = tools.runTests('suite', controller.signal);
    void execution.catch(() => {});
    await until(async () => { try { await readFile(pids); return true; } catch { return false; } });
    await assert.rejects(() => tools.write('concurrent.ts', 'no'), /Another project edit or test is running/);
    controller.abort();
    await assert.rejects(execution, { name: 'AbortError' });
    const children = JSON.parse(await readFile(pids, 'utf8')) as number[];
    await until(() => children.every(pid => !running(pid)), 3000);
    assert.equal(tools.tests[0].passed, false); assert.equal(tools.tests[0].timedOut, false);
    await tools.write('after-stop.ts', 'cleanup complete');
  } finally { controller.abort(); await execution?.catch(() => {}); await cleanup(); }
});

test('a visit has a bounded real test execution budget', async () => {
  const { root, project, settings, cleanup } = await fixture();
  try {
    const script = path.join(root, 'fast.cjs');
    await writeFile(script, 'process.exit(0);');
    settings.testCommands = [{ id: 'suite', name: 'Fast suite', command: command(script), timeoutSeconds: 10 }];
    const tools = await ProjectTools.open(project, settings);
    for (let index = 0; index < 20; index++) assert.equal((await tools.runTests('suite', new AbortController().signal)).passed, true);
    await assert.rejects(() => tools.runTests('suite', new AbortController().signal), /20-test-command limit/);
    assert.equal(tools.tests.length, 1);
  } finally { await cleanup(); }
});
