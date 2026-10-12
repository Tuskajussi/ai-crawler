import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { GoogleAuth } from 'google-auth-library';
import type { EmbeddingConfig } from '../shared/knowledge';
import { InputError } from './validation';

export interface EmbeddingInput {
  text?: string;
  title?: string;
  media?: { mimeType: string; data: Buffer };
}

export interface EmbeddingRequestOptions {
  purpose: 'document' | 'query';
  signal: AbortSignal;
  allowCloudUpload: boolean;
}

export type EmbeddingExecutor = (config: EmbeddingConfig, input: EmbeddingInput, options: EmbeddingRequestOptions) => Promise<number[]>;

const fields = new Set(['provider', 'kind', 'modelId', 'baseUrl', 'apiKeyEnv', 'dimensions', 'timeoutSeconds', 'projectId', 'location']);
const nativeModel = 'gemini-embedding-2';
const maximumMediaBytes = 12 * 1024 * 1024;
const maximumResponseBytes = 1024 * 1024;
const promptVersion = 'knowledge-retrieval-v1';
const mediaTypes = new Set(['image/png', 'image/jpeg', 'application/pdf', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'video/mp4', 'video/quicktime']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number);
    return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  }
  if (isIP(host) === 6) {
    if (/^(?:fc|fd|fe[89ab])/.test(host)) return true;
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(host);
    if (mapped) {
      const first = parseInt(mapped[1], 16); const second = parseInt(mapped[2], 16);
      return privateHost(`${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`);
    }
  }
  return false;
}

function compatibleBase(config: EmbeddingConfig): URL {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new InputError('Enter a valid HTTP(S) embedding endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new InputError('Embedding URLs must use HTTP(S) without credentials, query strings or fragments.');
  }
  if (config.kind === 'local' && !privateHost(url.hostname)) throw new InputError('Local embedding endpoints must use localhost or a private LAN IP address. Use a private IP, or choose cloud and confirm uploads.');
  if (config.kind === 'cloud' && url.protocol !== 'https:') throw new InputError('Cloud embedding endpoints must use HTTPS.');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export function validateEmbeddingConfig(input: unknown): asserts input is EmbeddingConfig {
  if (!record(input) || Object.keys(input).length !== fields.size || Object.keys(input).some(key => !fields.has(key))
    || !['gemini', 'vertex', 'compatible'].includes(input.provider as string) || !['local', 'cloud'].includes(input.kind as string)
    || !boundedText(input.modelId, 300) || !input.modelId.trim() || input.modelId !== input.modelId.trim()
    || !boundedText(input.baseUrl, 2000) || !boundedText(input.apiKeyEnv, 100)
    || (input.apiKeyEnv !== '' && !/^[A-Z_][A-Z0-9_]*$/.test(input.apiKeyEnv))
    || !boundedText(input.projectId, 100) || !['global', 'us', 'eu'].includes(input.location as string)
    || !Number.isSafeInteger(input.dimensions) || (input.dimensions as number) < 1 || (input.dimensions as number) > 8192
    || !Number.isSafeInteger(input.timeoutSeconds) || (input.timeoutSeconds as number) < 5 || (input.timeoutSeconds as number) > 300) {
    throw new InputError('Embedding settings are invalid. Use an environment variable name for credentials, 1–8192 dimensions, and a timeout of 5–300 seconds.');
  }
  const config = input as unknown as EmbeddingConfig;
  if (config.provider === 'compatible') {
    compatibleBase(config);
    if (config.projectId) throw new InputError('Google Cloud project IDs apply only to Vertex embeddings.');
    return;
  }
  if (config.kind !== 'cloud' || config.baseUrl !== '' || config.modelId !== nativeModel
    || config.dimensions < 128 || config.dimensions > 3072) {
    throw new InputError('Google embeddings use the official cloud endpoint, model gemini-embedding-2, and 128–3072 dimensions.');
  }
  if (config.provider === 'gemini' && (!config.apiKeyEnv || config.projectId)) {
    throw new InputError('Gemini embeddings need an API key environment variable and no Vertex project ID.');
  }
  if (config.provider === 'vertex' && (config.apiKeyEnv !== '' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId))) {
    throw new InputError('Vertex embeddings need a valid Google Cloud project ID and use Application Default Credentials. Leave the API key environment variable empty.');
  }
}

export function embeddingReadiness(config: EmbeddingConfig, environment: NodeJS.ProcessEnv = process.env): { ready: boolean; message: string } {
  try { validateEmbeddingConfig(config); } catch (error) { return { ready: false, message: error instanceof InputError ? error.message : 'Embedding settings are invalid.' }; }
  if (config.apiKeyEnv && !environment[config.apiKeyEnv]?.trim()) {
    return { ready: false, message: `Set the ${config.apiKeyEnv} environment variable before creating embeddings.` };
  }
  return { ready: true, message: config.provider === 'vertex'
    ? 'Configuration is valid. Application Default Credentials are checked only when you request embeddings or search.'
    : 'Configuration is valid. The embedding endpoint has not been tested.' };
}

