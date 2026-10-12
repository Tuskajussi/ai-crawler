import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument, PDFName } from 'pdf-lib';
import { chunkKnowledgeText, knowledgeMediaLimits, knowledgeTimeWindows, prepareKnowledgeSource, validateChunkOptions } from './knowledge-media';

const run = promisify(execFile);
const signal = () => new AbortController().signal;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const prepare = (data: Buffer, name = 'source.txt', mimeType = 'text/plain') => prepareKnowledgeSource({ name, mimeType, data, signal: signal() });

test('text chunks preserve exact source, Unicode boundaries, overlap, and line provenance', () => {
  const text = 'First line\n' + ('A🙂B\n'.repeat(240)) + '\nLast line';
  const chunks = chunkKnowledgeText(text, { textCharacters: 200, textOverlap: 25 });
  assert.ok(chunks.length > 2);
  let covered = 0;
  for (const chunk of chunks) {
    const start = chunk.locator.startChar!;
    const end = chunk.locator.endChar!;
    assert.ok(start <= covered);
    assert.equal(chunk.text, text.slice(start, end));
    assert.ok(chunk.text!.length <= 200);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text!));
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text!));
    assert.equal(chunk.locator.startLine, text.slice(0, start).split('\n').length);
    assert.equal(chunk.locator.endLine, text.slice(0, end - (text[end - 1] === '\n' ? 1 : 0)).split('\n').length);
    covered = Math.max(covered, end);
  }
  assert.equal(covered, text.length);
  assert.equal(chunks[0].locator.startChar, 0);
  assert.equal(chunks.at(-1)!.locator.endChar, text.length);
  const contiguous = chunkKnowledgeText(text, { textCharacters: 200, textOverlap: 0 });
  assert.equal(contiguous.map(chunk => chunk.text).join(''), text);
});

test('text splitting does not exceed its budget at paragraph boundaries and rejects excess chunks', () => {
  const edge = 'x'.repeat(199) + '\n\n' + 'y'.repeat(210);
  assert.ok(chunkKnowledgeText(edge, { textCharacters: 200, textOverlap: 0 }).every(chunk => chunk.text!.length <= 200));
  assert.throws(() => chunkKnowledgeText('x'.repeat(20001), { textCharacters: 200, textOverlap: 0 }), /100 chunks/);
  assert.throws(() => chunkKnowledgeText('  \n '), /non-empty/);
  assert.throws(() => chunkKnowledgeText('hello\0world'), /Binary text/);
  const blankSections = chunkKnowledgeText('hello' + ' '.repeat(4000) + '\nworld', { textCharacters: 200, textOverlap: 0 });
  assert.equal(blankSections.length, 2);
  assert.ok(blankSections.every(chunk => chunk.text!.trim()));
  assert.equal(blankSections[1].locator.endChar, 4011);
  for (const input of [{ textCharacters: 1801 }, { textCharacters: 199 }, { textOverlap: 200, textCharacters: 200 }, { audioSeconds: 171 }, { videoSeconds: 111 }, { audioSeconds: NaN }, { unknown: 1 }]) {
    assert.throws(() => validateChunkOptions(input), /chunk|overlap|length|settings/i);
  }
  assert.throws(() => validateChunkOptions(JSON.parse('{"__proto__":{"textCharacters":10000}}')), /Unsupported/);
});

test('UTF-8 source ingestion hashes exact bytes and rejects binary and unsafe file labels', async () => {
  const data = Buffer.from('Résumé 🙂\nA searchable note.');
  const source = await prepare(data, 'notes.md', '');
  assert.equal(source.modality, 'text');
  assert.equal(source.chunks[0].text, data.toString('utf8'));
  assert.equal(source.hash, (await prepare(data)).hash);
  assert.equal(source.bytes, data.length);
  assert.equal((await prepare(data, 'notes.log', 'application/octet-stream')).modality, 'text');
  await source.dispose();
  await source.dispose();
  await assert.rejects(prepare(Buffer.from([0xff, 0xfe])), /UTF-8/);
  await assert.rejects(prepare(data, 'bad\nname'), /Source name/);
  await assert.rejects(prepare(data, 'a'.repeat(201)), /Source name/);
  await assert.rejects(prepare(Buffer.allocUnsafe(knowledgeMediaLimits.uploadBytes + 1)), /100 MiB/);
  await assert.rejects(prepare(Buffer.alloc(0)), /non-empty/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareKnowledgeSource({ name: 'notes.txt', mimeType: 'text/plain', data, signal: controller.signal }), /abort/i);
});

