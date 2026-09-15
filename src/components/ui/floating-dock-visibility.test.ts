import { describe, expect, it } from 'vitest'
import { shouldHideFloatingDock } from './floating-dock-visibility'

describe('shouldHideFloatingDock', () => {
  it('hides the dock on every viewport while zen mode is active', () => {
    expect(shouldHideFloatingDock(true, true)).toBe(true)
    expect(shouldHideFloatingDock(true, false)).toBe(false)
    expect(shouldHideFloatingDock(false, true)).toBe(true)
    expect(shouldHideFloatingDock(false, false)).toBe(false)
  })
})
