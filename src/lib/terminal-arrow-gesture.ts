/**
 * Termius-style long-press + drag arrow-key gesture helpers.
 * Long-press the terminal, drag in a direction → CSI arrow sequences.
 * Pull farther from the press origin → faster repeat (3 speed gears).
 */

export type ArrowDirection = 'up' | 'down' | 'left' | 'right'

/** Speed gear 0 (slowest / closest) … 2 (fastest / farthest pull). */
export type ArrowSpeedGear = 0 | 1 | 2

export const ARROW_KEY_SEQUENCES: Record<ArrowDirection, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
}

/** Hold duration before the gesture pad activates (ms). */
export const ARROW_GESTURE_LONG_PRESS_MS = 400

/** Finger movement before long-press fires cancels the gesture (user is scrolling). */
export const ARROW_GESTURE_CANCEL_MOVE_PX = 12

/** Deadzone around the origin before a direction registers. */
export const ARROW_GESTURE_DEADZONE_PX = 24

/**
 * Distance thresholds (px from press origin) for gears 0 / 1 / 2.
 * Index i is the minimum distance to reach gear i.
 * Gear 0 starts as soon as the deadzone is cleared.
 */
export const ARROW_GESTURE_GEAR_DISTANCES = [0, 56, 112] as const

/**
 * Auto-repeat interval per gear (ms).
 * Gear 0 is deliberately slow so a short pull steps once at a time.
 */
export const ARROW_GESTURE_GEAR_INTERVALS_MS = [520, 240, 100] as const

/**
 * Extra delay before the first auto-repeat at gear 0, so one intentional
 * step doesn't immediately become a stream.
 */
export const ARROW_GESTURE_GEAR0_INITIAL_REPEAT_DELAY_MS = 650

const activeGestures = new Set<string>()

/** Touch-scroll and other handlers consult this to yield during arrow gestures. */
export function setArrowGestureActive(
  terminalId: string,
  active: boolean
): void {
  if (active) activeGestures.add(terminalId)
  else activeGestures.delete(terminalId)
}

export function isArrowGestureActive(terminalId: string): boolean {
  return activeGestures.has(terminalId)
}

/** Resolve dominant direction from delta, or null inside the deadzone. */
export function resolveArrowDirection(
  dx: number,
  dy: number,
  deadzonePx: number = ARROW_GESTURE_DEADZONE_PX
): ArrowDirection | null {
  const dist = Math.hypot(dx, dy)
  if (dist < deadzonePx) return null
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0 ? 'right' : 'left'
  }
  return dy > 0 ? 'down' : 'up'
}

/** Gear index 0..2 from distance to origin (0 = slowest / closest). */
export function resolveArrowSpeedGear(
  distancePx: number,
  gearDistances: readonly number[] = ARROW_GESTURE_GEAR_DISTANCES
): ArrowSpeedGear {
  let gear: ArrowSpeedGear = 0
  for (let i = 1; i < gearDistances.length; i++) {
    const threshold = gearDistances[i]
    if (threshold !== undefined && distancePx >= threshold) {
      gear = i as ArrowSpeedGear
    }
  }
  return gear
}

/**
 * Delay until the next auto-repeat tick.
 * @param isFirstRepeat - true for the pause after the initial keypress
 *   (gear 0 waits longer so a short pull is one deliberate step).
 */
export function arrowRepeatIntervalMs(
  distancePx: number,
  isFirstRepeat = false,
  gearIntervals: readonly number[] = ARROW_GESTURE_GEAR_INTERVALS_MS
): number {
  const gear = resolveArrowSpeedGear(distancePx)
  const base =
    gearIntervals[gear] ??
    gearIntervals[gearIntervals.length - 1] ??
    ARROW_GESTURE_GEAR_INTERVALS_MS[0]
  if (isFirstRepeat && gear === 0) {
    return ARROW_GESTURE_GEAR0_INITIAL_REPEAT_DELAY_MS
  }
  return base
}
