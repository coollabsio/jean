import { describe, it, expect } from 'vitest'
import { isUsageLimitError } from './usage-limit'

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
      isUsageLimitError('Claude usage limit reached. Your limit will reset at 2PM.')
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
