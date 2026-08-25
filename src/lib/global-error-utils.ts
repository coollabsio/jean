/** Opaque cross-origin browser errors contain no actionable diagnostic data. */
export function shouldSurfaceGlobalError(message: string): boolean {
  return message.trim().toLowerCase() !== 'script error.'
}
