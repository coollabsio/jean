import { ZodError } from 'zod';

export class JeanMcpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'JeanMcpError';
  }
}

export function normalizeError(
  error: unknown,
  fallbackCode = 'INTERNAL_ERROR'
): JeanMcpError {
  if (error instanceof JeanMcpError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new JeanMcpError('INVALID_ARGUMENTS', 'Tool arguments are invalid.', {
      issues: error.issues,
    });
  }

  if (error instanceof Error) {
    return new JeanMcpError(fallbackCode, error.message);
  }

  return new JeanMcpError(fallbackCode, 'Unknown error', { error });
}

export function toolSuccess(result: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

export function toolError(error: unknown) {
  const normalized = normalizeError(error);

  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: normalized.message,
            code: normalized.code,
            details: normalized.details ?? null,
          },
          null,
          2
        ),
      },
    ],
  };
}
