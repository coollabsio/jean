import type { CheckStatus } from '@/types/pr-status'

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Some timestamps are stored in seconds; normalize to milliseconds. */
export function toMilliseconds(timestamp: number): number {
  return timestamp > 0 && timestamp < 1_000_000_000_000
    ? timestamp * 1000
    : timestamp
}

/** A row is stale when its newest known activity is older than 7 days. */
export function isStaleActivity(
  timestamps: (number | undefined)[],
  now = Date.now()
): boolean {
  const latest = Math.max(
    0,
    ...timestamps.map(t => (t ? toMilliseconds(t) : 0))
  )
  return latest > 0 && now - latest > STALE_AFTER_MS
}

export function getCheckStatusDisplay(status: CheckStatus): {
  label: string
  className: string
} {
  switch (status) {
    case 'success':
      return { label: 'Checks passed', className: 'bg-success' }
    case 'pending':
      return { label: 'Checks running', className: 'bg-warning' }
    case 'failure':
    case 'error':
      return { label: 'Checks failing', className: 'bg-destructive' }
  }
}
