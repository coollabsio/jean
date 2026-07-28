import { describe, expect, it } from 'vitest'
import {
  formatUsagePair,
  getUsageSeverityPercent,
  isUsageCapableBackend,
  resolveActiveUsageEntry,
  usageSeverityTextClass,
  type UsageEntry,
} from './usage-indicator-utils'

function entry(
  partial: Partial<UsageEntry> & Pick<UsageEntry, 'id'>
): UsageEntry {
  return {
    label: partial.id,
    plan: null,
    session: null,
    weekly: null,
    available: true,
    ...partial,
  }
}

describe('formatUsagePair', () => {
  it('formats rounded session and weekly percents', () => {
    expect(formatUsagePair(12.4, 88.6)).toBe('12|89%')
  })

  it('uses -- for missing windows', () => {
    expect(formatUsagePair(null, 40)).toBe('--|40%')
    expect(formatUsagePair(10, undefined)).toBe('10|--%')
    expect(formatUsagePair(null, null)).toBe('--|--%')
  })
})

describe('isUsageCapableBackend', () => {
  it('accepts claude, codex, and grok only', () => {
    expect(isUsageCapableBackend('claude')).toBe(true)
    expect(isUsageCapableBackend('codex')).toBe(true)
    expect(isUsageCapableBackend('grok')).toBe(true)
    expect(isUsageCapableBackend('opencode')).toBe(false)
    expect(isUsageCapableBackend('pi')).toBe(false)
    expect(isUsageCapableBackend(undefined)).toBe(false)
  })
})

describe('getUsageSeverityPercent / usageSeverityTextClass', () => {
  it('uses the higher of session and weekly', () => {
    expect(getUsageSeverityPercent(40, 75)).toBe(75)
    expect(getUsageSeverityPercent(95, 10)).toBe(95)
    expect(getUsageSeverityPercent(null, null)).toBeNull()
  })

  it('maps thresholds to text classes', () => {
    expect(usageSeverityTextClass(10, 20)).toBe('text-muted-foreground')
    expect(usageSeverityTextClass(70, 20)).toBe('text-amber-500')
    expect(usageSeverityTextClass(20, 91)).toBe('text-destructive')
    expect(usageSeverityTextClass(null, null)).toBe('text-muted-foreground')
  })
})

describe('resolveActiveUsageEntry', () => {
  const entries = [
    entry({ id: 'claude', session: 10, weekly: 20 }),
    entry({ id: 'codex', session: 30, weekly: 40 }),
  ]

  it('prefers the selected usage-capable backend', () => {
    expect(resolveActiveUsageEntry(entries, 'codex')?.id).toBe('codex')
  })

  it('falls back to the first available entry for non-usage backends', () => {
    expect(resolveActiveUsageEntry(entries, 'opencode')?.id).toBe('claude')
  })

  it('returns null when nothing is available', () => {
    expect(resolveActiveUsageEntry([], 'claude')).toBeNull()
  })
})
