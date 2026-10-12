import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ChunkLocator, EmbeddingConfig, KnowledgeChunk, KnowledgeSource } from '../shared/knowledge';
import { defaultEmbeddingConfig } from '../shared/knowledge';
import { validateEmbeddingConfig } from './embedding-provider';
import { ensureKnowledgeDirectory } from './knowledge-files';

export interface StoredKnowledgeChunk extends KnowledgeChunk { vector: number[]; mediaFile?: string }
export interface StoredKnowledgeSource extends Omit<KnowledgeSource, 'compatible'> {
  hash: string; storedBytes: number; chunks: StoredKnowledgeChunk[];
}
interface KnowledgeData { version: 1; config: EmbeddingConfig; sources: StoredKnowledgeSource[] }
export const knowledgeLimits = { uploadBytes: 100 * 1024 * 1024, chunksPerSource: 100, totalChunks: 1000, sources: 100 };
export const knowledgeStorageBytes = 1024 * 1024 * 1024;
const maxIndexBytes = 128 * 1024 * 1024;
export const sourceDirectoryName = (id: string) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid knowledge source ID.');
  return `source-${id}`;
};

function fields(value: unknown, allowed: string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validLocator(chunk: KnowledgeChunk): boolean {
  const locator = chunk.locator;
  const permitted = chunk.modality === 'text' ? ['startChar', 'endChar', 'startLine', 'endLine']
    : chunk.modality === 'pdf' ? ['pageStart', 'pageEnd']
    : chunk.modality === 'image' ? [] : ['startSeconds', 'endSeconds', 'track'];
  if (!fields(locator, permitted)) return false;
  for (const [start, end, minimum, integer] of [
    ['startChar', 'endChar', 0, true], ['startLine', 'endLine', 1, true],
    ['pageStart', 'pageEnd', 1, true], ['startSeconds', 'endSeconds', 0, false],
  ] as const) {
    const first = locator[start as keyof ChunkLocator]; const last = locator[end as keyof ChunkLocator];
    if (first === undefined && last === undefined) continue;
    if (typeof first !== 'number' || typeof last !== 'number' || !Number.isFinite(first) || !Number.isFinite(last)
      || (integer && (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))) || first < minimum || last < first
      || ((start === 'startChar' || start === 'startSeconds') && last === first)) return false;
  }
  if (chunk.modality === 'pdf') return locator.pageStart !== undefined;
  if (chunk.modality === 'audio' || chunk.modality === 'video') return locator.startSeconds !== undefined && locator.track === chunk.modality;
  return true;
}

function validMime(chunk: KnowledgeChunk): boolean {
  return ({ text: ['text/plain'], pdf: ['application/pdf'], image: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/avif'],
    audio: ['audio/wav', 'audio/mpeg'], video: ['video/mp4'] } as Record<string, string[]>)[chunk.modality]?.includes(chunk.mimeType) ?? false;
}

