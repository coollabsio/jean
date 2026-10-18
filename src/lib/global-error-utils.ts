/** Keep browser diagnostics in the logs without showing application-error toasts. */
export function shouldSurfaceGlobalError(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  // ResizeObserver defers undelivered notifications to the next paint. Menus
  // can trigger this during layout; it does not mean the application failed.
  // https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver#observation_errors
  return (
    normalized !== 'script error.' &&
    normalized !==
      'resizeobserver loop completed with undelivered notifications.' &&
    normalized !== 'resizeobserver loop limit exceeded'
  )
}
