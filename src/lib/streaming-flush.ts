/**
 * Adaptive streaming flush policy for chat:chunk / chat:thinking buffers.
 *
 * Short streams flush every animation frame (~60Hz) for snappy token display.
 * Once accumulated content is large, cap flushes to ~30Hz so WebKitGTK (Linux)
 * does not re-parse markdown + repaint at full token rate (issue #129).
 */

/** Minimum interval between flushes when streaming content is long. */
export const STREAMING_LONG_FLUSH_INTERVAL_MS = 32

/**
 * Content length (existing + buffered) at which flushes switch from every rAF
 * to a capped interval. Chosen to cover typical short replies at full rate.
 */
export const STREAMING_LONG_CONTENT_THRESHOLD = 2048

/**
 * Returns true when the stream should use the throttled flush interval
 * instead of every animation frame.
 */
export function shouldThrottleStreamingFlush(
  existingContentLength: number,
  bufferedLength: number
): boolean {
  return (
    existingContentLength + bufferedLength >= STREAMING_LONG_CONTENT_THRESHOLD
  )
}

/**
 * Delay (ms) before the next throttled flush given when the last flush ran.
 * 0 means flush immediately (via rAF or sync).
 */
export function streamingFlushDelayMs(
  lastFlushAtMs: number,
  nowMs: number,
  minIntervalMs: number = STREAMING_LONG_FLUSH_INTERVAL_MS
): number {
  if (lastFlushAtMs <= 0) return 0
  const elapsed = nowMs - lastFlushAtMs
  return Math.max(0, minIntervalMs - elapsed)
}
