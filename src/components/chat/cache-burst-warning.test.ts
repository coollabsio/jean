import { describe, expect, it } from 'vitest'
import { shouldWarnAboutCacheBurst } from './cache-burst-warning'

describe('shouldWarnAboutCacheBurst', () => {
  it('warns when an existing conversation changes effort', () => {
    expect(shouldWarnAboutCacheBurst(true, true, 'medium', 'high')).toBe(true)
  })

  it('does not warn for a new session with no cache', () => {
    expect(shouldWarnAboutCacheBurst(true, false, 'medium', 'high')).toBe(false)
  })

  it('does not warn when the preference is off', () => {
    expect(shouldWarnAboutCacheBurst(false, true, 'medium', 'high')).toBe(false)
  })

  it('does not warn when the level is unchanged', () => {
    expect(shouldWarnAboutCacheBurst(true, true, 'high', 'high')).toBe(false)
  })

  it('does not warn when the current level is unknown', () => {
    expect(shouldWarnAboutCacheBurst(true, true, undefined, 'high')).toBe(false)
  })
})