function endpoint(config: EmbeddingConfig): string {
  if (config.provider === 'compatible') return new URL('embeddings', compatibleBase(config)).href;
  if (config.provider === 'gemini') return `https://generativelanguage.googleapis.com/v1beta/models/${nativeModel}:embedContent`;
  const host = config.location === 'global' ? 'aiplatform.googleapis.com' : `aiplatform.${config.location}.rep.googleapis.com`;
  return `https://${host}/v1/projects/${config.projectId}/locations/${config.location}/publishers/google/models/${nativeModel}:embedContent`;
}

/** Credential changes preserve a space; endpoint, model, dimensions or formatting changes do not. */
export function embeddingSpaceKey(config: EmbeddingConfig): string {
  validateEmbeddingConfig(config);
  return createHash('sha256').update(JSON.stringify({ provider: config.provider, endpoint: endpoint(config), modelId: config.modelId, dimensions: config.dimensions, promptVersion })).digest('hex');
}

class EmbeddingError extends Error {}

function cancelBody(response: Response): void {
  // Cancellation is requested immediately; a provider's stream cleanup must not
  // be able to hold the worker after the bounded request has already failed.
  void response.body?.cancel().catch(() => {});
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new EmbeddingError('The embedding request stopped or exceeded its timeout.');
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new EmbeddingError('The embedding request stopped or exceeded its timeout.')); });
  signal.addEventListener('abort', rejectAbort, { once: true });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', rejectAbort); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumResponseBytes) {
    cancelBody(response);
    throw new EmbeddingError('The embedding response exceeded the 1 MiB allowance.');
  }
  if (!response.body) throw new EmbeddingError('The embedding endpoint returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      cancelled(signal);
      const next = await abortable(reader.read(), signal);
      cancelled(signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumResponseBytes) { cancel(); throw new EmbeddingError('The embedding response exceeded the 1 MiB allowance.'); }
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch { throw new EmbeddingError('The embedding endpoint returned invalid JSON.'); }
  } finally {
    if (signal.aborted) cancel();
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Normalize with scaling so even finite, unusually large values cannot overflow. */
function normalizedVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new EmbeddingError(`The embedding endpoint must return exactly ${dimensions} finite vector values.`);
  }
  let maximum = 0;
  for (const item of value as number[]) maximum = Math.max(maximum, Math.abs(item));
  if (maximum === 0) throw new EmbeddingError('The embedding endpoint returned a zero vector.');
  const scaled = (value as number[]).map(item => item / maximum);
  const norm = Math.sqrt(scaled.reduce((sum, item) => sum + item * item, 0));
  return scaled.map(item => item / norm);
}

function requestBody(config: EmbeddingConfig, input: EmbeddingInput, purpose: 'document' | 'query'): object {
  if (!record(input) || (input.text !== undefined && typeof input.text !== 'string') || (input.title !== undefined && !boundedText(input.title, 300))) {
    throw new InputError('Embedding input must contain text or supported media and a title of at most 300 characters.');
  }
  const text = input.text ?? '';
  if (!text.trim() && !input.media) throw new InputError('Choose non-empty text or a supported media chunk to embed.');
  if (purpose === 'query' && (input.media || !text.trim())) throw new InputError('Search requires a non-empty text query.');
  if (config.provider === 'compatible') {
    if (input.media) throw new InputError('Compatible embedding endpoints support text chunks only. Use Gemini or Vertex for media.');
    if (Buffer.byteLength(text, 'utf8') > 7500) throw new InputError('Text chunks must fit within 7,500 UTF-8 bytes. Split this chunk before embedding.');
    return { model: config.modelId, input: text, encoding_format: 'float', dimensions: config.dimensions };
  }
  const formatted = purpose === 'query' ? `task: search result | query: ${text}` : `title: ${input.title?.trim() || 'none'} | text: ${text}`;
  if (Buffer.byteLength(formatted, 'utf8') > 7500) throw new InputError('Formatted text chunks must fit within 7,500 UTF-8 bytes. Split this chunk before embedding.');
  const parts: object[] = [{ text: formatted }];
  if (input.media) {
    if (!record(input.media) || typeof input.media.mimeType !== 'string' || !mediaTypes.has(input.media.mimeType) || !Buffer.isBuffer(input.media.data) || input.media.data.length === 0 || input.media.data.length > maximumMediaBytes) {
      throw new InputError('Use a supported PNG, JPEG, PDF, MP3, WAV, MP4 or MOV chunk of at most 12 MiB.');
    }
    if (config.provider === 'vertex' && input.media.mimeType === 'video/quicktime') throw new InputError('Vertex video chunks must use MP4.');
    parts.push({ inlineData: { mimeType: input.media.mimeType === 'audio/mp3' ? 'audio/mpeg' : input.media.mimeType, data: input.media.data.toString('base64') } });
  }
  return { content: { parts }, embedContentConfig: { outputDimensionality: config.dimensions, autoTruncate: false } };
}

