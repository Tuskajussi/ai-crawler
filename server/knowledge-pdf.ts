import { Worker } from 'node:worker_threads';
import { InputError } from './validation';

const limits = { sourceBytes: 100 * 1024 * 1024, chunkBytes: 12 * 1024 * 1024, preparedBytes: 256 * 1024 * 1024, pages: 100 };
interface PdfPage { page: number; payload: Buffer }
const errors: Record<string, string> = {
  invalid: 'The PDF could not be read. Use a valid, unencrypted PDF.',
  pages: 'PDF sources must contain 1-100 pages. Split larger PDFs before importing.',
  chunk: 'A prepared PDF page exceeds 12 MiB. Resize or simplify this page before importing.',
  total: 'The prepared PDF exceeds 256 MiB. Split it into smaller files.',
};

/** A standalone CJS worker keeps parsing independent of the server's TypeScript loader. */
export async function prepareKnowledgePdfPages(data: Buffer, signal: AbortSignal, timeoutMs = 180_000): Promise<PdfPage[]> {
  signal.throwIfAborted();
  if (!Buffer.isBuffer(data) || !data.length || data.length > limits.sourceBytes) throw new InputError('Choose a non-empty PDF of at most 100 MiB.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new InputError('Invalid PDF processing timeout.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./knowledge-pdf-worker.cjs', import.meta.url), {
      execArgv: [], workerData: { data, limits },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    const pages: PdfPage[] = [];
    let bytes = 0;
    let complete = false;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      // The promise settles in 'exit', after termination has actually drained.
      void worker.terminate().catch(() => {});
    };
    const abort = () => stop(new Error('PDF preparation was cancelled.'));
    const timer = setTimeout(() => stop(new InputError('PDF preparation timed out. Choose a smaller file.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: unknown) => {
      if (failure) return;
      if (!message || typeof message !== 'object') { stop(new InputError('PDF preparation returned invalid data.')); return; }
      const event = message as { type?: string; page?: number; payload?: Uint8Array; count?: number; code?: string };
      if (event.type === 'error') { stop(new InputError(errors[event.code ?? ''] ?? errors.invalid)); return; }
      if (event.type === 'page') {
        if (complete || event.page !== pages.length + 1 || !(event.payload instanceof Uint8Array) || !event.payload.byteLength
          || event.payload.byteLength > limits.chunkBytes || pages.length >= limits.pages || bytes + event.payload.byteLength > limits.preparedBytes) {
          stop(new InputError('The prepared PDF exceeds its page or storage allowance.')); return;
        }
        bytes += event.payload.byteLength;
        pages.push({ page: event.page, payload: Buffer.from(event.payload.buffer, event.payload.byteOffset, event.payload.byteLength) });
      } else if (event.type === 'done' && !complete && pages.length > 0 && event.count === pages.length) complete = true;
      else stop(new InputError('PDF preparation returned invalid data.'));
    });
    worker.once('error', () => {
      failure ??= new InputError('PDF preparation exceeded its local processing allowance or could not start. Choose a smaller valid PDF.');
    });
    worker.once('exit', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.removeAllListeners();
      if (failure) reject(failure);
      else if (code !== 0 || !complete) reject(new InputError('PDF preparation stopped before every page was ready. Choose a smaller valid PDF.'));
      else resolve(pages);
    });
    if (signal.aborted) abort();
  });
}
