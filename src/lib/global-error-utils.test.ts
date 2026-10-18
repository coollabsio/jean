import { describe, expect, it } from 'vitest'
import { shouldSurfaceGlobalError } from './global-error-utils'

describe('shouldSurfaceGlobalError', () => {
  it('does not surface opaque cross-origin script errors', () => {
    expect(shouldSurfaceGlobalError('Script error.')).toBe(false)
  })

  it.each([
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
    '  ResizeObserver loop completed with undelivered notifications.  ',
  ])('does not surface the browser resize notification: %s', message => {
    expect(shouldSurfaceGlobalError(message)).toBe(false)
  })

  it('still surfaces actual ResizeObserver failures', () => {
    expect(shouldSurfaceGlobalError('ResizeObserver is not defined')).toBe(true)
    expect(
      shouldSurfaceGlobalError(
        "Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'."
      )
    ).toBe(true)
  })

  it('surfaces actionable browser errors', () => {
    expect(
      shouldSurfaceGlobalError('Cannot read properties of undefined')
    ).toBe(true)
  })
})
