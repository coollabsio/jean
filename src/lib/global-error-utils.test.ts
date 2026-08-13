import { describe, expect, it } from 'vitest'
import { shouldSurfaceGlobalError } from './global-error-utils'

describe('shouldSurfaceGlobalError', () => {
  it('does not surface opaque cross-origin script errors', () => {
    expect(shouldSurfaceGlobalError('Script error.')).toBe(false)
  })

  it('surfaces actionable browser errors', () => {
    expect(shouldSurfaceGlobalError('Cannot read properties of undefined')).toBe(
      true
    )
  })
})
