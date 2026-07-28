/** Backends that expose subscription / rate-limit usage snapshots. */
export type UsageCapableBackend = 'claude' | 'codex' | 'grok'

export interface UsageWindowPercent {
  usedPercent: number | null
  resetsAt?: number | null
}

export interface UsageEntry {
  id: UsageCapableBackend
  label: string
  plan: string | null
  session: number | null
  weekly: number | null
  available: boolean
}

export function isUsageCapableBackend(
  backend: string | null | undefined
): backend is UsageCapableBackend {
  return backend === 'claude' || backend === 'codex' || backend === 'grok'
}

/** Compact `session|weekly%` badge text (`--` when missing). */
export function formatUsagePair(
  session: number | null | undefined,
  weekly: number | null | undefined
): string {
  const sessionText = session == null ? '--' : `${Math.round(session)}`
  const weeklyText = weekly == null ? '--' : `${Math.round(weekly)}`
  return `${sessionText}|${weeklyText}%`
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** Highest of session/weekly used to drive badge color. */
export function getUsageSeverityPercent(
  session: number | null | undefined,
  weekly: number | null | undefined
): number | null {
  const values = [session, weekly].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  )
  if (values.length === 0) return null
  return Math.max(...values.map(clampPercent))
}

/** Text color for usage badge — mirrors UsagePane thresholds. */
export function usageSeverityTextClass(
  session: number | null | undefined,
  weekly: number | null | undefined
): string {
  const p = getUsageSeverityPercent(session, weekly)
  if (p == null) return 'text-muted-foreground'
  if (p >= 90) return 'text-destructive'
  if (p >= 70) return 'text-amber-500'
  return 'text-muted-foreground'
}

/**
 * Prefer the session's selected backend when it has usage;
 * otherwise fall back to the first available entry (canvas dock case).
 */
export function resolveActiveUsageEntry(
  entries: UsageEntry[],
  selectedBackend: string | null | undefined
): UsageEntry | null {
  if (entries.length === 0) return null
  if (isUsageCapableBackend(selectedBackend)) {
    const match = entries.find(e => e.id === selectedBackend)
    if (match) return match
  }
  return entries[0] ?? null
}
