import { useEffect, useState } from 'react'
import { isModKeyEvent } from '@/types/keybindings'

type ModifierState = Pick<
  KeyboardEvent,
  'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>

/** Wait before showing hints, so quick shortcuts such as Cmd+C do not flash them. */
export const MODIFIER_HINT_SHOW_DELAY_MS = 200

/** Mod (Cmd on macOS desktop, Ctrl elsewhere) without Shift or Alt. */
export function isModOnlyHeld(event: ModifierState): boolean {
  return isModKeyEvent(event) && !event.shiftKey && !event.altKey
}

/**
 * True while the modifier combination matched by `isHeld` is pressed.
 * Use it to show keyboard shortcut hints only on demand. Pass a stable
 * (module-level) `isHeld` function.
 */
export function useModifierHintsVisible(
  isHeld: (event: ModifierState) => boolean,
  enabled = true
): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setVisible(false)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      clearTimeout(timer)
      timer = undefined
      setVisible(false)
    }
    const update = (event: KeyboardEvent) => {
      if (!isHeld(event)) return hide()
      // Only a modifier-only press starts the timer. A shortcut key pressed
      // while the modifier is held cancels a pending show.
      if (!['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) {
        clearTimeout(timer)
        timer = undefined
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => setVisible(true), MODIFIER_HINT_SHOW_DELAY_MS)
    }
    window.addEventListener('keydown', update, { capture: true })
    window.addEventListener('keyup', update, { capture: true })
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', update, { capture: true })
      window.removeEventListener('keyup', update, { capture: true })
      window.removeEventListener('blur', hide)
    }
  }, [enabled, isHeld])

  return visible
}
