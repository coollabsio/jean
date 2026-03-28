import { memo } from 'react'
import type { ExecutionMode, RunStatus } from '@/types/chat'
import { useElapsedTime } from './hooks/useElapsedTime'

interface StreamingStatusBarProps {
  isSending: boolean
  sendStartedAt: number | null
  streamingExecutionMode: ExecutionMode
  restoredRunStatus?: RunStatus
  restoredExecutionMode?: string
}

function getModeLabel(mode: string | undefined): string {
  if (mode === 'plan') return 'Planning'
  if (mode === 'yolo') return 'Yoloing'
  return 'Vibing'
}

/**
 * Inline streaming timer shown after the last response message.
 * Returns null when not visible.
 */
export const StreamingStatusBar = memo(function StreamingStatusBar({
  isSending,
  sendStartedAt,
  restoredRunStatus,
  restoredExecutionMode,
}: StreamingStatusBarProps) {
  const elapsed = useElapsedTime(isSending ? sendStartedAt : null)

  const showRestored = !isSending && restoredRunStatus === 'running'
  const visible = isSending || showRestored

  if (!visible) return null

  return (
    <span className="mt-1 block min-h-4 text-xs leading-4 text-muted-foreground/40 tabular-nums font-mono select-none">
      {showRestored ? (
        <span className="animate-dots">
          {getModeLabel(restoredExecutionMode)}
        </span>
      ) : (
        (elapsed ?? '0s')
      )}
    </span>
  )
})
