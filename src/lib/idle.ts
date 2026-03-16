type IdleCapableWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions
    ) => number
    cancelIdleCallback?: (handle: number) => void
  }

/**
 * Schedule non-critical work after the initial paint. Falls back to a short
 * timeout when requestIdleCallback is unavailable.
 */
export function scheduleIdleWork(
  callback: () => void,
  timeout = 1000
): () => void {
  if (typeof window === 'undefined') {
    return () => {
      /* noop */
    }
  }

  const idleWindow = window as IdleCapableWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(() => callback(), {
      timeout,
    })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }

  const handle = window.setTimeout(callback, Math.min(timeout, 250))
  return () => window.clearTimeout(handle)
}
