import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentExecutionError } from './execution-errors';

const screenshotName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;
export interface ScreenshotLimits { maxFiles?: number; maxBytes?: number; maxAgeMs?: number; now?: number; }
const pending = new Map<string, Promise<unknown>>();

function serialize<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory);
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  pending.set(key, result);
  void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => {});
  return result;
}

/** Remove only app-created, unreferenced images; never follow a directory symlink. */
export function pruneScreenshots(directory: string, references: string[], limits: ScreenshotLimits = {}) {
  return serialize(directory, () => prune(directory, references, limits));
}

/** Check capacity, write, and publish the reference together, including parallel Code Mode captures. */
export function saveScreenshot(directory: string, buffer: Buffer, references: () => string[], onSaved: (url: string) => void, limits: ScreenshotLimits = {}): Promise<string> {
  return serialize(directory, async () => {
    await mkdir(directory, { recursive: true });
    const storage = await prune(directory, references(), limits, buffer.length);
    if (storage.full) throw new AgentExecutionError('Screenshot storage is full of retained evidence. Review stored findings and free screenshot capacity before retrying.', 'configuration');
    const filename = `${randomUUID()}.png`;
    await writeFile(path.join(directory, filename), buffer, { flag: 'wx' });
    const url = `/api/screenshots/${filename}`;
    onSaved(url);
    return url;
  });
}

async function prune(directory: string, references: string[], limits: ScreenshotLimits, reserveBytes = 8 * 1024 * 1024) {
  const maxFiles = limits.maxFiles ?? 200;
  const maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
  const maxAgeMs = limits.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = limits.now ?? Date.now();
  let entries;
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Screenshot storage must not be a symbolic link.');
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { full: false, files: 0, bytes: 0, removed: 0 };
    throw error;
  }
  const protectedNames = new Set(references.filter(url => url.startsWith('/api/screenshots/')).map(url => url.slice('/api/screenshots/'.length)).filter(name => screenshotName.test(name)));
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !screenshotName.test(entry.name)) continue;
    const info = await lstat(path.join(directory, entry.name));
    if (info.isFile() && !info.isSymbolicLink()) files.push({ name: entry.name, size: info.size, time: info.mtimeMs });
  }
  files.sort((a, b) => a.time - b.time);
  let count = files.length;
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;
  for (const file of files) {
    if (protectedNames.has(file.name)) continue;
    // Reserve space for one maximum-size viewport capture before writing it.
    if (count < maxFiles && bytes + reserveBytes <= maxBytes && now - file.time <= maxAgeMs) continue;
    await unlink(path.join(directory, file.name));
    count--;
    bytes -= file.size;
    removed++;
  }
  return { full: count >= maxFiles || bytes + reserveBytes > maxBytes, files: count, bytes, removed };
}
