import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultChunkOptions } from '../shared/knowledge';
import type { ChunkOptions, KnowledgeChunk, KnowledgeModality } from '../shared/knowledge';
import { InputError } from './validation';
import { prepareKnowledgePdfPages } from './knowledge-pdf';

export interface PreparedChunk extends KnowledgeChunk { payload?: Buffer; }
export interface PreparedSource {
  name: string; modality: KnowledgeModality; bytes: number; chunks: PreparedChunk[];
  hash: string; dispose: () => Promise<void>;
}
export const knowledgeMediaLimits = Object.freeze({
  uploadBytes: 100 * 1024 * 1024, chunksPerSource: 100,
  chunkBytes: 12 * 1024 * 1024, preparedBytes: 256 * 1024 * 1024,
  textBytes: 7500, processingMs: 180_000,
});

const textTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml', 'application/json', 'application/xml', 'application/javascript']);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/heic', 'image/heif', 'image/avif']);
const audioTypes = new Set(['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'audio/webm']);
const videoTypes = new Set(['video/mp4', 'video/quicktime', 'video/mpeg', 'video/webm']);
const extensionTypes: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.webm': 'video/webm',
};

export function validateChunkOptions(input: Partial<ChunkOptions> = {}): ChunkOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(defaultChunkOptions, key))) throw new InputError('Unsupported chunk settings.');
  const options = { ...defaultChunkOptions, ...input };
  for (const [key, min, max, label] of [
    ['textCharacters', 200, 1800, 'Text chunk size'], ['textOverlap', 0, 400, 'Text overlap'],
    ['audioSeconds', 10, 170, 'Audio clip length'], ['videoSeconds', 10, 110, 'Video clip length'],
  ] as const) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new InputError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  if (options.textOverlap >= options.textCharacters) throw new InputError('Text overlap must be smaller than the chunk size.');
  return options;
}

function boundary(text: string, offset: number): number {
  if (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) return offset - 1;
  return offset;
}

/** Offsets refer to the decoded source's UTF-16 positions, with an exclusive end. */
export function chunkKnowledgeText(text: string, options: Partial<ChunkOptions> = {}): PreparedChunk[] {
  const settings = validateChunkOptions(options);
  if (!text.trim() || text.includes('\0')) throw new InputError('Choose a non-empty UTF-8 text file. Binary text is not supported.');
  const chunks: PreparedChunk[] = [];
  let start = 0;
  let startLine = 1;
  let partitions = 0;
  while (start < text.length) {
    if (++partitions > knowledgeMediaLimits.chunksPerSource) throw new InputError('This source needs more than 100 chunks. Split it into smaller files or increase the chunk size.');
    let end = boundary(text, Math.min(text.length, start + settings.textCharacters));
    // Prefer a paragraph/line break in the last third without making tiny chunks.
    if (end < text.length) {
      const minimum = start + Math.floor(settings.textCharacters * 2 / 3);
      const paragraph = text.lastIndexOf('\n\n', end - 2);
      const line = text.lastIndexOf('\n', end - 1);
      if (paragraph >= minimum) end = paragraph + 2;
      else if (line >= minimum) end = line + 1;
    }
    const content = text.slice(start, end);
    if (Buffer.byteLength(content, 'utf8') > knowledgeMediaLimits.textBytes) throw new InputError('A text chunk exceeds the embedding input limit. Reduce its size.');
    const endLine = startLine + (content.match(/\n/g)?.length ?? 0) - (content.endsWith('\n') ? 1 : 0);
    // Blank spans have no searchable content, and embedding APIs reject them.
    if (content.trim()) chunks.push({ id: randomUUID(), index: chunks.length, modality: 'text', mimeType: 'text/plain', text: content, preview: content.slice(0, 240), locator: { startChar: start, endChar: end, startLine, endLine } });
    if (end === text.length) break;
    const next = boundary(text, Math.max(start + 1, end - settings.textOverlap));
    startLine += (text.slice(start, next).match(/\n/g)?.length ?? 0);
    start = next;
  }
  return chunks;
}

