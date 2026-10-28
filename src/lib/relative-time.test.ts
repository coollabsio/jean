import { describe, expect, it } from 'vitest'
import { formatRelative } from './relative-time'

describe('formatRelative', () => {
  const now = 1_000_000_000_000
  const ago = (seconds: number) => formatRelative(now / 1000 - seconds, now)

  it('formats each unit', () => {
    expect(ago(2)).toBe('now')
    expect(ago(30)).toBe('30s ago')
    expect(ago(120)).toBe('2m ago')
    expect(ago(3 * 3600)).toBe('3h ago')
    expect(ago(3 * 86_400)).toBe('3d ago')
    expect(ago(65 * 86_400)).toBe('2mo ago')
    expect(ago(800 * 86_400)).toBe('2y ago')
  })

  it('formats future times', () => {
    expect(formatRelative(now / 1000 + 7200, now)).toBe('in 2h')
  })
})
