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

export async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
  const verb = method.toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined || !['GET', 'HEAD', 'OPTIONS'].includes(verb)) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(verb) && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(`/api${path}`, {
    method: verb,
    credentials: 'same-origin',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; }
  catch { data = undefined; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      setCsrfToken();
      window.dispatchEvent(new Event('crawlspace:unauthorized'));
    }
    throw new ApiError(typeof data?.error === 'string' ? data.error : `Request failed (${res.status}).`, res.status);
  }
  if (text && data === undefined) throw new ApiError('The server returned an unexpected response. Please try again.', res.status);
  return data;
}

