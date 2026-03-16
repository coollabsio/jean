/**
 * Format milliseconds as seconds string.
 * Examples: "0s", "23s", "145s"
 */
export function formatDuration(ms: number): string {
  return `${Math.floor(ms / 1000)}s`
}
