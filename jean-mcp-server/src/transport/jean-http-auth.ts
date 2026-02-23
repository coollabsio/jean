import type { JeanMcpConfig } from '../config.js';
import { JeanMcpError, normalizeError } from '../utils/errors.js';

function withToken(url: URL, token: string): URL {
  const copy = new URL(url.toString());
  if (token.length > 0) {
    copy.searchParams.set('token', token);
  }
  return copy;
}

function buildEndpoint(config: JeanMcpConfig, path: string): URL {
  const base = new URL(`${config.jeanBaseUrl}/`);
  return new URL(path, base);
}

function redactToken(url: URL): string {
  const clone = new URL(url.toString());
  if (clone.searchParams.has('token')) {
    clone.searchParams.set('token', '[redacted]');
  }
  return clone.toString();
}

async function getJson(
  endpoint: URL,
  timeoutMs: number
): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // Some endpoints can return empty body; this is acceptable.
      data = null;
    }

    return { response, data };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new JeanMcpError('HTTP_TIMEOUT', 'Jean HTTP request timed out.', {
        endpoint: redactToken(endpoint),
        timeoutMs,
      });
    }

    const normalized = normalizeError(error, 'JEAN_UNREACHABLE');
    throw new JeanMcpError(normalized.code, normalized.message, {
      endpoint: redactToken(endpoint),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function assertJeanAuth(config: JeanMcpConfig): Promise<void> {
  const endpoint = withToken(buildEndpoint(config, '/api/auth'), config.jeanToken);
  const { response, data } = await getJson(endpoint, config.requestTimeoutMs);

  if (response.ok) {
    return;
  }

  if (response.status === 401) {
    throw new JeanMcpError('AUTH_INVALID', 'Jean token validation failed.', {
      endpoint: redactToken(endpoint),
    });
  }

  throw new JeanMcpError('AUTH_CHECK_FAILED', 'Jean auth check failed.', {
    status: response.status,
    endpoint: redactToken(endpoint),
    body: data,
  });
}

export async function fetchJeanInit(config: JeanMcpConfig): Promise<unknown> {
  const endpoint = withToken(buildEndpoint(config, '/api/init'), config.jeanToken);
  const { response, data } = await getJson(endpoint, config.requestTimeoutMs);

  if (!response.ok) {
    if (response.status === 401) {
      throw new JeanMcpError('AUTH_INVALID', 'Jean init failed due to invalid token.', {
        endpoint: redactToken(endpoint),
      });
    }

    throw new JeanMcpError('INIT_FAILED', 'Jean init endpoint returned error.', {
      status: response.status,
      endpoint: redactToken(endpoint),
      body: data,
    });
  }

  return data;
}
