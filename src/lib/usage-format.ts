/**
 * Compact "session|weekly%" usage label. Backends with only a weekly window
 * (e.g. Codex) show just the weekly value.
 */
export function formatUsagePair(
  session: number | null | undefined,
  weekly: number | null | undefined
): string {
  const weeklyText = weekly == null ? '--' : `${Math.round(weekly)}`
  if (session == null && weekly != null) return `${weeklyText}%`
  const sessionText = session == null ? '--' : `${Math.round(session)}`
  return `${sessionText}|${weeklyText}%`
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Backends report reset times in seconds; accept milliseconds too. */
export function toEpochMs(at: number): number {
  return at < 1_000_000_000_000 ? at * 1000 : at
}

/**
 * Two-unit duration, rounded down so a countdown never overstates the time
 * left: `3d 11h`, `4h 12m`, `12m`, `<1m`.
 */
export function formatCompactDuration(ms: number): string {
  if (ms < MINUTE_MS) return '<1m'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** Time left until a usage window resets, or `now` once it has passed. */
export function formatResetCountdown(
  resetsAt: number,
  nowMs = Date.now()
): string {
  const diffMs = toEpochMs(resetsAt) - nowMs
  return diffMs > 0 ? formatCompactDuration(diffMs) : 'now'
}

/** Local reset time: `2:00 PM` within a day, `Fri 2:00 PM` otherwise. */
export function formatResetAt(resetsAt: number, nowMs = Date.now()): string {
  const targetMs = toEpochMs(resetsAt)
  const date = new Date(targetMs)
  const time: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
  }
  if (targetMs - nowMs < DAY_MS) return date.toLocaleTimeString(undefined, time)
  return date.toLocaleString(undefined, { weekday: 'short', ...time })
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Human plan name from raw backend values, e.g. Claude `max` +
 * `default_claude_max_20x` → `Max 20x`, Codex `plus` → `Plus`.
 */
export function formatPlanName(
  plan: string | null | undefined,
  tier?: string | null
): string | null {
  const raw = plan?.trim()
  if (!raw) return null
  // Already human-formatted (e.g. Grok `X Premium+`).
  if (/[A-Z]/.test(raw)) return raw
  const name = titleCase(raw)
  const multiplier = tier?.match(/_(\d+)x$/i)?.[1]
  return multiplier ? `${name} ${multiplier}x` : name
}
