import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureKnowledgeDirectory, readKnowledgeBinary } from './knowledge-files';

async function fixture() {
  // Resolve any OS-owned temp alias (for example /var on macOS) before testing managed paths.
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'crawlspace-knowledge-files-'));
  return { directory, root: path.join(directory, 'knowledge'), close: async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  } };
}

test('knowledge storage creates real directories and downloads exact bounded binary content', async () => {
  const context = await fixture();
  try {
    assert.equal(await ensureKnowledgeDirectory(context.root), context.root);
    assert.equal(await ensureKnowledgeDirectory(context.root), context.root);
    const id = randomUUID();
    await mkdir(path.join(context.root, `source-${id}`));
    const bytes = Buffer.from([0, 1, 255, 2]);
    await writeFile(path.join(context.root, `source-${id}`, 'chunk-0.bin'), bytes);
    assert.deepEqual(await readKnowledgeBinary(context.root, id, 'chunk-0.bin'), bytes);
    await assert.rejects(readKnowledgeBinary(context.root, id, 'chunk-1.bin'), { code: 'ENOENT' });
    await assert.rejects(readKnowledgeBinary(context.root, randomUUID(), 'chunk-0.bin'), { code: 'ENOENT' });
  } finally { await context.close(); }
});

test('storage refuses a file root, linked root, or linked parent before creating children', async () => {
  const context = await fixture();
  try {
    const file = path.join(context.directory, 'file');
    await writeFile(file, 'ordinary file');
    await assert.rejects(ensureKnowledgeDirectory(file), /real directories/);
    const outside = path.join(context.directory, 'outside');
    const linked = path.join(context.directory, 'linked');
    await mkdir(outside);
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(ensureKnowledgeDirectory(linked), /symbolic links or junctions/);
    await assert.rejects(ensureKnowledgeDirectory(path.join(linked, 'child')), /symbolic links or junctions/);
    await assert.rejects(readFile(path.join(outside, 'child')), { code: 'ENOENT' });
  } finally { await context.close(); }
});

test('binary content refuses traversal, linked source directories, non-files, and oversized files', async () => {
  const context = await fixture();
  try {
    await ensureKnowledgeDirectory(context.root);
    const id = randomUUID();
    const outside = path.join(context.directory, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'chunk-0.bin'), 'secret outside content');
    const source = path.join(context.root, `source-${id}`);
    await symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readKnowledgeBinary(context.root, id, 'chunk-0.bin'), /without links/);
    await rm(source);
    await mkdir(source);
    await mkdir(path.join(source, 'chunk-0.bin'));
    await assert.rejects(readKnowledgeBinary(context.root, id, 'chunk-0.bin'), /regular file/);
    const huge = path.join(source, 'chunk-1.bin');
    await writeFile(huge, 'small');
    await truncate(huge, 12 * 1024 * 1024 + 1);
    await assert.rejects(readKnowledgeBinary(context.root, id, 'chunk-1.bin'), /12 MiB/);
    await writeFile(path.join(source, 'chunk-2.bin'), Buffer.alloc(0));
    await assert.rejects(readKnowledgeBinary(context.root, id, 'chunk-2.bin'), /empty/);
    await assert.rejects(readKnowledgeBinary(context.root, '../outside', 'chunk-0.bin'), /Invalid stored/);
    await assert.rejects(readKnowledgeBinary(context.root, id, '../outside'), /Invalid stored/);
  } finally { await context.close(); }
});

test('binary content refuses a linked file when file symlinks are available', async t => {
  const context = await fixture();
  try {
    await ensureKnowledgeDirectory(context.root);
    const id = randomUUID();
    const source = path.join(context.root, `source-${id}`);
    const outside = path.join(context.directory, 'outside.bin');
    await mkdir(source);
    await writeFile(outside, 'outside content');
    try { await symlink(outside, path.join(source, 'chunk-0.bin'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Windows file symlink permission is unavailable; junction checks run separately.'); return; }
      throw error;
    }
    await assert.rejects(readKnowledgeBinary(context.root, id, 'chunk-0.bin'), /regular file without links/);
  } finally { await context.close(); }
});
