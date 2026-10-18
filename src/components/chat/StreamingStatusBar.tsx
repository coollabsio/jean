import { memo } from 'react'
import type { RunStatus } from '@/types/chat'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import { useElapsedTime } from './hooks/useElapsedTime'

interface StreamingStatusBarProps {
  isSending: boolean
  sendStartedAt: number | null
  restoredRunStatus?: RunStatus
  restoredExecutionMode?: string
  completedDurationMs?: number | null
  /** Quiet chats: "<agent> is working" next to the timer */
  workingLabel?: string
}

export function shouldShowRestoredRun({
  isSending,
  restoredRunStatus,
  completedDurationMs,
}: Pick<
  StreamingStatusBarProps,
  'isSending' | 'restoredRunStatus' | 'completedDurationMs'
>): boolean {
  return (
    !isSending && completedDurationMs == null && restoredRunStatus === 'running'
  )
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
  completedDurationMs,
  workingLabel,
}: StreamingStatusBarProps) {
  const elapsed = useElapsedTime(isSending ? sendStartedAt : null)

  const showRestored = shouldShowRestoredRun({
    isSending,
    restoredRunStatus,
    completedDurationMs,
  })
  const visible = isSending || showRestored

  if (!visible) return null

  if (workingLabel) {
    return (
      <div
        className="mt-1 inline-flex min-h-5 items-center gap-2 text-sm text-muted-foreground select-none"
        role="status"
      >
        <WorkingWaveform />
        <span>{workingLabel}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground/60">
          {showRestored ? '…' : (elapsed ?? '0s')}
        </span>
      </div>
    )
  }

  return (
    <div className="mt-1 inline-flex min-h-4 items-center text-xs text-muted-foreground/40 tabular-nums font-mono select-none">
      {showRestored ? (
        <span className="leading-none animate-dots">
          {getModeLabel(restoredExecutionMode)}
        </span>
      ) : (
        <span className="leading-none">{elapsed ?? '0s'}</span>
      )}
    </div>
  )
})
