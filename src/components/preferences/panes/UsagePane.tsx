import React, { useCallback } from 'react'
import { Loader2, RefreshCw } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
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
import { useNow } from '@/hooks/useNow'
import {
  formatCompactDuration,
  formatPlanName,
  formatResetAt,
  formatResetCountdown,
  toEpochMs,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'

/** One card per backend: icon, name, plan badge, then usage windows. */
function UsageCard({
  title,
  Icon,
  plan,
  anchorId,
  children,
}: {
  title: string
  Icon: React.ComponentType<{ className?: string }>
  plan?: string | null
  anchorId: string
  children: React.ReactNode
}) {
  return (
    <section id={anchorId} className="space-y-3">
      <div className="flex items-center justify-between gap-2 px-1 sm:px-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-4 shrink-0" />
          {title}
        </h3>
        {plan ? (
          <span className="truncate rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {plan} plan
          </span>
        ) : null}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4 sm:p-5">
        {children}
      </div>
    </section>
  )
}

interface UsageWindow {
  usedPercent: number
  resetsAt: number | null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function barClass(usedPercent: number): string {
  const p = clampPercent(usedPercent)
  if (p >= 90) return 'bg-destructive'
  if (p >= 70) return 'bg-warning'
  return 'bg-primary'
}

function percentClass(usedPercent: number): string {
  const p = clampPercent(usedPercent)
  if (p >= 90) return 'text-destructive'
  if (p >= 70) return 'text-warning'
  return 'text-foreground'
}

/** `5-hour session` from the window length, `Session` when unknown. */
function sessionLabel(limitWindowSeconds?: number | null): string {
  if (!limitWindowSeconds) return 'Session'
  return `${Math.round(limitWindowSeconds / 3600)}-hour session`
}

function getQueryErrorMessage(error: unknown, fallback: string) {
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
  return fallback
}

/** Usage window: label + % used, bar, then reset countdown. */
const UsageRow: React.FC<{
  label: string
  usage: UsageWindow | null
  nowMs: number
}> = ({ label, usage, nowMs }) => {
  if (!usage) return null

  const usedPercent = clampPercent(usage.usedPercent)
  const resetsAt = usage.resetsAt

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-foreground">{label}</span>
        <span
          className={cn(
            'shrink-0 text-xs font-medium tabular-nums',
            percentClass(usedPercent)
          )}
        >
          {Math.round(usedPercent)}%
          <span className="ml-1 font-normal text-muted-foreground">used</span>
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={Math.round(usedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} ${usedPercent.toFixed(1)}% used`}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            barClass(usedPercent)
          )}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      {resetsAt ? (
        <p
          className="text-[11px] tabular-nums text-muted-foreground"
          title={`Resets ${new Date(toEpochMs(resetsAt)).toLocaleString()}`}
        >
          Resets in {formatResetCountdown(resetsAt, nowMs)}
          <span className="mx-1.5 text-border" aria-hidden>
            ·
          </span>
          {formatResetAt(resetsAt, nowMs)}
        </p>
      ) : null}
    </div>
  )
}

function InlineStatus({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode
  tone?: 'muted' | 'error'
}) {
  return (
    <p
      className={cn(
        'text-xs leading-snug',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  )
}

function MetaLine({ items }: { items: (string | null | undefined)[] }) {
  const parts = items.filter((p): p is string => !!p && p.length > 0)
  if (parts.length === 0) return null
  return (
    <p className="truncate text-xs text-muted-foreground">
      {parts.map((part, i) => (
        <React.Fragment key={part}>
          {i > 0 ? (
            <span className="mx-1.5 text-border" aria-hidden>
              ·
            </span>
          ) : null}
          <span>{part}</span>
        </React.Fragment>
      ))}
    </p>
  )
}

function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      {label}
    </div>
  )
}

function ErrorLine({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <InlineStatus tone="error">{message}</InlineStatus>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={onRetry}
      >
        <RefreshCw className="size-3" />
        Retry
      </Button>
    </div>
  )
}

export const UsagePane: React.FC = () => {
  const claudeStatus = useClaudeCliStatus()
  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeStatus.data?.installed,
  })
  const claudeUsage = useClaudeUsage({
    enabled: !!claudeStatus.data?.installed && !!claudeAuth.data?.authenticated,
  })

  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({ enabled: !!codexStatus.data?.installed })
  const codexUsage = useCodexUsage({
    enabled: !!codexStatus.data?.installed && !!codexAuth.data?.authenticated,
  })

  const grokStatus = useGrokCliStatus()
  const grokAuth = useGrokCliAuth({ enabled: !!grokStatus.data?.installed })
  const grokUsage = useGrokUsage({
    enabled: !!grokStatus.data?.installed && !!grokAuth.data?.authenticated,
  })

  const claudeErrorMessage = getQueryErrorMessage(
    claudeUsage.error,
    'Failed to load Claude usage.'
  )
  const codexErrorMessage = getQueryErrorMessage(
    codexUsage.error,
    'Failed to load Codex usage.'
  )
  const grokErrorMessage = getQueryErrorMessage(
    grokUsage.error,
    'Failed to load Grok usage.'
  )
  const isRefreshing =
    claudeUsage.isFetching ||
    claudeAuth.isFetching ||
    codexUsage.isFetching ||
    codexAuth.isFetching ||
    grokUsage.isFetching ||
    grokAuth.isFetching

  const handleRefresh = useCallback(() => {
    void Promise.all([
      claudeStatus.refetch(),
      claudeAuth.refetch(),
      claudeUsage.refetch(),
      codexStatus.refetch(),
      codexAuth.refetch(),
      codexUsage.refetch(),
      grokStatus.refetch(),
      grokAuth.refetch(),
      grokUsage.refetch(),
    ])
  }, [
    claudeAuth,
    claudeStatus,
    claudeUsage,
    codexAuth,
    codexStatus,
    codexUsage,
    grokAuth,
    grokStatus,
    grokUsage,
  ])

  const latestFetchedAt = Math.max(
    claudeUsage.data?.fetchedAt ?? 0,
    codexUsage.data?.fetchedAt ?? 0,
    grokUsage.data?.fetchedAt ?? 0
  )

  // Only surface backends that are installed and logged in.
  const claudeReady =
    !!claudeStatus.data?.installed && !!claudeAuth.data?.authenticated
  const codexReady =
    !!codexStatus.data?.installed && !!codexAuth.data?.authenticated
  const grokReady =
    !!grokStatus.data?.installed && !!grokAuth.data?.authenticated

  const claudePendingAuth =
    !!claudeStatus.data?.installed && claudeAuth.isLoading
  const codexPendingAuth = !!codexStatus.data?.installed && codexAuth.isLoading
  const grokPendingAuth = !!grokStatus.data?.installed && grokAuth.isLoading

  const showClaude = claudeReady || claudePendingAuth
  const showCodex = codexReady || codexPendingAuth
  const showGrok = grokReady || grokPendingAuth
  const hasAnyBackend = showClaude || showCodex || showGrok

  const statusLoading =
    claudeStatus.isLoading || codexStatus.isLoading || grokStatus.isLoading

  const nowMs = useNow(hasAnyBackend)
  const claudePlan = formatPlanName(
    claudeUsage.data?.planType,
    claudeUsage.data?.planTier
  )
  const codexPlan = formatPlanName(codexUsage.data?.planType)
  const grokPlan = formatPlanName(grokUsage.data?.planType)

  const renderClaude = () => {
    if (claudePendingAuth) {
      return <LoadingLine label="Checking authentication…" />
    }
    if (claudeUsage.isLoading) {
      return <LoadingLine label="Loading usage…" />
    }
    // Keep showing last-good data when only a background refetch failed.
    if (claudeUsage.isError && !claudeUsage.data) {
      return (
        <ErrorLine
          message={claudeErrorMessage}
          onRetry={() => claudeUsage.refetch()}
        />
      )
    }
    if (!claudeUsage.data) {
      return <InlineStatus>No usage data available.</InlineStatus>
    }

    const data = claudeUsage.data
    const extra =
      data.extraUsageSpent != null || data.extraUsageLimit != null
        ? `Extra usage: ${data.extraUsageSpent ?? 0}${
            data.extraUsageLimit != null ? ` / ${data.extraUsageLimit}` : ''
          }`
        : null

    return (
      <div className="space-y-2">
        <MetaLine items={[extra]} />
        <div className="space-y-3">
          <UsageRow label="5-hour session" usage={data.session} nowMs={nowMs} />
          <UsageRow label="Weekly" usage={data.weekly} nowMs={nowMs} />
          <UsageRow
            label="Weekly · Sonnet"
            usage={data.sonnetWeekly}
            nowMs={nowMs}
          />
        </div>
      </div>
    )
  }

  const renderCodex = () => {
    if (codexPendingAuth) {
      return <LoadingLine label="Checking authentication…" />
    }
    if (codexUsage.isLoading) {
      return <LoadingLine label="Loading usage…" />
    }
    // Keep showing last-good data when only a background refetch failed.
    if (codexUsage.isError && !codexUsage.data) {
      return (
        <ErrorLine
          message={codexErrorMessage}
          onRetry={() => codexUsage.refetch()}
        />
      )
    }
    if (!codexUsage.data) {
      return <InlineStatus>No usage data available.</InlineStatus>
    }

    const data = codexUsage.data
    const credits =
      data.creditsRemaining !== null
        ? `Credits remaining: ${data.creditsRemaining}`
        : null

    const extraLimits = data.modelLimits.flatMap(limit => {
      const rows: { key: string; label: string; usage: UsageWindow }[] = []
      if (limit.session) {
        rows.push({
          key: `${limit.label}-session`,
          label: limit.label,
          usage: limit.session,
        })
      }
      if (limit.weekly) {
        rows.push({
          key: `${limit.label}-weekly`,
          label: `${limit.label} · Weekly`,
          usage: limit.weekly,
        })
      }
      return rows
    })

    return (
      <div className="space-y-2">
        <MetaLine items={[credits]} />
        {data.rateLimitReachedType ? (
          <InlineStatus tone="error">
            Rate limit reached ({data.rateLimitReachedType.replace(/_/g, ' ')})
          </InlineStatus>
        ) : null}
        <div className="space-y-3">
          <UsageRow
            label={sessionLabel(data.session?.limitWindowSeconds)}
            usage={data.session}
            nowMs={nowMs}
          />
          <UsageRow label="Weekly" usage={data.weekly} nowMs={nowMs} />
          <UsageRow label="Code reviews" usage={data.reviews} nowMs={nowMs} />
          {extraLimits.map(row => (
            <UsageRow
              key={row.key}
              label={row.label}
              usage={row.usage}
              nowMs={nowMs}
            />
          ))}
        </div>
      </div>
    )
  }

  const renderGrok = () => {
    if (grokPendingAuth) {
      return <LoadingLine label="Checking authentication…" />
    }
    if (grokUsage.isLoading) {
      return <LoadingLine label="Loading usage…" />
    }
    // Keep showing last-good data when only a background refetch failed.
    if (grokUsage.isError && !grokUsage.data) {
      return (
        <ErrorLine
          message={grokErrorMessage}
          onRetry={() => grokUsage.refetch()}
        />
      )
    }
    if (!grokUsage.data) {
      return <InlineStatus>No usage data available.</InlineStatus>
    }

    const data = grokUsage.data
    const codeAccess =
      data.hasGrokCodeAccess == null
        ? null
        : data.hasGrokCodeAccess
          ? 'Grok Code access: Yes'
          : 'Grok Code access: No'
    const period =
      data.periodStart || data.periodEnd
        ? `${data.periodStart ? new Date(data.periodStart).toLocaleDateString() : '—'} → ${
            data.periodEnd ? new Date(data.periodEnd).toLocaleDateString() : '—'
          }`
        : null

    // Avoid duplicating primary session as a product row when names match.
    const sessionPct = data.session?.usedPercent
    const products = data.products.filter(product => {
      const isBuild =
        /build/i.test(product.product) || product.product === 'GrokBuild'
      if (isBuild && sessionPct != null) {
        return Math.abs(product.usedPercent - sessionPct) > 0.5
      }
      return true
    })

    const tasks: string[] = []
    if (data.frequentLimit != null) {
      tasks.push(`Frequent: ${data.frequentUsed ?? 0} / ${data.frequentLimit}`)
    }
    if (data.occasionalLimit != null) {
      tasks.push(
        `Occasional: ${data.occasionalUsed ?? 0} / ${data.occasionalLimit}`
      )
    }

    return (
      <div className="space-y-2">
        <MetaLine items={[codeAccess, period]} />
        <div className="space-y-3">
          <UsageRow label="Grok Build" usage={data.session} nowMs={nowMs} />
          <UsageRow label="Weekly credits" usage={data.weekly} nowMs={nowMs} />
          {products.map(product => (
            <UsageRow
              key={product.product}
              label={product.product}
              usage={{
                usedPercent: product.usedPercent,
                resetsAt:
                  data.session?.resetsAt ?? data.weekly?.resetsAt ?? null,
              }}
              nowMs={nowMs}
            />
          ))}
        </div>
        {tasks.length > 0 ? <MetaLine items={tasks} /> : null}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {isRefreshing ? (
            'Refreshing…'
          ) : latestFetchedAt > 0 ? (
            <span
              title={new Date(latestFetchedAt * 1000).toLocaleString()}
              className="tabular-nums"
            >
              Updated{' '}
              {formatCompactDuration(
                Math.max(0, nowMs - toEpochMs(latestFetchedAt))
              )}{' '}
              ago
            </span>
          ) : (
            'Up to date'
          )}
          <span className="mx-1.5 text-border">·</span>
          Auto-refresh every 5m
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {statusLoading && !hasAnyBackend ? (
        <LoadingLine label="Checking installed backends…" />
      ) : null}

      {!statusLoading && !hasAnyBackend ? (
        <InlineStatus>
          No AI backends with usage are installed and signed in. Install and log
          in to Claude, Codex, or Grok to see limits here.
        </InlineStatus>
      ) : null}

      {showClaude ? (
        <UsageCard
          title="Claude"
          Icon={ClaudeIcon}
          plan={claudePlan}
          anchorId="pref-usage-section-claude"
        >
          {renderClaude()}
        </UsageCard>
      ) : null}

      {showCodex ? (
        <UsageCard
          title="Codex"
          Icon={CodexIcon}
          plan={codexPlan}
          anchorId="pref-usage-section-codex"
        >
          {renderCodex()}
        </UsageCard>
      ) : null}

      {showGrok ? (
        <UsageCard
          title="Grok"
          Icon={GrokIcon}
          plan={grokPlan}
          anchorId="pref-usage-section-grok"
        >
          {renderGrok()}
        </UsageCard>
      ) : null}
    </div>
  )
}