test('images require matching signatures and are represented as one unchanged media chunk', async () => {
  const source = await prepare(png, 'picture.png', 'image/png');
  assert.equal(source.modality, 'image');
  assert.equal(source.chunks.length, 1);
  assert.equal(source.chunks[0].modality, 'image');
  assert.deepEqual(source.chunks[0].payload, png);
  assert.deepEqual(source.chunks[0].locator, {});
  await assert.rejects(prepare(png, 'fake.jpg', 'image/jpeg'), /do not match/);
  await assert.rejects(prepare(Buffer.from('GIF89a'), 'old.gif', 'image/gif'), /Choose text/);
  const large = Buffer.alloc(knowledgeMediaLimits.chunkBytes + 1);
  png.copy(large);
  await assert.rejects(prepare(large, 'large.png', 'image/png'), /12 MiB/);
});

test('PDF pages become independent native PDF chunks retaining page provenance', async () => {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < 7; page++) pdf.addPage([200 + page, 300]);
  const data = Buffer.from(await pdf.save());
  const source = await prepare(data, 'report.pdf', 'application/pdf');
  assert.equal(source.modality, 'pdf');
  assert.equal(source.chunks.length, 7);
  for (const [index, chunk] of source.chunks.entries()) {
    assert.equal(chunk.modality, 'pdf');
    assert.deepEqual(chunk.locator, { pageStart: index + 1, pageEnd: index + 1 });
    const page = await PDFDocument.load(chunk.payload!);
    assert.equal(page.getPageCount(), 1);
    assert.equal(page.getPage(0).getWidth(), 200 + index);
  }
  const oversized = await PDFDocument.create();
  for (let page = 0; page < 101; page++) oversized.addPage();
  await assert.rejects(prepare(Buffer.from(await oversized.save()), 'large.pdf', 'application/pdf'), /1-100 pages/);
  await assert.rejects(prepare(Buffer.from('%PDF-1.7\ninvalid'), 'bad.pdf', 'application/pdf'), /valid, unencrypted PDF/);
  const encrypted = await PDFDocument.create();
  encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: PDFName.of('Standard') }));
  await assert.rejects(prepare(Buffer.from(await encrypted.save()), 'locked.pdf', 'application/pdf'), /valid, unencrypted PDF/);
});

test('media time ranges cover exact duration with no gaps and obey clip and source limits', () => {
  assert.deepEqual(knowledgeTimeWindows(301.25, 150), [{ start: 0, end: 150 }, { start: 150, end: 300 }, { start: 300, end: 301.25 }]);
  assert.deepEqual(knowledgeTimeWindows(120, 60), [{ start: 0, end: 60 }, { start: 60, end: 120 }]);
  assert.deepEqual(knowledgeTimeWindows(120.000001, 60), [{ start: 0, end: 60 }, { start: 60, end: 120.000001 }]);
  assert.throws(() => knowledgeTimeWindows(Infinity, 60), /finite/);
  assert.throws(() => knowledgeTimeWindows(0, 60), /positive/);
  assert.throws(() => knowledgeTimeWindows(6001, 60), /100 chunks/);
});

