export const SNOOZE_AFTER_SECONDS = 24 * 60 * 60

/** Short age label for list rows: now, 5m, 3h, 2d, 1mo. */
export function formatRecentActivity(
  timestamp: number,
  now = Date.now()
): string {
  const seconds = Math.max(0, Math.floor((now - timestamp * 1000) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}

export function isSnoozedSession(
  lastActivityAt: number,
  now = Date.now()
): boolean {
  return lastActivityAt <= Math.floor(now / 1000) - SNOOZE_AFTER_SECONDS
}
