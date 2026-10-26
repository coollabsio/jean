import { useState, type ReactNode } from 'react'
import { formatDuration, formatLocalTime } from './time-utils'

/**
 * Assistant run duration, followed by the local hour:minute it was received.
 *
 * Fine pointers reveal the time when the surrounding `group/message` is
 * hovered. Coarse pointers have no hover, so a tap on the duration toggles
 * the time. The time stays in flow so revealing it does not shift layout.
 * `children` render right after the duration, before the reserved time slot.
 */
export function MessageTiming({
  durationMs,
  timestamp,
  children,
}: {
  durationMs: number
  timestamp: number
  children?: ReactNode
}) {
  const [showTime, setShowTime] = useState(false)
  const hasTime = timestamp > 0

  return (
    <span
      className={hasTime ? 'cursor-pointer' : undefined}
      onClick={hasTime ? () => setShowTime(v => !v) : undefined}
    >
      <span>{formatDuration(durationMs)}</span>
      {children}
      {hasTime && (
        <span
          className={
            showTime
              ? undefined
              : 'opacity-0 transition-opacity [@media(pointer:fine)]:group-hover/message:opacity-100'
          }
        >
          {' · '}
          {formatLocalTime(timestamp)}
        </span>
      )}
    </span>
  )
}
