import { useEffect, useRef, useState } from 'react'

export const DEFAULT_VISIBLE_TICK_MS = 1000
export const DEFAULT_HIDDEN_TICK_MS = 30_000

export function useVisibilityAwareTicker(
  enabled: boolean,
  onTick: () => void,
  visibleTickMs = DEFAULT_VISIBLE_TICK_MS,
  hiddenTickMs = DEFAULT_HIDDEN_TICK_MS
) {
  const onTickRef = useRef(onTick)
  useEffect(() => {
    onTickRef.current = onTick
  }, [onTick])

  // Track visibility as state so the ticker effect can remount with a clean
  // setInterval/clearInterval pair (static-analysis-friendly cleanup ownership).
  const [visibilityState, setVisibilityState] = useState<DocumentVisibilityState>(
    () =>
      typeof document !== 'undefined' ? document.visibilityState : 'visible'
  )

  useEffect(() => {
    if (typeof document === 'undefined') return

    const handleVisibilityChange = () => {
      setVisibilityState(document.visibilityState)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return

    // Fire immediately on enable / visibility / interval change, then tick.
    onTickRef.current()

    if (typeof document === 'undefined') return

    const ms =
      visibilityState === 'hidden' ? hiddenTickMs : visibleTickMs
    const id = setInterval(() => {
      onTickRef.current()
    }, ms)

    return () => {
      clearInterval(id)
    }
  }, [enabled, visibilityState, visibleTickMs, hiddenTickMs])
}
