import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelConfig } from '../shared/types';
import { modelReadiness, providersConfig } from './pi';
import { adaptChatgptResponsesPayload, createChatgptFetch, type ChatgptService } from './chatgpt';
import { fitRequestPayload } from './request-budget';

/** An explicit user-requested probe, isolated from the project's files and tools. */
export async function probeModel(config: ModelConfig, stateDirectory: string, chatgpt?: ChatgptService, signal?: AbortSignal) {
  const checkedAt = new Date().toISOString();
  const outputTokens = config.maxOutputTokens ?? Math.min(8192, Math.floor((config.contextWindow ?? 32768) / 4));
  const status = (ready: boolean, message: string) => ({ ready, message, checkedAt, modelId: config.modelId });
  const subscriptionProfileId = config.authMethod === 'chatgpt' ? config.chatgptProfileId ?? (await chatgpt?.status())?.activeProfileId : undefined;
  const subscription = config.authMethod === 'chatgpt' ? await chatgpt?.profileReadiness(subscriptionProfileId) : undefined;
  const readiness = modelReadiness(config, process.env, subscription);
  if (!readiness.ready) return status(false, readiness.message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(120, config.timeoutSeconds ?? 60) * 1000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const probeRoot = path.resolve(stateDirectory, 'probes');
  const directory = path.join(probeRoot, randomUUID());
  if (path.dirname(directory) !== probeRoot) throw new Error('Invalid probe directory.');
  let session: any;
  let unsubscribe: (() => void) | undefined;
  const onAbort = () => { void session?.abort(); };
  const apiKey = config.authMethod !== 'chatgpt' && config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  try {
    const sdk: Record<string, any> = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');
    combined.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const modelsPath = path.join(directory, 'models.json');
    await writeFile(modelsPath, JSON.stringify(providersConfig([config])), 'utf8');
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath, modelsStorePath: path.join(directory, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false, signal: combined });
    const provider = `crawlspace-${config.id}`;
    await modelRuntime.setRuntimeApiKey(provider, apiKey ?? 'crawlspace-probe', { signal: combined });
    const model = modelRuntime.getModel(provider, config.modelId);
    if (!model) return status(false, 'Pi could not load this model configuration.');
    const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [] }, { projectTrusted: false });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => 'Follow the connection-check instruction. No project files are available.', appendSystemPromptOverride: () => [] });
    await resourceLoader.reload();
    const nonce = randomUUID();
    let calls = 0;
    let requests = 0;
    let failure: string | undefined;
    let completed = false;
    const tool = { name: 'connection_check', label: 'Check connection', description: 'Return a fresh connection-check value. Call once, then report its value.', parameters: Type.Object({}), execute: async () => {
      if (++calls > 1) throw new Error('The connection check must be called once.');
      return { content: [{ type: 'text', text: nonce }], details: undefined };
    } };
    ({ session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, thinkingLevel: config.reasoningEffort ?? 'off', tools: ['connection_check'], customTools: [tool], resourceLoader, settingsManager, sessionManager: sdk.SessionManager.inMemory() }));
    const stream = session.agent.streamFunction;
    const subscriptionFetch = config.authMethod === 'chatgpt' ? createChatgptFetch(chatgpt!, subscriptionProfileId) : undefined;
    session.agent.streamFunction = (requestModel: any, transcript: any, options: any) => {
      if (++requests > 3) throw new Error('The model did not complete the bounded connection check.');
      completed = false;
      return stream(requestModel, transcript, { ...options, maxTokens: outputTokens, maxRetries: 0, transport: 'sse', ...(subscriptionFetch ? { fetch: subscriptionFetch } : {}),
        ...(config.reasoningEffort && ['custom', 'ollama'].includes(config.provider) ? { samplingParams: { ...options?.samplingParams, reasoning_effort: config.reasoningEffort } } : {}),
        onPayload: async (payload: unknown, requestedModel: any) => {
          const replacement = await options?.onPayload?.(payload, requestedModel);
          return fitRequestPayload(subscriptionFetch ? adaptChatgptResponsesPayload(replacement ?? payload) : replacement ?? payload, config.contextWindow ?? 32768, outputTokens);
        },
        onProviderStreamEvent: async (event: any, requestedModel: any) => {
          if (event?.type === 'response.completed') completed = true;
          await options?.onProviderStreamEvent?.(event, requestedModel);
        },
      });
    };
    combined.addEventListener('abort', onAbort, { once: true });
    unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'message_end' && ['error', 'aborted'].includes(event.message?.stopReason)) failure = event.message.errorMessage ?? 'The model response did not complete.';
    });
    combined.throwIfAborted();
    await session.bindExtensions({});
    await session.prompt('Call connection_check exactly once. Then return only JSON with {"ready":true,"value":"the exact value returned by the tool"}.');
    await session.waitForIdle();
    combined.throwIfAborted();
    if (failure) throw new Error(failure);
    if (subscriptionFetch && !completed) throw new Error('Subscription response did not reach response.completed.');
    const text = (session.getLastAssistantText() ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const report = JSON.parse(text);
    if (calls !== 1 || report.ready !== true || report.value !== nonce) return status(false, 'The endpoint answered, but its native tool round-trip and JSON response were not validated.');
    return status(true, 'Streaming, a native tool round-trip, and a valid JSON response passed. Code Mode and image input need a real workflow check.');
  } catch (error) {
    let message = combined.aborted ? 'Connection check stopped or exceeded its timeout.' : error instanceof Error ? error.message : 'Connection check failed.';
    if (apiKey) message = message.replaceAll(apiKey, '[redacted]');
    return status(false, message.slice(0, 1000));
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
    unsubscribe?.();
    if (session) { await session.abort(); await session.waitForIdle(); session.dispose(); }
    await rm(directory, { recursive: true, force: true });
  }
}