test('real audio/video preparation preserves separate searchable tracks and removes temporary files', async t => {
  try {
    await run('ffmpeg', ['-version'], { windowsHide: true, timeout: 10_000 });
    await run('ffprobe', ['-version'], { windowsHide: true, timeout: 10_000 });
  } catch { t.skip('FFmpeg and ffprobe are required for the local media integration test.'); return; }
  const originalTemporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(originalTemporaryRoot, 'crawlspace-media-test-'));
  const previousTemporaryEnvironment = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = directory; process.env.TMP = directory; process.env.TMPDIR = directory;
  const temporaryNames = async () => (await readdir(directory)).filter(name => name.startsWith('crawlspace-embedding-')).sort();
  const before = await temporaryNames();
  try {
    const audioFile = path.join(directory, 'sample.wav');
    const videoFile = path.join(directory, 'sample.mp4');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=0.5', '-c:a', 'pcm_s16le', '-y', audioFile], { windowsHide: true, timeout: 20_000 });
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10:d=1', '-i', audioFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', videoFile], { windowsHide: true, timeout: 20_000 });
    const audio = await prepare(await readFile(audioFile), 'tone.wav', 'audio/wav');
    assert.equal(audio.chunks.length, 1);
    assert.equal(audio.chunks[0].mimeType, 'audio/wav');
    assert.equal(audio.chunks[0].locator.track, 'audio');
    assert.ok(Math.abs(audio.chunks[0].locator.endSeconds! - 0.5) < 0.01);
    const roundedAudio = path.join(directory, 'boundary.wav');
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=10.0000625', '-c:a', 'pcm_s16le', '-y', roundedAudio], { windowsHide: true, timeout: 20_000 });
    const boundaryAudio = await prepareKnowledgeSource({ name: 'boundary.wav', mimeType: 'audio/wav', data: await readFile(roundedAudio), options: { audioSeconds: 10 }, signal: signal() });
    assert.equal(boundaryAudio.chunks.length, 1);
    assert.ok(boundaryAudio.chunks[0].locator.endSeconds! > 10);
    const video = await prepare(await readFile(videoFile), 'clip.mp4', 'video/mp4');
    assert.equal(video.modality, 'video');
    assert.deepEqual(video.chunks.map(chunk => chunk.modality), ['video', 'audio']);
    assert.ok(video.chunks[0].locator.endSeconds! > video.chunks[1].locator.endSeconds!);
    const silentFile = path.join(directory, 'prepared.mp4');
    await writeFile(silentFile, video.chunks[0].payload!);
    const inspection = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', silentFile], { windowsHide: true, timeout: 10_000 })).stdout);
    assert.deepEqual(inspection.streams.map((stream: { codec_type: string }) => stream.codec_type), ['video']);
    assert.equal((await prepare(await readFile(silentFile), 'silent.mp4', 'video/mp4')).chunks.length, 1);
    assert.deepEqual((await prepare(await readFile(videoFile), 'clip.mov', 'video/quicktime')).chunks.map(chunk => chunk.modality), ['video', 'audio']);
    const webpFile = path.join(directory, 'sample.webp');
    const bmpFile = path.join(directory, 'sample.bmp');
    for (const output of [webpFile, bmpFile]) {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x32', '-frames:v', '1', '-y', output], { windowsHide: true, timeout: 10_000 });
    }
    for (const [file, mime] of [[webpFile, 'image/webp'], [bmpFile, 'image/bmp']]) {
      const image = await prepare(await readFile(file), path.basename(file), mime);
      assert.equal(image.chunks.length, 1);
      assert.equal(image.chunks[0].mimeType, 'image/png');
      assert.ok(image.chunks[0].payload!.subarray(0, 8).equals(png.subarray(0, 8)));
    }
    await audio.dispose();
    await video.dispose();
    assert.deepEqual(await temporaryNames(), before);
    const invalid = Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(20)]);
    await assert.rejects(prepare(invalid, 'invalid.wav', 'audio/wav'), /could not be decoded/);
    assert.deepEqual(await temporaryNames(), before);
    const controller = new AbortController();
    const pending = prepareKnowledgeSource({ name: 'cancel.wav', mimeType: 'audio/wav', data: await readFile(audioFile), signal: controller.signal });
    const cancellation = setTimeout(() => controller.abort(), 5);
    try { await assert.rejects(pending, /abort|cancel/i); }
    finally { clearTimeout(cancellation); }
    assert.deepEqual(await temporaryNames(), before);
  } finally {
    for (const [key, value] of Object.entries(previousTemporaryEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), originalTemporaryRoot);
    await rm(target, { recursive: true, force: true });
  }
});

test('missing FFmpeg produces an actionable failure without leaving temporary media', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(prepare(Buffer.from('RIFF0000WAVE0123456789'), 'sample.wav', 'audio/wav'), /requires FFmpeg and ffprobe/);
  } finally { process.env.PATH = previousPath; }
});
