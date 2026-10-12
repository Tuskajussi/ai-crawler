import path from 'node:path';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';

async function regularCopy(source: string, target: string, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<void> {
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) throw new Error('Legacy workspace contains an unsupported file. Existing data was preserved.');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { await copyFile(source, target, constants.COPYFILE_EXCL); await chmod(target, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

async function copyKnowledge(source: string, target: string): Promise<void> {
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Legacy knowledge must be a regular directory. Existing data was preserved.');
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name), targetEntry = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Legacy knowledge contains a symbolic link. Existing data was preserved.');
    if (entry.isDirectory() && /^source-[a-f0-9-]{36}$/.test(entry.name)) {
      await mkdir(targetEntry, { recursive: true, mode: 0o700 });
      for (const media of await readdir(sourceEntry, { withFileTypes: true })) {
        if (!media.isFile() || !/^chunk-(?:0|[1-9][0-9]{0,2})\.bin$/.test(media.name)) throw new Error('Legacy knowledge contains unsupported source artifacts. Existing data was preserved.');
        await regularCopy(path.join(sourceEntry, media.name), path.join(targetEntry, media.name));
      }
    } else if (entry.isFile() && ['index.json', 'index.json.bak'].includes(entry.name)) {
      await regularCopy(sourceEntry, targetEntry, 150 * 1024 * 1024);
    }
    // Expired preparation/temporary files are not durable library content.
  }
}

/** Copy the first owner's legacy data once; never overwrite, follow links, or delete originals. */
export async function migrateLegacyWorkspace(options: { statePath: string; directory: string; oldCredentialDirectory: string; credentialDirectory: string }): Promise<void> {
  const marker = path.join(options.directory, '.legacy-migration-complete');
  try { if ((await lstat(marker)).isFile()) return; throw new Error('Invalid legacy migration marker.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const legacyDirectory = path.dirname(options.statePath);
  if (path.resolve(options.statePath) !== path.resolve(options.directory, 'state.json')) {
    await regularCopy(options.statePath, path.join(options.directory, 'state.json'));
    await regularCopy(`${options.statePath}.bak`, path.join(options.directory, 'state.json.bak'));
    await regularCopy(path.join(legacyDirectory, 'reliability.json'), path.join(options.directory, 'reliability.json'), 32 * 1024 * 1024);
    await regularCopy(path.join(legacyDirectory, 'reliability.json.bak'), path.join(options.directory, 'reliability.json.bak'), 32 * 1024 * 1024);
    await copyKnowledge(path.join(legacyDirectory, 'knowledge'), path.join(options.directory, 'knowledge'));
    let screenshots: string[] = [];
    try { const metadata = await lstat(path.join(legacyDirectory, 'screenshots')); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid legacy screenshots directory.'); screenshots = await readdir(path.join(legacyDirectory, 'screenshots')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const file of screenshots) if (/^[a-f0-9-]{36}\.png$/.test(file)) await regularCopy(path.join(legacyDirectory, 'screenshots', file), path.join(options.directory, 'screenshots', file), 20 * 1024 * 1024);
  }
  if (path.resolve(options.oldCredentialDirectory) !== path.resolve(options.credentialDirectory)) {
    // Preserve the encrypted Windows envelope unchanged; no tokens are opened during migration.
    await regularCopy(path.join(options.oldCredentialDirectory, 'credentials.json'), path.join(options.credentialDirectory, 'credentials.json'), 2 * 1024 * 1024);
  }
  await writeFile(marker, '1\n', { flag: 'wx', mode: 0o600 });
}
