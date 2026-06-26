import { Loader2 } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type UsageLimitBackend = 'codex' | 'claude'

export interface UsageLimitWindowSnapshot {
  usedPercent: number
  resetsAt: number | null
  limitWindowSeconds?: number | null
}

export interface UsageLimitSnapshot {
  planType?: string | null
  session?: UsageLimitWindowSnapshot | null
  weekly?: UsageLimitWindowSnapshot | null
  sonnetWeekly?: UsageLimitWindowSnapshot | null
  fetchedAt?: number | null
  rateLimitReachedType?: string | null
}

interface UsageLimitRow {
  key: 'session' | 'weekly' | 'sonnetWeekly'
  label: string
  usedLabel: string
  remainingLabel: string
  resetShortLabel: string
  resetFullLabel: string
  ariaText: string
  isEmpty: boolean
}

interface BackendUsageLimitsProps {
  backend: UsageLimitBackend
  usage?: UsageLimitSnapshot | null
  isFetching?: boolean
  error?: unknown
  className?: string
}

const BACKEND_LABELS: Record<UsageLimitBackend, string> = {
  codex: 'Codex',
  claude: 'Claude',
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function formatPercent(value: number): string {
  const clamped = clampPercent(value)
  if (clamped > 0 && clamped < 1) return '<1%'
  return `${Math.round(clamped)}%`
}

function formatWindowSeconds(
  seconds: number | null | undefined
): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null

  const days = seconds / 86_400
  if (Number.isInteger(days) && days >= 1) return `${days}d`

  const hours = seconds / 3_600
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h`

  return null
}

function formatResetShort(timestamp: number | null): string {
  if (!timestamp) return '↻ ?'

  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return '↻ ?'

  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', hour: '2-digit', minute: '2-digit' }

  return `↻ ${date.toLocaleString(undefined, options)}`
}

function formatResetFull(timestamp: number | null): string {
  if (!timestamp) return 'unknown'

  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return 'unknown'

  return date.toLocaleString()
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'Failed to load usage limits.'
}

function makeLimitRow(
  key: UsageLimitRow['key'],
  usage: UsageLimitWindowSnapshot | null | undefined
): UsageLimitRow | null {
  if (!usage) return null

  const label =
    key === 'session'
      ? (formatWindowSeconds(usage.limitWindowSeconds) ?? '5h')
      : key === 'sonnetWeekly'
        ? 'Sonnet 7d'
        : '7d'
  const usedPercent = clampPercent(usage.usedPercent)
  const remainingPercent = clampPercent(100 - usedPercent)
  const usedLabel = formatPercent(usedPercent)
  const remainingLabel = formatPercent(remainingPercent)
  const resetFullLabel = formatResetFull(usage.resetsAt)
  const resetShortLabel = formatResetShort(usage.resetsAt)

  return {
    key,
    label,
    usedLabel,
    remainingLabel,
    resetShortLabel,
    resetFullLabel,
    ariaText: `${label} ${remainingLabel} remaining, resets ${resetFullLabel}`,
    isEmpty: remainingPercent <= 0,
  }
}

export function BackendUsageLimits({
  backend,
  usage,
  isFetching,
  error,
  className,
}: BackendUsageLimitsProps) {
  const primaryRows = [
    makeLimitRow('session', usage?.session),
    makeLimitRow('weekly', usage?.weekly),
  ].filter((row): row is UsageLimitRow => Boolean(row))
  const tooltipRows = [
    ...primaryRows,
    makeLimitRow('sonnetWeekly', usage?.sonnetWeekly),
  ].filter((row): row is UsageLimitRow => Boolean(row))
  const backendLabel = BACKEND_LABELS[backend]
  const isLimited =
    Boolean(usage?.rateLimitReachedType) || primaryRows.some(row => row.isEmpty)

  if (!error && !isFetching && primaryRows.length === 0) return null

  const ariaLabel = error
    ? `${backendLabel} limits failed: ${getErrorMessage(error)}`
    : primaryRows.length > 0
      ? `${backendLabel} limits: ${primaryRows.map(row => row.ariaText).join('; ')}`
      : `${backendLabel} limits loading`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="status"
          aria-label={ariaLabel}
          className={cn(
            'h-8 items-center gap-1.5 px-2 text-[10px] font-medium text-muted-foreground transition-colors',
            'border-l border-border/50 bg-muted/20 hover:bg-muted/60',
            isLimited && 'text-amber-600 dark:text-amber-400',
            Boolean(error) && 'text-destructive',
            className
          )}
        >
          {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          {error ? (
            <span>limits failed</span>
          ) : primaryRows.length > 0 ? (
            primaryRows.map((row, index) => (
              <span key={row.key} className="inline-flex items-center gap-1">
                {index > 0 && (
                  <span className="text-muted-foreground/50">|</span>
                )}
                <span>{row.label}</span>
                <span className="text-foreground">{row.remainingLabel}</span>
                <span>{row.resetShortLabel}</span>
              </span>
            ))
          ) : (
            <span>limits…</span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-80 text-xs">
        <div className="space-y-2">
          <div className="font-medium text-foreground">
            {backendLabel} usage limits
          </div>
          {error ? (
            <p className="text-destructive">{getErrorMessage(error)}</p>
          ) : tooltipRows.length > 0 ? (
            <div className="space-y-1.5">
              {tooltipRows.map(row => (
                <div
                  key={row.key}
                  className="grid grid-cols-[auto_1fr] gap-x-2"
                >
                  <span className="font-medium text-foreground">
                    {row.label}
                  </span>
                  <span className="text-muted-foreground">
                    {row.remainingLabel} left · {row.usedLabel} used · resets{' '}
                    {row.resetFullLabel}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">Loading usage limits…</p>
          )}
          {usage?.fetchedAt && (
            <p className="text-[10px] text-muted-foreground/80">
              Last updated: {new Date(usage.fetchedAt * 1000).toLocaleString()}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
