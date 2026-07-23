import { describe, expect, it } from 'vitest'
import {
  shouldThrottleStreamingFlush,
  streamingFlushDelayMs,
  STREAMING_LONG_CONTENT_THRESHOLD,
  STREAMING_LONG_FLUSH_INTERVAL_MS,
} from './streaming-flush'

describe('shouldThrottleStreamingFlush', () => {
  it('keeps short streams on every-frame flushes', () => {
    expect(shouldThrottleStreamingFlush(0, 100)).toBe(false)
    expect(
      shouldThrottleStreamingFlush(STREAMING_LONG_CONTENT_THRESHOLD - 2, 1)
    ).toBe(false)
  })

  it('throttles once existing + buffered content reaches the threshold', () => {
    expect(
      shouldThrottleStreamingFlush(STREAMING_LONG_CONTENT_THRESHOLD, 0)
    ).toBe(true)
    expect(
      shouldThrottleStreamingFlush(STREAMING_LONG_CONTENT_THRESHOLD - 10, 10)
    ).toBe(true)
    expect(shouldThrottleStreamingFlush(10_000, 50)).toBe(true)
  })
})

describe('streamingFlushDelayMs', () => {
  it('flushes immediately when no prior flush has run', () => {
    expect(streamingFlushDelayMs(0, 1000)).toBe(0)
  })

  it('returns remaining interval when last flush was recent', () => {
    expect(
      streamingFlushDelayMs(1000, 1010, STREAMING_LONG_FLUSH_INTERVAL_MS)
    ).toBe(STREAMING_LONG_FLUSH_INTERVAL_MS - 10)
  })

  it('returns 0 when the min interval has already elapsed', () => {
    expect(
      streamingFlushDelayMs(1000, 1000 + STREAMING_LONG_FLUSH_INTERVAL_MS, 32)
    ).toBe(0)
    expect(streamingFlushDelayMs(1000, 2000, 32)).toBe(0)
  })
})
