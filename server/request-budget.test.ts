import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedContextData, fitRequestPayload, requestSize } from './request-budget';

test('shared history fits a model allocation and retains recent useful records', () => {
  const inbox = Array.from({ length: 50 }, (_, id) => ({ id, text: 'review evidence '.repeat(20) }));
  const data = JSON.parse(boundedContextData(inbox, [{ title: 'Current finding' }], 4096));
  assert.equal(data.omitted, true);
  assert.ok(data.inbox.some((item: any) => item.id === 49));
  assert.ok(data.findings.some((item: any) => item.title === 'Current finding'));
  assert.ok(requestSize(data) <= 1024);
});

test('large multibyte tool output is shortened without changing tool identities or the assignment', () => {
  const original = { messages: [{ role: 'system', content: 'Review safely' }, { role: 'user', content: 'Return the exact report schema' }, { role: 'assistant', tool_calls: [{ id: 'read1', function: { name: 'project_read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'read1', content: '漢字'.repeat(10_000) }], tools: [{ name: 'project_read' }] };
  const payload = fitRequestPayload(original, 4096, 1024) as typeof original;
  assert.ok(requestSize(payload) <= 4096 - 1024 - 256);
  assert.equal(payload.messages[1].content, original.messages[1].content);
  assert.equal(payload.messages[3].tool_call_id, 'read1');
  assert.match(payload.messages[3].content!, /shortened/);
  assert.equal(original.messages[3].content!.length, 20_000);
});

test('old complete rounds are evicted and the newest call/result remains paired', () => {
  const rounds = Array.from({ length: 12 }, (_, id) => [{ role: 'assistant', tool_calls: [{ id: `call${id}`, function: { name: 'read', arguments: 'x'.repeat(200) } }] }, { role: 'tool', tool_call_id: `call${id}`, content: 'x'.repeat(4000) }]).flat();
  const payload: any = fitRequestPayload({ messages: [{ role: 'user', content: 'Assignment' }, ...rounds] }, 4096, 1024);
  assert.ok(payload.messages.length < 25);
  assert.equal(payload.messages.at(-1).tool_call_id, 'call11');
  for (let index = 1; index < payload.messages.length; index += 2) assert.equal(payload.messages[index].tool_calls[0].id, payload.messages[index + 1].tool_call_id);
});

test('mandatory prompt and tool schemas cannot be silently discarded', () => {
  assert.throws(() => fitRequestPayload({ messages: [{ role: 'user', content: 'x'.repeat(10_000) }], tools: [{ name: 'required' }] }, 4096, 1024), /context is full/);
});

test('Responses reasoning and its native/custom tool rounds are not split to fit context', () => {
  const payload = { input: [
    { role: 'user', content: 'Review the evidence' },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'project_read', arguments: 'x'.repeat(1400) },
    { type: 'function_call_output', call_id: 'call_1', output: 'x'.repeat(6000) },
    { type: 'reasoning', id: 'rs_2', encrypted_content: 'opaque-reasoning' },
    { type: 'custom_tool_call', id: 'ctc_2', call_id: 'call_2', name: 'codemode', input: 'x'.repeat(1400) },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: 'x'.repeat(6000) },
  ] };
  assert.throws(() => fitRequestPayload(payload, 4096, 1024), /context is full/);
  assert.equal(payload.input.length, 7);
  assert.equal(payload.input[3].output?.length, 6000, 'The original transcript stays intact.');
});
