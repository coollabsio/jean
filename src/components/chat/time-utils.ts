import type { ChatMessage } from '@/types/chat'

/**
 * Format milliseconds as seconds when under a minute, otherwise mm:ss.
 * Examples: "0s", "23s", "02:25"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes === 0) return `${seconds}s`

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Returns the assistant runtime to display for a message.
 *
 * Prefer the in-memory completed duration for the just-finished final assistant
 * response. After reload, fall back to the persisted user→assistant timestamp
 * delta when it looks like a single prompt run.
 */
export function getAssistantDurationMs(
  messages: ChatMessage[],
  index: number,
  completedDurationMs?: number | null
): number | null {
  const message = messages[index]
  if (message?.role !== 'assistant') return null

  if (index === messages.length - 1 && completedDurationMs != null) {
    return completedDurationMs
  }

  if (index <= 0) return null

  const prevMessage = messages[index - 1]
  if (prevMessage?.role !== 'user') return null

  const deltaSecs = message.timestamp - prevMessage.timestamp
  if (deltaSecs <= 0 || deltaSecs >= 3600) return null

  return deltaSecs * 1000
}

/**
 * Format a chat-message timestamp as a local hour:minute string.
 *
 * Message timestamps are Unix seconds (`now()` uses `as_secs()`), same as
 * other callers that pass `timestamp * 1000` into `Date`.
 */
export function formatLocalTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}
