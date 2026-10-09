import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { initialState } from '../shared/defaults';
import { AuthStore } from './auth';
import { readServerConfig } from './config';
import { createApp } from './index';
import { Workspaces } from './workspaces';

const SECRET = 'workspace-migration-test-registration-secret-with-entropy';
const PASSWORD = 'a long workspace test account password';

async function withTemporaryData(run: (dataDir: string) => Promise<void>): Promise<void> {
  const temporaryParent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryParent, 'crawlspace-workspaces-'));
  try {
    await run(path.join(directory, 'data'));
  } finally {
    const target = await realpath(directory);
    const relative = path.relative(temporaryParent, target);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith('crawlspace-workspaces-'));
    await rm(target, { recursive: true, force: true });
  }
}

test('only the first registered account inherits the preserved legacy workspace and screenshots', async () => {
  await withTemporaryData(async dataDir => {
    const legacy = structuredClone(initialState);
    legacy.workflow.name = 'Existing local crawler workspace';
    legacy.messages = [{ id: randomUUID(), from: 'you', to: 'all', text: 'Private assignment from before account support.', type: 'message', createdAt: new Date().toISOString() }];
    const legacyText = JSON.stringify(legacy, null, 2);
    const screenshotName = `${randomUUID()}.png`;
    const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGJ0AAAAASUVORK5CYII=', 'base64');
    const legacyScreenshots = path.join(dataDir, 'screenshots');
    await mkdir(legacyScreenshots, { recursive: true });
    await writeFile(path.join(dataDir, 'state.json'), legacyText);
    await writeFile(path.join(legacyScreenshots, screenshotName), screenshot);
    await writeFile(path.join(legacyScreenshots, 'unrelated-private-file.txt'), 'This file is not screenshot evidence.');
    const auth = await AuthStore.open(path.join(dataDir, 'auth.json'), { registrationSecret: SECRET });
    const first = await auth.register('first-owner', PASSWORD, SECRET);
    const second = await auth.register('second-owner', PASSWORD, SECRET);
    assert.equal(auth.firstUserId, first.user.id);
    const config = readServerConfig({}, { dataDir, registrationSecret: SECRET });
    const workspaces = new Workspaces(config, auth);
    let reopened: Workspaces | undefined;
    try {
      const openingA = workspaces.get(first.user.id);
      const openingB = workspaces.get(first.user.id);
      const openingC = workspaces.get(first.user.id);
      assert.equal(openingA, openingB, 'Concurrent requests must reuse one account initialization.');
      const [owner, sameOwner, sameOwnerAgain, other] = await Promise.all([openingA, openingB, openingC, workspaces.get(second.user.id)]);
      assert.equal(owner, sameOwner);
      assert.equal(owner, sameOwnerAgain);
      assert.notEqual(owner.directory, other.directory);
      assert.notEqual(owner.projectsRoot, other.projectsRoot);
      assert.equal(owner.store.get().workflow.name, legacy.workflow.name);
      assert.deepEqual(owner.store.get().messages, legacy.messages);
      assert.deepEqual(await readFile(path.join(owner.directory, 'screenshots', screenshotName)), screenshot);
      await assert.rejects(readFile(path.join(owner.directory, 'screenshots', 'unrelated-private-file.txt')), { code: 'ENOENT' });
      assert.equal(other.store.get().workflow.name, initialState.workflow.name);
      assert.ok(!other.store.get().messages.some(message => message.text === legacy.messages[0].text));
      await assert.rejects(readFile(path.join(other.directory, 'screenshots', screenshotName)), { code: 'ENOENT' });
      assert.equal(workspaces.state(owner).workspace?.projectsRoot, owner.projectsRoot);
      assert.equal(workspaces.state(other).workspace?.projectsRoot, other.projectsRoot);
      assert.equal(await readFile(path.join(dataDir, 'state.json'), 'utf8'), legacyText);
      assert.deepEqual(await readFile(path.join(legacyScreenshots, screenshotName)), screenshot);
      assert.equal(await readFile(path.join(legacyScreenshots, 'unrelated-private-file.txt'), 'utf8'), 'This file is not screenshot evidence.');

      await owner.store.update(state => {
        state.workflow.name = 'Owner edited after migration';
        state.messages.push({ id: randomUUID(), from: 'you', to: 'all', text: 'New private assignment after migration.', type: 'message', createdAt: new Date().toISOString() });
      });
      const updatedEvidence = Buffer.concat([screenshot, Buffer.from('private updated evidence')]);
      await writeFile(path.join(owner.directory, 'screenshots', screenshotName), updatedEvidence);
      await workspaces.shutdown();
      reopened = new Workspaces(config, auth);
      const reopenedOwner = await reopened.get(first.user.id);
      assert.equal(reopenedOwner.store.get().workflow.name, 'Owner edited after migration');
      assert.ok(reopenedOwner.store.get().messages.some(message => message.text === 'New private assignment after migration.'));
      assert.deepEqual(await readFile(path.join(reopenedOwner.directory, 'screenshots', screenshotName)), updatedEvidence);
      assert.equal(await readFile(path.join(dataDir, 'state.json'), 'utf8'), legacyText);
      assert.deepEqual(await readFile(path.join(legacyScreenshots, screenshotName)), screenshot);
    } finally {
      await workspaces.shutdown();
      await reopened?.shutdown();
    }
  });
});

test('the Pi run API rejects another account project before starting an engine', async () => {
  await withTemporaryData(async dataDir => {
    const instance = await createApp({ dataDir, registrationSecret: SECRET, config: { hosted: false } });
    const server = instance.app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const first = await instance.auth.register('first-owner', PASSWORD, SECRET);
      const second = await instance.auth.register('second-owner', PASSWORD, SECRET);
      const [owner, other] = await Promise.all([instance.workspaces.get(first.user.id), instance.workspaces.get(second.user.id)]);
      const privateProject = path.join(other.projectsRoot, 'private-repository');
      await mkdir(privateProject, { recursive: true });
      await writeFile(path.join(privateProject, 'source.ts'), 'export const privateValue = 42;');
      // Simulate a previously saved workflow; execution must still recheck access.
      await owner.store.update(state => { state.workflow.settings.projectPath = privateProject; });
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `crawlspace_session=${first.token}`, 'X-CSRF-Token': first.csrfToken },
        body: JSON.stringify({ mode: 'pi' }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /private projects folder/);
      assert.equal(owner.engine.isRunning, false);
      assert.equal(owner.store.get().runs.length, 0);
      assert.ok(owner.store.get().workflow.nodes.every(node => node.data.status === 'idle'));
      assert.equal(await readFile(path.join(privateProject, 'source.ts'), 'utf8'), 'export const privateValue = 42;');
    } finally {
      try { await instance.shutdown(); }
      finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
  });
});
