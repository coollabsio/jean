import { JeanMcpError } from '../utils/errors.js';

export function pickDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function requireAny<T>(
  label: string,
  ...values: Array<T | undefined>
): T {
  const value = pickDefined(...values);
  if (value === undefined) {
    throw new JeanMcpError('INVALID_ARGUMENTS', `Missing required field: ${label}`);
  }
  return value;
}

export function omitUndefined(
  input: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
