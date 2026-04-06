import { JeanMcpError } from './utils/errors.js';
import type { LogLevel } from './utils/logger.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_CHAT_TASK_TTL_MS = 15 * 60_000;
const DEFAULT_CHAT_TASK_POLL_MS = 1_500;
const DEFAULT_CHAT_TASK_TIMEOUT_MS = 10 * 60_000;

export interface JeanMcpConfig {
  jeanBaseUrl: string;
  jeanToken: string;
  requestTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  chatTaskTtlMs: number;
  chatTaskPollIntervalMs: number;
  chatTaskTimeoutMs: number;
  logLevel: LogLevel;
}

const LOG_LEVELS: ReadonlySet<string> = new Set([
  'debug',
  'info',
  'warn',
  'error',
]);

function parsePositiveInt(
  key: string,
  rawValue: string | undefined,
  fallback: number
): number {
  if (!rawValue) return fallback;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new JeanMcpError(
      'INVALID_CONFIG',
      `${key} must be a positive integer.`,
      { key, rawValue }
    );
  }

  return parsed;
}

function normalizeBaseUrl(rawValue: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new JeanMcpError('INVALID_CONFIG', 'JEAN_BASE_URL must be a valid URL.', {
      value: rawValue,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new JeanMcpError(
      'INVALID_CONFIG',
      'JEAN_BASE_URL protocol must be http or https.',
      {
        value: rawValue,
      }
    );
  }

  // Keep origin + optional base path, but remove trailing slash to make URL joins predictable.
  const normalized = rawValue.replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : rawValue;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JeanMcpConfig {
  const jeanBaseUrl = normalizeBaseUrl(
    (env.JEAN_BASE_URL ?? DEFAULT_BASE_URL).trim()
  );

  const jeanToken = (env.JEAN_TOKEN ?? '').trim();
  const requestTimeoutMs = parsePositiveInt(
    'JEAN_TIMEOUT_MS',
    env.JEAN_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const reconnectBaseMs = parsePositiveInt(
    'JEAN_RECONNECT_BASE_MS',
    env.JEAN_RECONNECT_BASE_MS,
    DEFAULT_RECONNECT_BASE_MS
  );
  const reconnectMaxMs = parsePositiveInt(
    'JEAN_RECONNECT_MAX_MS',
    env.JEAN_RECONNECT_MAX_MS,
    DEFAULT_RECONNECT_MAX_MS
  );
  const chatTaskTtlMs = parsePositiveInt(
    'JEAN_CHAT_TASK_TTL_MS',
    env.JEAN_CHAT_TASK_TTL_MS,
    DEFAULT_CHAT_TASK_TTL_MS
  );
  const chatTaskPollIntervalMs = parsePositiveInt(
    'JEAN_CHAT_TASK_POLL_MS',
    env.JEAN_CHAT_TASK_POLL_MS,
    DEFAULT_CHAT_TASK_POLL_MS
  );
  const chatTaskTimeoutMs = parsePositiveInt(
    'JEAN_CHAT_TASK_TIMEOUT_MS',
    env.JEAN_CHAT_TASK_TIMEOUT_MS,
    DEFAULT_CHAT_TASK_TIMEOUT_MS
  );

  if (reconnectBaseMs > reconnectMaxMs) {
    throw new JeanMcpError(
      'INVALID_CONFIG',
      'JEAN_RECONNECT_BASE_MS cannot be greater than JEAN_RECONNECT_MAX_MS.',
      { reconnectBaseMs, reconnectMaxMs }
    );
  }

  const rawLogLevel = (env.JEAN_LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!LOG_LEVELS.has(rawLogLevel)) {
    throw new JeanMcpError('INVALID_CONFIG', 'JEAN_LOG_LEVEL is invalid.', {
      value: rawLogLevel,
      accepted: Array.from(LOG_LEVELS),
    });
  }

  return {
    jeanBaseUrl,
    jeanToken,
    requestTimeoutMs,
    reconnectBaseMs,
    reconnectMaxMs,
    chatTaskTtlMs,
    chatTaskPollIntervalMs,
    chatTaskTimeoutMs,
    logLevel: rawLogLevel as LogLevel,
  };
}
