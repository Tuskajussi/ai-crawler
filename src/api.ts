let csrfToken: string | undefined;

/** Session protection stays in memory and is refreshed by the auth provider. */
export function setCsrfToken(token?: string) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const requestToken = csrfToken;
  const verb = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(verb) && requestToken) {
    headers.set('X-CSRF-Token', requestToken);
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    method: verb,
    credentials: 'same-origin',
    headers,
  });
  // A response from a previous session must not expire a newer sign-in.
  if (response.status === 401 && !path.startsWith('/auth/') && csrfToken === requestToken) {
    setCsrfToken();
    window.dispatchEvent(new Event('crawlspace:unauthorized'));
  }
  return response;
}

export async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
  const verb = method.toUpperCase();
  const res = await apiFetch(path, {
    method: verb,
    headers: body !== undefined || !['GET', 'HEAD', 'OPTIONS'].includes(verb) ? { 'Content-Type': 'application/json' } : undefined,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; }
  catch { data = undefined; }
  if (!res.ok) {
    throw new ApiError(typeof data?.error === 'string' ? data.error : `Request failed (${res.status}).`, res.status);
  }
  if (text && data === undefined) throw new ApiError('The server returned an unexpected response. Please try again.', res.status);
  return data;
}
