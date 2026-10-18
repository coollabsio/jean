import type React from 'react'
import { ClaudeIcon } from '@/components/icons/ClaudeIcon'
import { CodexIcon } from '@/components/icons/CodexIcon'
import { GrokIcon } from '@/components/icons/GrokIcon'
import {
  useClaudeCliAuth,
  useClaudeCliStatus,
  useClaudeUsage,
} from '@/services/claude-cli'
import {
  useCodexCliAuth,
  useCodexCliStatus,
  useCodexUsage,
} from '@/services/codex-cli'
import {
  useGrokCliAuth,
  useGrokCliStatus,
  useGrokUsage,
} from '@/services/grok-cli'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useNow } from '@/hooks/useNow'
import { useUIStore } from '@/store/ui-store'
import {
  formatPlanName,
  formatResetCountdown,
  toEpochMs,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'

export type UsageBackendId = 'claude' | 'codex' | 'grok'

interface UsageWindow {
  usedPercent: number
  resetsAt: number | null
}

export interface UsageEntry {
  id: UsageBackendId
  label: string
  Icon: React.ComponentType<{ className?: string }>
  plan: string | null
  sessionLabel: string
  session: UsageWindow | null
  weekly: UsageWindow | null
}

/**
 * Usage of every installed + authenticated backend, for the quick menus.
 * `fetchEnabled` gates the usage queries (status/auth always run).
 */
export function useUsageEntries(fetchEnabled: boolean): UsageEntry[] {
  const claudeStatus = useClaudeCliStatus()
  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeStatus.data?.installed,
  })
  const claudeAvailable =
    !!claudeStatus.data?.installed && !!claudeAuth.data?.authenticated
  const claudeUsage = useClaudeUsage({
    enabled: claudeAvailable && fetchEnabled,
  })

  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({
    enabled: !!codexStatus.data?.installed,
  })
  const codexAvailable =
    !!codexStatus.data?.installed && !!codexAuth.data?.authenticated
  const codexUsage = useCodexUsage({
    enabled: codexAvailable && fetchEnabled,
  })

  const grokStatus = useGrokCliStatus()
  const grokAuth = useGrokCliAuth({
    enabled: !!grokStatus.data?.installed,
  })
  const grokAvailable =
    !!grokStatus.data?.installed && !!grokAuth.data?.authenticated
  const grokUsage = useGrokUsage({
    enabled: grokAvailable && fetchEnabled,
  })

  const entries: (UsageEntry & { available: boolean })[] = [
    {
      id: 'claude',
      label: 'Claude',
      Icon: ClaudeIcon,
      plan: formatPlanName(
        claudeUsage.data?.planType,
        claudeUsage.data?.planTier
      ),
      sessionLabel: 'Session',
      session: claudeUsage.data?.session ?? null,
      weekly: claudeUsage.data?.weekly ?? null,
      available: claudeAvailable,
    },
    {
      id: 'codex',
      label: 'Codex',
      Icon: CodexIcon,
      plan: formatPlanName(codexUsage.data?.planType),
      sessionLabel: 'Session',
      session: codexUsage.data?.session ?? null,
      weekly: codexUsage.data?.weekly ?? null,
      available: codexAvailable,
    },
    {
      id: 'grok',
      label: 'Grok',
      Icon: GrokIcon,
      plan: formatPlanName(grokUsage.data?.planType),
      sessionLabel: 'Build',
      session: grokUsage.data?.session ?? null,
      weekly: grokUsage.data?.weekly ?? null,
      available: grokAvailable,
    },
  ]
  return entries.filter(entry => entry.available)
}

function resetText(resetsAt: number, nowMs: number): string {
  const countdown = formatResetCountdown(resetsAt, nowMs)
  return countdown === 'now' ? 'resets now' : `resets in ${countdown}`
}

/**
 * Per-window usage lines (`Session 9% · resets in 4h 12m`) for menus and
 * tooltips. Ticks every minute while mounted.
 */
export function UsageEntryWindows({
  entry,
  className,
}: {
  entry: UsageEntry
  className?: string
}) {
  const nowMs = useNow()
  const windows = [
    { label: entry.sessionLabel, usage: entry.session },
    { label: 'Weekly', usage: entry.weekly },
  ].filter(
    (window): window is { label: string; usage: UsageWindow } =>
      window.usage !== null
  )

  if (windows.length === 0) {
    return (
      <span className={cn('text-[11px] text-muted-foreground', className)}>
        No usage data
      </span>
    )
  }

  return (
    <div
      className={cn(
        'grid grid-cols-[auto_auto_1fr] gap-x-2 text-[11px] tabular-nums text-muted-foreground',
        className
      )}
    >
      {windows.map(({ label, usage }) => (
        <div key={label} className="contents">
          <span>{label}</span>
          <span className="text-right font-medium text-foreground">
            {Math.round(usage.usedPercent)}%
          </span>
          <span
            className="text-right"
            title={
              usage.resetsAt
                ? `Resets ${new Date(toEpochMs(usage.resetsAt)).toLocaleString()}`
                : undefined
            }
          >
            {usage.resetsAt ? resetText(usage.resetsAt, nowMs) : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/** `Claude · Max 20x` heading used above the usage lines. */
export function UsageEntryTitle({ entry }: { entry: UsageEntry }) {
  return (
    <span className="truncate">
      {entry.label}
      {entry.plan ? (
        <span className="text-muted-foreground"> · {entry.plan}</span>
      ) : null}
    </span>
  )
}

/** Quick-menu row: icon, `Claude · Max 20x`, then usage lines. Opens Usage. */
export function UsageMenuItem({ entry }: { entry: UsageEntry }) {
  return (
    <DropdownMenuItem
      className="items-start"
      onClick={() => useUIStore.getState().openPreferencesPane('usage')}
    >
      <entry.Icon className="mt-0.5 mr-2 h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <UsageEntryTitle entry={entry} />
        <UsageEntryWindows entry={entry} />
      </div>
    </DropdownMenuItem>
  )
}
