import { useCallback, useEffect, useRef } from 'react'
import { useLatestRef } from './useLatestRef'

/**
 * Run `onIntent(arg)` after the pointer rests on an element for `delayMs`.
 * Moving across a list quickly fires nothing. One timer serves a whole list,
 * because only one element can be hovered at a time.
 */
export function useHoverIntent<T>(
  onIntent: (arg: T) => void,
  delayMs = 100
): { start: (arg: T) => void; cancel: () => void } {
  const onIntentRef = useLatestRef(onIntent)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const start = useCallback(
    (arg: T) => {
      cancel()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        onIntentRef.current(arg)
      }, delayMs)
    },
    [cancel, delayMs, onIntentRef]
  )

  useEffect(() => cancel, [cancel])

  return { start, cancel }
}
