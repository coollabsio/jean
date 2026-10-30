import { describe, expect, it } from 'vitest'
import { resolveSwipeEnd } from './swipe-action-row'

describe('resolveSwipeEnd', () => {
  it('runs the action after a swipe over half the row', () => {
    expect(resolveSwipeEnd(-200, 400)).toBe('trigger')
  })

  it('keeps the action visible after a medium swipe', () => {
    expect(resolveSwipeEnd(-60, 400)).toBe('open')
  })

  it('snaps back after a short swipe or a right swipe', () => {
    expect(resolveSwipeEnd(-20, 400)).toBe('reset')
    expect(resolveSwipeEnd(0, 400)).toBe('reset')
  })
})
