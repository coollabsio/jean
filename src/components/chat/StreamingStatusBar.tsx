import { memo } from 'react'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import { useElapsedTime } from './hooks/useElapsedTime'

interface StreamingStatusBarProps {
  isSending: boolean
  sendStartedAt: number | null
  completedDurationMs?: number | null
  /** Quiet chats: "<agent> is working" next to the timer */
  workingLabel?: string
  /** Quiet chats: what the agent does now; replaces workingLabel when set */
  activityHint?: string
}

/**
 * Inline streaming timer shown after the last response message.
 * Returns null when not visible.
 */
export const StreamingStatusBar = memo(function StreamingStatusBar({
  isSending,
  sendStartedAt,
  workingLabel,
  activityHint,
}: StreamingStatusBarProps) {
  const elapsed = useElapsedTime(isSending ? sendStartedAt : null)

  if (!isSending) return null

  if (workingLabel) {
    return (
      <div
        className="mt-1 inline-flex min-h-5 max-w-full items-center gap-2 text-sm text-muted-foreground select-none"
        role="status"
      >
        <WorkingWaveform />
        <span className="min-w-0 truncate">{activityHint || workingLabel}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground/60">
          {elapsed ?? '0s'}
        </span>
      </div>
    )
  }

  return (
    <div className="mt-1 inline-flex min-h-4 items-center text-xs text-muted-foreground/40 tabular-nums font-mono select-none">
      <span className="leading-none">{elapsed ?? '0s'}</span>
    </div>
  )
})
