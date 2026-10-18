import { describe, expect, it } from 'vitest'
import {
  formatCompactDuration,
  formatPlanName,
  formatResetAt,
  formatResetCountdown,
  formatUsagePair,
} from './usage-format'

describe('formatUsagePair', () => {
  it('shows session and weekly values', () => {
    expect(formatUsagePair(9.4, 10.6)).toBe('9|11%')
  })

  it('shows only weekly when there is no session window', () => {
    expect(formatUsagePair(null, 9)).toBe('9%')
    expect(formatUsagePair(undefined, 9)).toBe('9%')
  })

  it('shows placeholders when data is missing', () => {
    expect(formatUsagePair(null, null)).toBe('--|--%')
    expect(formatUsagePair(9, null)).toBe('9|--%')
  })
})

describe('formatCompactDuration', () => {
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  it('shows days and hours', () => {
    expect(formatCompactDuration(3 * day + 11 * hour + 40 * minute)).toBe(
      '3d 11h'
    )
    expect(formatCompactDuration(2 * day + 30 * minute)).toBe('2d')
  })

  it('shows hours and minutes below one day', () => {
    expect(formatCompactDuration(4 * hour + 12 * minute)).toBe('4h 12m')
    expect(formatCompactDuration(5 * hour)).toBe('5h')
  })

  it('shows minutes below one hour', () => {
    expect(formatCompactDuration(59 * minute + 59_000)).toBe('59m')
    expect(formatCompactDuration(30_000)).toBe('<1m')
  })
})

describe('formatResetCountdown', () => {
  const now = 1_700_000_000_000

  it('accepts seconds and milliseconds', () => {
    const inSeconds = now / 1000 + 3 * 86_400 + 11 * 3600
    expect(formatResetCountdown(inSeconds, now)).toBe('3d 11h')
    expect(formatResetCountdown(inSeconds * 1000, now)).toBe('3d 11h')
  })

  it('shows now for past resets', () => {
    expect(formatResetCountdown(now / 1000 - 60, now)).toBe('now')
  })
})

describe('formatResetAt', () => {
  const now = new Date(2026, 8, 25, 10, 0).getTime()

  it('shows only the time within one day', () => {
    const target = new Date(2026, 8, 25, 14, 0)
    expect(formatResetAt(target.getTime() / 1000, now)).toBe(
      target.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    )
  })

  it('adds the weekday for later resets', () => {
    const target = new Date(2026, 8, 28, 14, 0)
    expect(formatResetAt(target.getTime() / 1000, now)).toBe(
      target.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    )
  })
})

describe('formatPlanName', () => {
  it('adds the Claude Max multiplier from the rate limit tier', () => {
    expect(formatPlanName('max', 'default_claude_max_20x')).toBe('Max 20x')
    expect(formatPlanName('max', 'default_claude_max_5x')).toBe('Max 5x')
    expect(formatPlanName('max', null)).toBe('Max')
    expect(formatPlanName('pro', 'default_claude_ai')).toBe('Pro')
  })

  it('title-cases raw plan ids', () => {
    expect(formatPlanName('plus')).toBe('Plus')
    expect(formatPlanName('self_serve_business')).toBe('Self Serve Business')
  })

  it('keeps already formatted names', () => {
    expect(formatPlanName('X Premium+')).toBe('X Premium+')
  })

  it('returns null without a plan', () => {
    expect(formatPlanName(null)).toBeNull()
    expect(formatPlanName('  ')).toBeNull()
  })
})
