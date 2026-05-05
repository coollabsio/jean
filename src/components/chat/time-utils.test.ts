import { describe, expect, it } from 'vitest'
import { formatDuration, formatLocalTime } from './time-utils'

describe('formatDuration', () => {
  it('floors milliseconds to whole seconds', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(999)).toBe('0s')
    expect(formatDuration(1500)).toBe('1s')
    expect(formatDuration(145_000)).toBe('145s')
  })
})

describe('formatLocalTime', () => {
  it('returns the same string the platform produces for hour/minute/second', () => {
    const ts = Date.UTC(2026, 3, 25, 12, 34, 56)
    const expected = new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    expect(formatLocalTime(ts)).toBe(expected)
  })

  it('renders distinct times for different timestamps', () => {
    const a = Date.UTC(2026, 3, 25, 9, 0, 0)
    const b = Date.UTC(2026, 3, 25, 21, 0, 0)
    expect(formatLocalTime(a)).not.toBe(formatLocalTime(b))
  })
})
