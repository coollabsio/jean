/**
 * Format milliseconds as seconds string.
 * Examples: "0s", "23s", "145s"
 */
export function formatDuration(ms: number): string {
  return `${Math.floor(ms / 1000)}s`
}

/**
 * Format a Unix ms timestamp as a local hour:minute string using the user's locale.
 */
export function formatLocalTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
