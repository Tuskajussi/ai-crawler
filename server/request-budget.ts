import { AgentExecutionError } from './execution-errors';

const marker = '\n[Output shortened to fit this model. Read a smaller range if needed.]';

/** Byte-based upper estimate for text, plus room for provider framing and images. */
export function requestSize(value: unknown): number {
  if (typeof value === 'string') return value.startsWith('data:image/') ? 8192 : Buffer.byteLength(value, 'utf8');
  if (value === null || value === undefined) return 1;
  if (typeof value !== 'object') return 8;
  if ((value as { type?: string }).type === 'image') return 8192;
  if (Array.isArray(value)) return 16 + value.reduce((sum, item) => sum + requestSize(item), 0);
  return 32 + Object.entries(value).reduce((sum, [key, item]) => sum + key.length + requestSize(item), 0);
}

function shorten(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/') || Buffer.byteLength(value) <= limit) return value;
    let text = value.slice(0, Math.max(0, limit - marker.length));
    while (Buffer.byteLength(text) > limit - marker.length) text = text.slice(0, Math.floor(text.length * 0.8));
    return text + marker;
  }
  if (Array.isArray(value)) return value.map(item => shorten(item, limit));
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (item.type === 'image' || item.type === 'image_url' || item.type === 'input_image') return value;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, ['text', 'content', 'output'].includes(key) ? shorten(child, limit) : child]));
  }
  return value;
}

function isToolResult(message: any): boolean {
  return message.role === 'tool' || message.type === 'function_call_output' || message.type === 'custom_tool_call_output'
    || (message.role === 'user' && Array.isArray(message.content) && message.content.every((part: any) => part.type === 'tool_result'));
}

/** Preserve the assignment, schema and complete call/result pairs when evicting history. */
export function fitRequestPayload(original: unknown, contextWindow: number, outputTokens: number): unknown {
  const payload = structuredClone(original) as Record<string, any>;
  const budget = contextWindow - outputTokens - 256;
  if (requestSize(payload) <= budget) return payload;
  const key = Array.isArray(payload.messages) ? 'messages' : Array.isArray(payload.input) ? 'input' : undefined;
  if (!key) throw new AgentExecutionError('The model context is too small for this request. Increase its context or reduce the assignment.', 'report');
  const messages: any[] = payload[key];
  // Responses reasoning rounds must be replayed intact, including their tool
  // outputs: https://developers.openai.com/api/docs/guides/reasoning
  if (key === 'input' && messages.some(item => item.type === 'reasoning')) throw new AgentExecutionError('The model context is full. Its reasoning and tool history must remain intact; use a larger context or a smaller assignment.', 'report');
  for (const limit of [4096, 1024, 256]) {
    for (let index = 0; index < messages.length; index++) {
      if (isToolResult(messages[index])) messages[index] = shorten(messages[index], limit);
    }
    if (requestSize(payload) <= budget) return payload;
  }
  // Chat Completions and Anthropic: remove the oldest complete tool round,
  // keeping the newest round and every ordinary user/system message.
  for (;;) {
    const rounds: { start: number; end: number }[] = [];
    for (let index = 0; index < messages.length; index++) {
      const item = messages[index];
      const calls = item.role === 'assistant' && (item.tool_calls?.length || item.content?.some?.((part: any) => part.type === 'tool_use'));
      if (!calls) continue;
      let end = index + 1;
      while (end < messages.length && isToolResult(messages[end])) end++;
      if (end > index + 1) rounds.push({ start: index, end });
    }
    if (rounds.length < 2) break;
    messages.splice(rounds[0].start, rounds[0].end - rounds[0].start);
    if (requestSize(payload) <= budget) return payload;
  }
  // Responses: evict call/output pairs by ID rather than breaking their linkage.
  const calls = () => messages.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call');
  while (calls().length > 1) {
    const call = calls()[0];
    const output = messages.find(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type) && item.call_id === call.call_id);
    if (!output) break;
    messages.splice(messages.indexOf(output), 1);
    messages.splice(messages.indexOf(call), 1);
    if (requestSize(payload) <= budget) return payload;
  }
  throw new AgentExecutionError('The model context is full even after shortening tool outputs. Use a larger context or a smaller assignment.', 'report');
}

export function boundedContextData(inbox: unknown[], findings: unknown[], contextWindow: number): string {
  const limit = Math.max(0, Math.min(8192, Math.floor(contextWindow / 4)));
  const selected: { inbox: unknown[]; findings: unknown[]; omitted: boolean } = { inbox: [], findings: [], omitted: false };
  // Recent messages and current findings compete for a bounded allocation.
  const recent = inbox.slice(-40).reverse();
  const items = findings.slice(0, 50);
  for (let index = 0; index < Math.max(recent.length, items.length); index++) {
    for (const [key, candidate] of [['inbox', recent[index]], ['findings', items[index]]] as const) {
      if (candidate === undefined) continue;
      selected[key].push(candidate);
      if (requestSize(selected) > limit) { selected[key].pop(); selected.omitted = true; }
    }
  }
  selected.inbox.reverse();
  selected.omitted ||= inbox.length > selected.inbox.length || findings.length > selected.findings.length;
  return JSON.stringify(selected);
}