export function createEmbeddingExecutor(options: {
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  vertexHeaders?: (url: string, signal: AbortSignal) => Promise<HeadersInit>;
} = {}): EmbeddingExecutor {
  const environment = options.environment ?? process.env;
  const requestFetch = options.fetch ?? globalThis.fetch;
  const googleAuth = new Map<string, GoogleAuth>();
  const vertexHeaders = options.vertexHeaders ?? (async (url: string, signal: AbortSignal) => {
    // Readiness does not instantiate auth. Only an explicit request may resolve ADC.
    const projectId = new URL(url).pathname.split('/')[3];
    let auth = googleAuth.get(projectId);
    if (!auth) {
      auth = new GoogleAuth({ projectId, scopes: ['https://www.googleapis.com/auth/cloud-platform'], clientOptions: { transporterOptions: { timeout: 30_000, retry: false } } });
      googleAuth.set(projectId, auth);
    }
    try {
      const headers = await abortable(auth.getRequestHeaders(url), signal);
      if (!headers.get('authorization')) throw new Error();
      return headers;
    } catch { cancelled(signal); throw new EmbeddingError('Google Cloud authentication failed. Configure Application Default Credentials for Vertex.'); }
  });

  return async (config, input, requestOptions) => {
    validateEmbeddingConfig(config);
    cancelled(requestOptions.signal);
    if (config.kind === 'cloud' && requestOptions.allowCloudUpload !== true) throw new InputError('Confirm sending this content to the cloud embedding provider before continuing.');
    const readiness = embeddingReadiness(config, environment);
    if (!readiness.ready) throw new InputError(readiness.message);
    const body = JSON.stringify(requestBody(config, input, requestOptions.purpose));
    const url = endpoint(config);
    const controller = new AbortController();
    const signal = AbortSignal.any([requestOptions.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
    let headers = new Headers({ 'Content-Type': 'application/json' });
    try {
      if (config.provider === 'vertex') {
        const authHeaders = new Headers(await abortable(vertexHeaders(url, signal), signal));
        for (const [name, value] of authHeaders) headers.set(name, value);
        if (!headers.has('authorization')) throw new EmbeddingError('Google Cloud authentication did not return an access token.');
      } else if (config.apiKeyEnv) {
        const key = environment[config.apiKeyEnv]!;
        headers.set(config.provider === 'gemini' ? 'x-goog-api-key' : 'Authorization', config.provider === 'gemini' ? key : `Bearer ${key}`);
      }
      cancelled(signal);
      const response = await abortable(requestFetch(new Request(url, { method: 'POST', headers, body, signal, redirect: 'error' })), signal);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        cancelBody(response);
        throw new EmbeddingError('Embedding endpoint redirects are not allowed.');
      }
      if (!response.ok) {
        cancelBody(response);
        throw new EmbeddingError(`The embedding endpoint returned HTTP ${response.status}. Check the model, credentials and provider quota.`);
      }
      const payload = await boundedJson(response, signal);
      if (!record(payload) || payload.error) throw new EmbeddingError('The embedding endpoint did not return a valid embedding response.');
      if (payload.truncated === true) throw new EmbeddingError('The embedding endpoint truncated this chunk. Split it into smaller chunks.');
      let vector: unknown;
      if (config.provider === 'compatible') {
        if (!Array.isArray(payload.data) || payload.data.length !== 1 || !record(payload.data[0]) || payload.data[0].index !== 0
          || (payload.model !== undefined && payload.model !== config.modelId)) {
          throw new EmbeddingError('The embedding endpoint returned an unexpected model or result count.');
        }
        vector = payload.data[0].embedding;
      } else vector = record(payload.embedding) ? payload.embedding.values : undefined;
      cancelled(signal);
      return normalizedVector(vector, config.dimensions);
    } catch (error) {
      cancelled(signal);
      if (error instanceof EmbeddingError || error instanceof InputError) throw error;
      // Provider and authentication errors can echo credentials and input content.
      throw new EmbeddingError('The embedding request failed. Check the endpoint, model and credentials.');
    } finally { clearTimeout(timer); headers = new Headers(); }
  };
}
