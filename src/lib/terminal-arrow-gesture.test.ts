import { afterEach, describe, expect, it } from 'vitest'
import {
  ARROW_GESTURE_GEAR0_INITIAL_REPEAT_DELAY_MS,
  ARROW_GESTURE_GEAR_INTERVALS_MS,
  ARROW_KEY_SEQUENCES,
  arrowRepeatIntervalMs,
  isArrowGestureActive,
  resolveArrowDirection,
  resolveArrowSpeedGear,
  setArrowGestureActive,
} from './terminal-arrow-gesture'

describe('resolveArrowDirection', () => {
  it('returns null inside the deadzone', () => {
    expect(resolveArrowDirection(0, 0, 24)).toBeNull()
    expect(resolveArrowDirection(10, 5, 24)).toBeNull()
  })

  it('picks the dominant axis', () => {
    expect(resolveArrowDirection(0, -40, 24)).toBe('up')
    expect(resolveArrowDirection(0, 40, 24)).toBe('down')
    expect(resolveArrowDirection(-40, 0, 24)).toBe('left')
    expect(resolveArrowDirection(40, 0, 24)).toBe('right')
  })

  it('prefers horizontal when equal magnitude', () => {
    expect(resolveArrowDirection(30, 30, 24)).toBe('right')
    expect(resolveArrowDirection(-30, 30, 24)).toBe('left')
  })
})

describe('speed gears', () => {
  it('starts at gear 0 near the origin', () => {
    expect(resolveArrowSpeedGear(30)).toBe(0)
  })

  it('steps up with pull distance (3 gears)', () => {
    expect(resolveArrowSpeedGear(10)).toBe(0)
    expect(resolveArrowSpeedGear(56)).toBe(1)
    expect(resolveArrowSpeedGear(112)).toBe(2)
  })

  it('shortens the repeat interval at higher gears', () => {
    const slow = arrowRepeatIntervalMs(30)
    const mid = arrowRepeatIntervalMs(60)
    const fast = arrowRepeatIntervalMs(130)
    expect(slow).toBe(ARROW_GESTURE_GEAR_INTERVALS_MS[0])
    expect(mid).toBe(ARROW_GESTURE_GEAR_INTERVALS_MS[1])
    expect(fast).toBe(ARROW_GESTURE_GEAR_INTERVALS_MS[2])
    expect(slow).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(fast)
  })

  it('delays the first auto-repeat at gear 0 so one step stays deliberate', () => {
    expect(arrowRepeatIntervalMs(30, true)).toBe(
      ARROW_GESTURE_GEAR0_INITIAL_REPEAT_DELAY_MS
    )
    // Higher gears keep their normal interval for the first repeat.
    expect(arrowRepeatIntervalMs(60, true)).toBe(
      ARROW_GESTURE_GEAR_INTERVALS_MS[1]
    )
    expect(arrowRepeatIntervalMs(130, true)).toBe(
      ARROW_GESTURE_GEAR_INTERVALS_MS[2]
    )
  })
})

describe('ARROW_KEY_SEQUENCES', () => {
  it('uses standard CSI arrow sequences', () => {
    expect(ARROW_KEY_SEQUENCES.up).toBe('\x1b[A')
    expect(ARROW_KEY_SEQUENCES.down).toBe('\x1b[B')
    expect(ARROW_KEY_SEQUENCES.right).toBe('\x1b[C')
    expect(ARROW_KEY_SEQUENCES.left).toBe('\x1b[D')
  })
})

describe('active gesture registry', () => {
  afterEach(() => {
    setArrowGestureActive('term-1', false)
  })

  it('tracks active state for touch-scroll coordination', () => {
    expect(isArrowGestureActive('term-1')).toBe(false)
    setArrowGestureActive('term-1', true)
    expect(isArrowGestureActive('term-1')).toBe(true)
    setArrowGestureActive('term-1', false)
    expect(isArrowGestureActive('term-1')).toBe(false)
  })
})
