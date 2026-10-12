import path from 'node:path';

export interface ServerConfig {
  hosted: boolean;
  publicUrl?: string;
  host: string;
  port: number;
  dataDir: string;
  registrationSecret?: string;
  trustProxy: false | string;
  modelKeyNames: string[];
  modelEndpointOrigins: string[];
  previewOrigins: string[];
}

function origins(value: string | undefined, name: string, loopbackOnly = false): string[] {
  return (value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${name} must contain HTTP(S) origins without paths, credentials, or queries.`);
    if (loopbackOnly && !isLoopback(url.hostname)) throw new Error(`${name} must contain explicit loopback origins.`);
    return url.origin;
  });
}

export function isLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const hosted = overrides.hosted ?? env.NODE_ENV === 'production';
  const rawPublic = overrides.publicUrl ?? env.CRAWLSPACE_PUBLIC_URL;
  let publicUrl: string | undefined;
  if (rawPublic) {
    publicUrl = origins(rawPublic, 'CRAWLSPACE_PUBLIC_URL')[0];
    if (!publicUrl || rawPublic.includes(',')) throw new Error('CRAWLSPACE_PUBLIC_URL must be a single origin.');
    if (hosted && !publicUrl.startsWith('https://')) throw new Error('Production requires an HTTPS CRAWLSPACE_PUBLIC_URL.');
  } else if (hosted) throw new Error('Set CRAWLSPACE_PUBLIC_URL to the HTTPS public origin before starting production.');
  const port = overrides.port ?? Number(env.CRAWLSPACE_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CRAWLSPACE_PORT must be between 1 and 65535.');
  const registrationSecret = overrides.registrationSecret ?? env.CRAWLSPACE_REGISTRATION_SECRET;
  if (registrationSecret && registrationSecret.length < 32) throw new Error('CRAWLSPACE_REGISTRATION_SECRET must contain at least 32 characters.');
  const keys = overrides.modelKeyNames ?? (env.CRAWLSPACE_MODEL_KEY_ALLOWLIST ?? 'ANTHROPIC_API_KEY,OPENAI_API_KEY').split(',').map(item => item.trim()).filter(Boolean);
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key) || /^CRAWLSPACE_/i.test(key))) throw new Error('Model key allowlist must contain provider environment names and must never include CRAWLSPACE_ secrets.');
  const trustProxy = overrides.trustProxy ?? (env.CRAWLSPACE_TRUST_PROXY && env.CRAWLSPACE_TRUST_PROXY !== 'false' ? env.CRAWLSPACE_TRUST_PROXY : false);
  if (trustProxy === 'true') throw new Error('Set CRAWLSPACE_TRUST_PROXY to the actual proxy address or subnet, never true.');
  return {
    hosted, publicUrl, port, registrationSecret: registrationSecret || undefined,
    host: overrides.host ?? env.CRAWLSPACE_HOST ?? '127.0.0.1',
    dataDir: path.resolve(overrides.dataDir ?? env.CRAWLSPACE_DATA_DIR ?? '.crawlspace'),
    trustProxy, modelKeyNames: [...new Set(keys)],
    modelEndpointOrigins: overrides.modelEndpointOrigins ?? origins(env.CRAWLSPACE_MODEL_ENDPOINT_ORIGINS ?? (hosted ? '' : 'http://127.0.0.1:11434,http://localhost:11434'), 'CRAWLSPACE_MODEL_ENDPOINT_ORIGINS'),
    previewOrigins: overrides.previewOrigins ?? origins(env.CRAWLSPACE_PREVIEW_ORIGINS, 'CRAWLSPACE_PREVIEW_ORIGINS', true),
  };
}