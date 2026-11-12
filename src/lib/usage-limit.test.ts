import { describe, it, expect } from 'vitest'
import {
  getLimitResetAtMs,
  isClaudeTermsError,
  isUsageLimitError,
} from './usage-limit'

describe('isUsageLimitError', () => {
  it('matches Claude session limit messages with a local reset time', () => {
    expect(
      isUsageLimitError(
        "You've hit your session limit · resets 1:10am (Asia/Tbilisi)"
      )
    ).toBe(true)
  })

  it('matches real backend limit messages', () => {
    expect(
      isUsageLimitError(
        'Claude usage limit reached. Your limit will reset at 2PM.'
      )
    ).toBe(true)
    expect(isUsageLimitError('5-hour usage limit reached.')).toBe(true)
    expect(isUsageLimitError('Rate limit exceeded, try again later')).toBe(true)
    expect(isUsageLimitError('quota exceeded')).toBe(true)
    expect(isUsageLimitError('Request failed with status code 429')).toBe(true)
    expect(isUsageLimitError('{"error":{"code":429}}')).toBe(true)
    expect(isUsageLimitError('Too Many Requests')).toBe(true)
  })

  it('does not match generic errors', () => {
    expect(isUsageLimitError('Please run /login to authenticate')).toBe(false)
    expect(isUsageLimitError('Connection refused')).toBe(false)
    expect(isUsageLimitError('Syntax error in file')).toBe(false)
    expect(isUsageLimitError('')).toBe(false)
    expect(isUsageLimitError(null)).toBe(false)
    expect(isUsageLimitError(undefined)).toBe(false)
  })
})

describe('getLimitResetAtMs', () => {
  const window = (usedPercent: number, resetsAt: number | null) => ({
    usedPercent,
    resetsAt,
  })

  it('uses the session reset when no window is exhausted', () => {
    expect(
      getLimitResetAtMs({
        session: window(80, 1_700_000_000),
        weekly: window(40, 1_700_500_000),
      })
    ).toBe(1_700_000_000_000)
  })

  it('waits for an exhausted weekly window instead of the session window', () => {
    expect(
      getLimitResetAtMs({
        session: window(30, 1_700_000_000),
        weekly: window(100, 1_700_500_000),
      })
    ).toBe(1_700_500_000_000)
  })

  it('picks the latest reset when several windows are exhausted', () => {
    expect(
      getLimitResetAtMs({
        session: window(100, 1_700_600_000),
        weekly: window(100, 1_700_500_000),
      })
    ).toBe(1_700_600_000_000)
  })

  it('returns null when no reset time is known', () => {
    expect(getLimitResetAtMs(undefined)).toBeNull()
    expect(getLimitResetAtMs({ session: null, weekly: null })).toBeNull()
    expect(
      getLimitResetAtMs({ session: window(100, null), weekly: null })
    ).toBeNull()
  })
})

describe('isClaudeTermsError', () => {
  it('detects the Consumer Terms error from Claude', () => {
    expect(
      isClaudeTermsError(
        "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue."
      )
    ).toBe(true)
  })

  it('ignores other errors', () => {
    expect(isClaudeTermsError('API Error: 400 invalid request')).toBe(false)
    expect(isClaudeTermsError('Usage limit reached')).toBe(false)
    expect(isClaudeTermsError(null)).toBe(false)
  })

  it('is not a usage limit error', () => {
    expect(
      isUsageLimitError(
        "API Error: 400 We've updated our Consumer Terms and Privacy Policy."
      )
    ).toBe(false)
  })
})