function ascii(data: Buffer, start: number, end: number): string { return data.subarray(start, end).toString('ascii'); }
function isIsoMedia(data: Buffer): boolean { return data.length >= 12 && ascii(data, 4, 8) === 'ftyp'; }
function signatureMatches(data: Buffer, mime: string): boolean {
  if (mime === 'application/pdf') return ascii(data, 0, 5) === '%PDF-';
  if (mime === 'image/png') return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (mime === 'image/webp') return ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP';
  if (mime === 'image/bmp') return ascii(data, 0, 2) === 'BM';
  if (['image/heic', 'image/heif', 'image/avif'].includes(mime)) {
    const brands = ascii(data, 8, Math.min(data.length, 64));
    return isIsoMedia(data) && (mime === 'image/avif' ? /avif|avis/.test(brands) : /heic|heix|hevc|hevx|mif1|msf1/.test(brands));
  }
  if (['audio/mp3', 'audio/mpeg'].includes(mime)) return ascii(data, 0, 3) === 'ID3' || (data.length > 1 && data[0] === 255 && (data[1] & 0xe0) === 0xe0);
  if (['audio/wav', 'audio/x-wav'].includes(mime)) return ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WAVE';
  if (['audio/mp4', 'audio/x-m4a', 'video/mp4'].includes(mime)) return isIsoMedia(data);
  if (mime === 'video/quicktime') return isIsoMedia(data) || (data.length >= 8 && ['moov', 'mdat', 'wide'].includes(ascii(data, 4, 8)));
  if (mime === 'audio/flac') return ascii(data, 0, 4) === 'fLaC';
  if (mime === 'audio/ogg') return ascii(data, 0, 4) === 'OggS';
  if (['audio/webm', 'video/webm'].includes(mime)) return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'video/mpeg') return data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && [0xba, 0xb3].includes(data[3]);
  return false;
}

export function knowledgeTimeWindows(duration: number, seconds: number): { start: number; end: number }[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(seconds) || seconds <= 0) throw new InputError('Media must have a finite, positive duration.');
  let count = Math.ceil(duration / seconds);
  // Container timestamps may leave a sub-frame remainder after an exact clip
  // boundary. Keep it in the preceding clip instead of encoding an empty tail.
  if (count > 1 && duration - (count - 1) * seconds < 0.05) count--;
  if (count > knowledgeMediaLimits.chunksPerSource) throw new InputError('This media needs more than 100 chunks. Split it into shorter files.');
  return Array.from({ length: count }, (_, index) => ({ start: index * seconds, end: index === count - 1 ? duration : (index + 1) * seconds }));
}

