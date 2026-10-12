import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { prepareKnowledgePdfPages } from './knowledge-pdf';

async function pdf() {
  const document = await PDFDocument.create();
  document.addPage([240, 300]);
  return Buffer.from(await document.save());
}
const messagePorts = () => process.getActiveResourcesInfo().filter(resource => resource === 'MessagePort').length;
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('standalone PDF worker returns actual pages and exits before publishing success', async () => {
  const before = messagePorts();
  const pages = await prepareKnowledgePdfPages(await pdf(), new AbortController().signal);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].page, 1);
  assert.equal((await PDFDocument.load(pages[0].payload)).getPage(0).getWidth(), 240);
  await nextTurn();
  assert.equal(messagePorts(), before);
});

test('PDF deadline terminates and drains the real worker before rejecting', async () => {
  const data = await pdf();
  const before = messagePorts();
  const started = Date.now();
  await assert.rejects(prepareKnowledgePdfPages(data, new AbortController().signal, 1), /timed out/);
  assert.ok(Date.now() - started < 5000);
  await nextTurn();
  assert.equal(messagePorts(), before);
});

test('PDF cancellation terminates and drains the real worker and pre-cancellation starts none', async () => {
  const data = await pdf();
  const before = messagePorts();
  const controller = new AbortController();
  const pending = prepareKnowledgePdfPages(data, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(prepareKnowledgePdfPages(data, controller.signal), /abort/i);
  await nextTurn();
  assert.equal(messagePorts(), before);
});
