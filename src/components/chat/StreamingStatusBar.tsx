import { memo } from 'react'
import { useElapsedTime } from './hooks/useElapsedTime'

interface StreamingStatusBarProps {
  isSending: boolean
  sendStartedAt: number | null
  completedDurationMs?: number | null
}

/**
 * Inline streaming timer shown after the last response message.
 * Returns null when not visible.
 */
export const StreamingStatusBar = memo(function StreamingStatusBar({
  isSending,
  sendStartedAt,
}: StreamingStatusBarProps) {
  const elapsed = useElapsedTime(isSending ? sendStartedAt : null)

  if (!isSending) return null

  return (
    <div className="mt-1 inline-flex min-h-4 items-center text-xs text-muted-foreground/40 tabular-nums font-mono select-none">
      <span className="leading-none">{elapsed ?? '0s'}</span>
    </div>
  )
})
