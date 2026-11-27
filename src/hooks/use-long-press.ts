import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE_PX = 10

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onContextMenu: (e: { preventDefault: () => void }) => void
}

/**
 * Calls `onLongPress` after the pointer stays down for `LONG_PRESS_MS` without
 * moving. The click that follows a long press still fires: call
 * `consumeLongPress()` in `onClick` and skip the click when it returns true.
 */
export function useLongPress(onLongPress: () => void): {
  handlers: LongPressHandlers
  consumeLongPress: () => boolean
} {
  const onLongPressRef = useRef(onLongPress)
  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])
  const pressRef = useRef<{
    timer: ReturnType<typeof setTimeout>
    x: number
    y: number
  } | null>(null)
  const firedRef = useRef(false)

  const cancel = useCallback(() => {
    if (pressRef.current) clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  const handlers = useMemo<LongPressHandlers>(
    () => ({
      onPointerDown: e => {
        cancel()
        firedRef.current = false
        pressRef.current = {
          x: e.clientX,
          y: e.clientY,
          timer: setTimeout(() => {
            pressRef.current = null
            firedRef.current = true
            onLongPressRef.current()
          }, LONG_PRESS_MS),
        }
      },
      onPointerMove: e => {
        const press = pressRef.current
        if (!press) return
        const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y)
        if (moved > LONG_PRESS_MOVE_TOLERANCE_PX) cancel()
      },
      // No pointerleave: touch can fire it while the finger is still down.
      onPointerUp: cancel,
      onPointerCancel: cancel,
      // Stop the system menu (text selection, link preview) on touch.
      onContextMenu: e => e.preventDefault(),
    }),
    [cancel]
  )

  const consumeLongPress = useCallback(() => {
    const fired = firedRef.current
    firedRef.current = false
    return fired
  }, [])

  return { handlers, consumeLongPress }
}
