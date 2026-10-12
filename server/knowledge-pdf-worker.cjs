const { parentPort, workerData } = require('node:worker_threads');
const { PDFDocument } = require('pdf-lib');

class PreparationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function prepare() {
  const { data, limits } = workerData;
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > limits.sourceBytes) throw new PreparationError('invalid');
  const document = await PDFDocument.load(data, { throwOnInvalidObject: true, updateMetadata: false });
  const count = document.getPageCount();
  if (count < 1 || count > limits.pages) throw new PreparationError('pages');
  let total = 0;
  for (let index = 0; index < count; index++) {
    const part = await PDFDocument.create();
    const [page] = await part.copyPages(document, [index]);
    part.addPage(page);
    const payload = await part.save();
    if (!payload.byteLength || payload.byteLength > limits.chunkBytes) throw new PreparationError('chunk');
    total += payload.byteLength;
    if (total > limits.preparedBytes) throw new PreparationError('total');
    // Transfer ownership rather than retain or duplicate every prepared page in the worker.
    parentPort.postMessage({ type: 'page', page: index + 1, payload }, [payload.buffer]);
  }
  parentPort.postMessage({ type: 'done', count });
}

prepare().catch(error => {
  parentPort.postMessage({ type: 'error', code: error instanceof PreparationError ? error.code : 'invalid' });
}).finally(() => parentPort.close());
