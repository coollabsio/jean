import { useCallback, useState } from 'react'
import { useVisibilityAwareTicker } from '@/hooks/useVisibilityAwareTicker'

/** Current time in ms, refreshed every `intervalMs` while enabled. */
export function useNow(enabled = true, intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  const tick = useCallback(() => setNow(Date.now()), [])
  useVisibilityAwareTicker(enabled, tick, intervalMs, intervalMs)
  return now
}
