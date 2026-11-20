const COMPLETE_PATTERNS = [
  'up to date',
  'up-to-date',
  'latest version',
  'no updates available',
  'nothing to install',
] as const

/**
 * Self-updaters print a terminal success line and exit on Windows, but the
 * ConPTY stopped event is not always delivered. Use the output as a secondary
 * completion signal so the update modal does not spin forever.
 */
export function isCliUpdateCompleteOutput(output: string): boolean {
  const normalized = output.toLowerCase()
  if (normalized.includes('not up to date')) return false
  return COMPLETE_PATTERNS.some(pattern => normalized.includes(pattern))
}
