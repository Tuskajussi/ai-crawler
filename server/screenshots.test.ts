import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pruneScreenshots, saveScreenshot } from './screenshots';

test('retention bounds unreferenced captures while preserving evidence and unrelated files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-images-'));
  try {
    const protectedName = `${randomUUID()}.png`;
    const oldName = `${randomUUID()}.png`;
    const recentName = `${randomUUID()}.png`;
    for (const name of [protectedName, oldName, recentName, 'unrelated.png']) await writeFile(path.join(directory, name), 'image');
    for (const name of [protectedName, oldName]) await utimes(path.join(directory, name), 1, 1);
    const result = await pruneScreenshots(directory, [`/api/screenshots/${protectedName}`], { maxFiles: 3 });
    assert.equal(result.removed, 1);
    assert.equal(result.full, false);
    await assert.rejects(readFile(path.join(directory, oldName)), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(directory, protectedName), 'utf8'), 'image');
    assert.equal(await readFile(path.join(directory, 'unrelated.png'), 'utf8'), 'image');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('full retained storage is reported instead of destroying referenced evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-images-'));
  try {
    const name = `${randomUUID()}.png`;
    await writeFile(path.join(directory, name), 'image');
    const result = await pruneScreenshots(directory, [`/api/screenshots/${name}`], { maxFiles: 1 });
    assert.equal(result.full, true);
    assert.equal(result.removed, 0);
    assert.equal(await readFile(path.join(directory, name), 'utf8'), 'image');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('parallel captures reserve capacity and publish evidence before the next capture', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-images-parallel-'));
  try {
    const references: string[] = [];
    const capture = () => saveScreenshot(directory, Buffer.from('image'), () => references, url => { references.push(url); }, { maxFiles: 1, maxBytes: 5 });
    const results = await Promise.allSettled([capture(), capture()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(failure.reason.message, /full of retained evidence/);
    assert.equal((await readdir(directory)).length, 1);
    assert.equal(await readFile(path.join(directory, references[0].split('/').at(-1)!), 'utf8'), 'image');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent pruning is serialized and never removes the same capture twice', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-images-prune-'));
  try {
    const name = `${randomUUID()}.png`;
    await writeFile(path.join(directory, name), 'image');
    await utimes(path.join(directory, name), 1, 1);
    const results = await Promise.all([pruneScreenshots(directory, []), pruneScreenshots(directory, [])]);
    assert.equal(results.reduce((total, result) => total + result.removed, 0), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
