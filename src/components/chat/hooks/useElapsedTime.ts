import { useCallback, useEffect, useState } from 'react'
import { useVisibilityAwareTicker } from '@/hooks/useVisibilityAwareTicker'
import { formatDuration } from '../time-utils'

export function useElapsedTime(startTime: number | null): string | null {
  // Tagged with the startTime it was measured against, so a changed or
  // cleared startTime never shows a stale value.
  const [measured, setMeasured] = useState<{
    startTime: number
    elapsed: number
  } | null>(null)
  const updateElapsed = useCallback(() => {
    if (startTime == null) return
    setMeasured({ startTime, elapsed: Date.now() - startTime })
  }, [startTime])

  useEffect(() => {
    updateElapsed()
  }, [updateElapsed])

  useVisibilityAwareTicker(startTime != null, updateElapsed)

  if (startTime == null || measured?.startTime !== startTime) return null
  return formatDuration(measured.elapsed)
}
