import { describe, expect, it } from 'vitest'
import { formatRecentActivity, isSnoozedSession } from './RecentWorktreesList'

describe('formatRecentActivity', () => {
  const now = 1_800_000_000_000

  it.each([
    [now / 1000, 'now'],
    [(now - 5 * 60_000) / 1000, '5m'],
    [(now - 3 * 60 * 60_000) / 1000, '3h'],
    [(now - 4 * 24 * 60 * 60_000) / 1000, '4d'],
    [(now - 60 * 24 * 60 * 60_000) / 1000, '2mo'],
  ])('formats %s as %s', (timestamp, expected) => {
    expect(formatRecentActivity(timestamp, now)).toBe(expected)
  })
})

describe('isSnoozedSession', () => {
  const now = new Date('2026-09-17T12:00:00Z').getTime()

  it('snoozes sessions inactive for more than 24 hours', () => {
    expect(isSnoozedSession(now / 1000 - 24 * 60 * 60 - 1, now)).toBe(true)
  })

  it('snoozes sessions at the 24-hour boundary', () => {
    expect(isSnoozedSession(now / 1000 - 24 * 60 * 60, now)).toBe(true)
  })

  it('keeps sessions active within the last 24 hours', () => {
    expect(isSnoozedSession(now / 1000 - 24 * 60 * 60 + 1, now)).toBe(false)
  })
})