function validated(input: unknown): KnowledgeData {
  const data = input as KnowledgeData;
  if (!fields(data, ['version', 'config', 'sources']) || data.version !== 1) throw new Error('Invalid knowledge index version.');
  validateEmbeddingConfig(data.config);
  if (!Array.isArray(data.sources) || data.sources.length > knowledgeLimits.sources) throw new Error('Invalid knowledge sources.');
  const ids = new Set<string>();
  let totalChunks = 0;
  let storageBytes = 0;
  for (const source of data.sources) {
    if (!fields(source, ['id', 'name', 'modality', 'bytes', 'storedBytes', 'chunkCount', 'dimensions', 'modelId', 'spaceKey', 'hash', 'createdAt', 'chunks'])) throw new Error('Invalid knowledge source metadata.');
    sourceDirectoryName(source.id);
    if (ids.has(source.id)) throw new Error('Duplicate knowledge source.');
    ids.add(source.id);
    if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 200 || /[\x00-\x1f\x7f]/.test(source.name)
      || !['text', 'pdf', 'image', 'audio', 'video'].includes(source.modality)
      || !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > knowledgeLimits.uploadBytes
      || !Number.isSafeInteger(source.storedBytes) || source.storedBytes < 0
      || !Number.isInteger(source.dimensions) || source.dimensions < 1 || source.dimensions > 8192
      || typeof source.modelId !== 'string' || !source.modelId || source.modelId.length > 300
      || !/^[a-f0-9]{64}$/.test(source.spaceKey) || !/^[a-f0-9]{64}$/.test(source.hash)
      || typeof source.createdAt !== 'string' || !Number.isFinite(Date.parse(source.createdAt))
      || !Array.isArray(source.chunks) || !source.chunks.length || source.chunks.length > knowledgeLimits.chunksPerSource
      || source.chunkCount !== source.chunks.length) throw new Error('Invalid knowledge source metadata.');
    totalChunks += source.chunkCount;
    storageBytes += source.storedBytes;
    const chunkIds = new Set<string>();
    const chunkIndices = new Set<number>();
    for (const chunk of source.chunks) {
      if (!fields(chunk, ['id', 'index', 'modality', 'mimeType', 'text', 'preview', 'locator', 'vector', 'mediaFile'])
        || typeof chunk.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(chunk.id) || chunkIds.has(chunk.id)
        || !Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= source.chunkCount || chunkIndices.has(chunk.index)
        || !['text', 'pdf', 'image', 'audio', 'video'].includes(chunk.modality)
        || (source.modality === 'video' ? !['audio', 'video'].includes(chunk.modality) : source.modality !== chunk.modality)
        || !validMime(chunk)
        || typeof chunk.preview !== 'string' || chunk.preview.length > 4000
        || (chunk.text !== undefined && (typeof chunk.text !== 'string' || Buffer.byteLength(chunk.text, 'utf8') > 7500))
        || !validLocator(chunk)
        || !Array.isArray(chunk.vector) || chunk.vector.length !== source.dimensions
        || chunk.vector.some(value => typeof value !== 'number' || !Number.isFinite(value))
        || !chunk.vector.some(value => value !== 0)
        || Math.abs(Math.hypot(...chunk.vector) - 1) > 0.000001
        || (chunk.modality === 'text' ? typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.mediaFile !== undefined : chunk.mediaFile === undefined || chunk.text !== undefined)
        || (chunk.mediaFile !== undefined && chunk.mediaFile !== `chunk-${chunk.index}.bin`)) throw new Error('Invalid knowledge chunk.');
      chunkIds.add(chunk.id);
      chunkIndices.add(chunk.index);
    }
  }
  if (totalChunks > knowledgeLimits.totalChunks || storageBytes > knowledgeStorageBytes) throw new Error('Knowledge storage limit exceeded.');
  return data;
}

async function readIndex(file: string): Promise<KnowledgeData> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Knowledge indexes must be regular local files.');
  if (info.size > maxIndexBytes) throw new Error('Knowledge index exceeds its storage allowance.');
  const raw = await readFile(file, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > maxIndexBytes) throw new Error('Knowledge index exceeds its storage allowance.');
  return validated(JSON.parse(raw));
}

async function atomicWrite(file: string, text: string): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') > maxIndexBytes) throw new Error('Knowledge index exceeds its storage allowance.');
  const temporary = `${file}.tmp`;
  try {
    const info = await lstat(temporary);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Knowledge temporary indexes must be regular local files.');
    await unlink(temporary);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}

/** Separate bounded storage keeps vectors and media out of workflow polling and exports. */
export class KnowledgeStore {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: string, private data: KnowledgeData) {}
  static async open(directory: string): Promise<KnowledgeStore> {
    directory = await ensureKnowledgeDirectory(directory);
    const file = path.join(directory, 'index.json');
    let data: KnowledgeData;
    try { data = await readIndex(file); }
    catch (error) {
      try { data = await readIndex(`${file}.bak`); }
      catch (backupError) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (backupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('The knowledge index and its backup could not be validated. Restore a valid index before restarting.');
        }
        data = { version: 1, config: { ...defaultEmbeddingConfig }, sources: [] };
      }
    }
    return new KnowledgeStore(path.resolve(directory), data);
  }
  snapshot(): KnowledgeData { return structuredClone(this.data); }
  summary() {
    return { config: { ...this.data.config }, sources: this.data.sources.map(({ chunks: _chunks, ...source }) => ({ ...source })) };
  }
  async update(mutate: (data: KnowledgeData) => void, options: { mirrorBackup?: boolean } = {}): Promise<void> {
    const task = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.data);
      mutate(next);
      validated(next);
      await ensureKnowledgeDirectory(this.directory);
      const file = path.join(this.directory, 'index.json');
      // Preserve a valid recovered backup instead of backing up a corrupt primary.
      await atomicWrite(`${file}.bak`, JSON.stringify(options.mirrorBackup ? next : this.data));
      await atomicWrite(file, JSON.stringify(next));
      this.data = next;
    });
    this.queue = task;
    await task;
  }
  async flush(): Promise<void> { await this.queue; }
}
