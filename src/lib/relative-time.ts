const MINUTE = 60
const HOUR = 3600
const DAY = 86_400
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** Compact relative time for unix seconds: "now", "5m ago", "in 2h", "3mo ago". */
export function formatRelative(unixSeconds: number, now = Date.now()): string {
  const diff = Math.round(unixSeconds - now / 1000)
  const abs = Math.abs(diff)
  if (abs < 5) return 'now'
  const value =
    abs < MINUTE
      ? `${abs}s`
      : abs < HOUR
        ? `${Math.round(abs / MINUTE)}m`
        : abs < DAY
          ? `${Math.round(abs / HOUR)}h`
          : abs < MONTH
            ? `${Math.round(abs / DAY)}d`
            : abs < YEAR
              ? `${Math.floor(abs / MONTH)}mo`
              : `${Math.floor(abs / YEAR)}y`
  return diff > 0 ? `in ${value}` : `${value} ago`
}