/** No shell, network protocols, user-selected executables, or unbounded output. */
function command(binary: 'ffmpeg' | 'ffprobe', args: string[], signal: AbortSignal, deadline: number): Promise<string> {
  signal.throwIfAborted();
  if (Date.now() >= deadline) throw new InputError('Media preparation timed out. Choose a smaller file.');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new Error('Media preparation was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new InputError('Media preparation timed out. Choose a smaller file.')), Math.min(120_000, deadline - Date.now()));
    const collect = (list: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > 256 * 1024) stop(new InputError('Media inspection produced too much output.'));
      else list.push(data);
    };
    child.stdout.on('data', data => collect(stdout, data));
    child.stderr.on('data', data => collect(stderr, data));
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.once('error', error => {
      clean();
      reject((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new InputError('Audio, video, and image conversion requires FFmpeg and ffprobe on this machine. Install FFmpeg and restart Crawlspace.') : error);
    });
    child.once('close', code => {
      clean();
      if (failure) reject(failure);
      else if (code !== 0) reject(new InputError('The media could not be decoded. Choose a valid, supported audio or video file.'));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
    if (signal.aborted) abort();
  });
}

const mediaFormats = 'mov,mp4,m4a,3gp,3g2,mj2,mp3,wav,mpeg,mpegvideo,matroska,webm,flac,ogg';
async function inspectMedia(file: string, signal: AbortSignal, deadline: number) {
  const output = await command('ffprobe', ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-format_whitelist', mediaFormats, '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', file], signal, deadline);
  let info: { format?: { duration?: string }; streams?: { codec_type?: string; duration?: string }[] };
  try { info = JSON.parse(output); } catch { throw new InputError('The media duration could not be read.'); }
  if (!Array.isArray(info.streams)) throw new InputError('The media has no readable tracks.');
  const durations = [info.format?.duration, ...info.streams.map(stream => stream.duration)].map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (!durations.length) throw new InputError('Media must have a finite, positive duration.');
  const duration = Math.max(...durations);
  const trackDuration = (track: string) => {
    const value = Number(info.streams!.find(stream => stream.codec_type === track)?.duration);
    return Number.isFinite(value) && value > 0 ? value : duration;
  };
  return { duration, audioDuration: trackDuration('audio'), videoDuration: trackDuration('video'), audio: info.streams.some(stream => stream.codec_type === 'audio'), video: info.streams.some(stream => stream.codec_type === 'video') };
}

async function temporaryDirectory() {
  const root = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(root, 'crawlspace-embedding-'));
  let disposed = false;
  return { directory, dispose: async () => {
    if (disposed) return;
    const target = path.resolve(directory);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('crawlspace-embedding-')) throw new Error('Unsafe media cleanup target.');
    // The directory was created by this call, and cleanup never follows a replaced link.
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('Media temporary storage was replaced by a symbolic link.');
      await rm(target, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    disposed = true;
  } };
}

export async function prepareKnowledgeSource(input: { name: string; data: Buffer; mimeType: string; options?: Partial<ChunkOptions>; signal: AbortSignal }): Promise<PreparedSource> {
  input.signal.throwIfAborted();
  const options = validateChunkOptions(input.options);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\x00-\x1f\x7f]/.test(input.name)) throw new InputError('Source name must contain 1-200 characters without control characters.');
  if (!Buffer.isBuffer(input.data) || !input.data.length || input.data.length > knowledgeMediaLimits.uploadBytes) throw new InputError('Choose a non-empty source of at most 100 MiB.');
  if (typeof input.mimeType !== 'string' || input.mimeType.length > 100) throw new InputError('Choose a supported file type.');
  const name = input.name.trim();
  const selectedMime = input.mimeType.split(';')[0].trim().toLowerCase();
  const mime = (!selectedMime || selectedMime === 'application/octet-stream') ? extensionTypes[path.extname(name).toLowerCase()] || '' : selectedMime;
  const hash = createHash('sha256').update(input.data).digest('hex');
  const source = (modality: KnowledgeModality, chunks: PreparedChunk[], dispose: () => Promise<void> = async () => {}) => ({ name, modality, bytes: input.data.length, chunks, hash, dispose });
  if (textTypes.has(mime)) {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.data); } catch { throw new InputError('Text sources must use UTF-8 encoding.'); }
    return source('text', chunkKnowledgeText(text, options));
  }
  if (![...imageTypes, ...audioTypes, ...videoTypes, 'application/pdf'].includes(mime)) throw new InputError('Choose text, PDF, PNG/JPEG/WebP/BMP/HEIF/AVIF, MP3/WAV/M4A/FLAC/OGG, or MP4/MOV/MPEG/WebM media.');
  if (!signatureMatches(input.data, mime)) throw new InputError('The file contents do not match its selected type.');
  let preparedBytes = 0;
  const chunks: PreparedChunk[] = [];
  const add = (chunk: Omit<PreparedChunk, 'id' | 'index'>) => {
    input.signal.throwIfAborted();
    if (chunk.payload && chunk.payload.length > knowledgeMediaLimits.chunkBytes) throw new InputError('A prepared chunk exceeds 12 MiB. Use a smaller image or reduce the clip length.');
    preparedBytes += chunk.payload?.length ?? 0;
    if (preparedBytes > knowledgeMediaLimits.preparedBytes || chunks.length >= knowledgeMediaLimits.chunksPerSource) throw new InputError('This source exceeds the prepared storage or 100-chunk limit. Split it into smaller files.');
    chunks.push({ ...chunk, id: randomUUID(), index: chunks.length });
  };
  const deadline = Date.now() + knowledgeMediaLimits.processingMs;
  if (imageTypes.has(mime)) {
    if (mime === 'image/png' || mime === 'image/jpeg') {
      add({ modality: 'image', mimeType: mime, payload: input.data, preview: 'Image', locator: {} });
    } else {
      // PNG/JPEG work on both native Google embedding APIs; other input formats
      // are decoded locally and never sent using an unsupported provider MIME.
      const temporary = await temporaryDirectory();
      try {
        const original = path.join(temporary.directory, 'image-source');
        const converted = path.join(temporary.directory, 'image.png');
        await writeFile(original, input.data, { flag: 'wx' });
        await command('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'webp_pipe,bmp_pipe,mov,mp4,m4a,3gp,3g2,mj2', '-threads', '2', '-i', original, '-frames:v', '1', '-c:v', 'png', '-threads', '2', '-f', 'image2', '-update', '1', '-fs', String(knowledgeMediaLimits.chunkBytes), '-y', converted], input.signal, deadline);
        if ((await stat(converted)).size >= knowledgeMediaLimits.chunkBytes) throw new InputError('The converted image exceeds 12 MiB. Resize it before importing.');
        const payload = await readFile(converted);
        if (!signatureMatches(payload, 'image/png')) throw new InputError('The image could not be converted to PNG.');
        add({ modality: 'image', mimeType: 'image/png', payload, preview: 'Image', locator: {} });
      } finally { await temporary.dispose(); }
    }
    return source('image', chunks);
  }
  if (mime === 'application/pdf') {
    const pages = await prepareKnowledgePdfPages(input.data, input.signal, Math.max(1, deadline - Date.now()));
    for (const page of pages) add({ modality: 'pdf', mimeType: 'application/pdf', payload: page.payload, preview: `Page ${page.page}`, locator: { pageStart: page.page, pageEnd: page.page } });
    return source('pdf', chunks);
  }
  const temporary = await temporaryDirectory();
  try {
    const inputFile = path.join(temporary.directory, 'source');
    await writeFile(inputFile, input.data, { flag: 'wx' });
    const info = await inspectMedia(inputFile, input.signal, deadline);
    const modality = videoTypes.has(mime) ? 'video' : 'audio';
    if (modality === 'video' ? !info.video : !info.audio) throw new InputError(`The selected file has no ${modality} track.`);
    const plans = [
      ...(modality === 'video' ? knowledgeTimeWindows(info.videoDuration, options.videoSeconds).map(window => ({ ...window, track: 'video' as const })) : []),
      ...(info.audio ? knowledgeTimeWindows(info.audioDuration, options.audioSeconds).map(window => ({ ...window, track: 'audio' as const })) : []),
    ];
    if (plans.length > knowledgeMediaLimits.chunksPerSource) throw new InputError('This source needs more than 100 audio and video chunks. Split it into shorter files.');
    for (const plan of plans) {
      input.signal.throwIfAborted();
      const output = path.join(temporary.directory, `chunk-${chunks.length}.${plan.track === 'audio' ? 'wav' : 'mp4'}`);
      const encoding = plan.track === 'audio'
        ? ['-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav']
        : ['-map', '0:v:0', '-an', '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-r', '24', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '650k', '-bufsize', '1300k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4'];
      await command('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-format_whitelist', mediaFormats, '-threads', '2', '-ss', String(plan.start), '-i', inputFile, '-t', String(plan.end - plan.start), ...encoding, '-threads', '2', '-fs', String(knowledgeMediaLimits.chunkBytes), '-y', output], input.signal, deadline);
      const size = (await stat(output)).size;
      if (!size || size >= knowledgeMediaLimits.chunkBytes) throw new InputError('A media chunk reached its size limit. Reduce the clip length.');
      const outputInfo = await inspectMedia(output, input.signal, deadline);
      const maximum = plan.track === 'audio' ? 180 : 120;
      if (outputInfo.duration > maximum || outputInfo.duration < plan.end - plan.start - 1) throw new InputError('The prepared clip did not preserve the requested time range. Reduce the clip length.');
      add({ modality: plan.track, mimeType: plan.track === 'audio' ? 'audio/wav' : 'video/mp4', payload: await readFile(output), preview: `${plan.track === 'audio' ? 'Audio' : 'Video'} ${plan.start.toFixed(1)}-${plan.end.toFixed(1)} seconds`, locator: { startSeconds: plan.start, endSeconds: plan.end, track: plan.track } });
    }
    await temporary.dispose();
    return source(modality, chunks);
  } catch (error) {
    await temporary.dispose();
    throw error;
  }
}
