import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { InputError } from './validation';

const binaryLimit = 12 * 1024 * 1024;

/** Check every existing component before creating storage; Windows junctions are links too. */
async function directoryComponents(directory: string, create: boolean): Promise<void> {
  const root = path.parse(directory).root;
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Never use recursive mkdir through an unchecked parent directory.
      try { await mkdir(current, { mode: 0o700 }); }
      catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new InputError('Knowledge storage must use real directories without symbolic links or junctions.');
  }
  const canonical = await realpath(directory);
  if (path.relative(directory, canonical) !== '') throw new InputError('Knowledge storage resolves outside its managed directory.');
}

export async function ensureKnowledgeDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await directoryComponents(absolute, true);
  // Re-check after creation in case an intermediate path changed.
  await directoryComponents(absolute, false);
  return absolute;
}

/** Read only one app-created regular media file, with a hard allocation/read bound. */
export async function readKnowledgeBinary(directory: string, sourceId: string, mediaFile: string): Promise<Buffer> {
  if (!/^[a-f0-9-]{36}$/.test(sourceId) || !/^chunk-[0-9]+\.bin$/.test(mediaFile)) throw new InputError('Invalid stored knowledge content path.');
  const root = path.resolve(directory);
  await directoryComponents(root, false);
  const source = path.join(root, `source-${sourceId}`);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory() || path.dirname(await realpath(source)) !== root) throw new InputError('Stored knowledge sources must remain within their managed directory without links.');
  const file = path.join(source, mediaFile);
  const original = await lstat(file);
  if (original.isSymbolicLink() || !original.isFile() || path.dirname(await realpath(file)) !== source) throw new InputError('Stored knowledge content must be a regular file without links.');
  if (original.size < 1 || original.size > binaryLimit) throw new InputError('Stored knowledge content exceeds the 12 MiB limit or is empty.');
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > binaryLimit || opened.dev !== original.dev || opened.ino !== original.ino) throw new InputError('Stored knowledge content changed or exceeds the 12 MiB limit.');
    // Inspect the path again after opening, before reading from the handle.
    const current = await lstat(file);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino || path.dirname(await realpath(file)) !== source) throw new InputError('Stored knowledge content changed while opening it.');
    await directoryComponents(root, false);
    const currentSource = await lstat(source);
    if (currentSource.isSymbolicLink() || !currentSource.isDirectory() || path.dirname(await realpath(source)) !== root) throw new InputError('Stored knowledge source changed while opening its content.');
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    if (extra.bytesRead || offset !== opened.size || after.size !== opened.size) throw new InputError('Stored knowledge content changed while reading it.');
    return buffer;
  } finally { await handle.close(); }
}
