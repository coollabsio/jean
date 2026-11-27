import { describe, expect, it } from 'vitest'
import { hasLinearAccess } from './linear'

describe('hasLinearAccess', () => {
  it('is false when no key is set', () => {
    expect(hasLinearAccess(undefined, undefined)).toBe(false)
    expect(
      hasLinearAccess({ linear_api_key: '  ' }, { linear_api_key: null })
    ).toBe(false)
  })

  it('accepts a project key', () => {
    expect(
      hasLinearAccess({ linear_api_key: 'lin_api_x' }, { linear_api_key: null })
    ).toBe(true)
  })

  it('accepts a global key', () => {
    expect(
      hasLinearAccess({ linear_api_key: null }, { linear_api_key: 'lin_api_x' })
    ).toBe(true)
  })

  it('accepts a redacted global key from a remote server', () => {
    expect(
      hasLinearAccess(
        { linear_api_key: null },
        { linear_api_key: null, linear_api_key_configured: true }
      )
    ).toBe(true)
  })
})
