import React from 'react'
import {
  Activity,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal,
  Timer,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import {
  useCodexCliAuth,
  useCodexCliStatus,
  useCodexUsage,
} from '@/services/codex-cli'
import { usePreferences } from '@/services/preferences'
import { useRtkGain } from '@/services/rtk'
import type { RtkPeriodStat } from '@/types/rtk'
interface UsageWindow {
  usedPercent: number
  resetsAt: number | null
}

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

const UsageRow: React.FC<{
  label: string
  usage: UsageWindow | null
}> = ({ label, usage }) => {
  if (!usage) return null

  const usedPercent = Math.max(0, Math.min(100, usage.usedPercent))
  const resetsAtLabel = usage.resetsAt
    ? new Date(usage.resetsAt * 1000).toLocaleString()
    : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">{usedPercent.toFixed(1)}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-secondary">
        <div
          className="h-2 rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      {resetsAtLabel && (
        <p className="text-xs text-muted-foreground">Resets: {resetsAtLabel}</p>
      )}
    </div>
  )
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

function formatTokens(value: number) {
  return new Intl.NumberFormat().format(value)
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`
}

function formatDuration(milliseconds: number) {
  if (milliseconds >= 60_000) {
    const minutes = milliseconds / 60_000
    return `${minutes.toFixed(1)} min`
  }
  if (milliseconds >= 1_000) {
    const seconds = milliseconds / 1_000
    return `${seconds.toFixed(1)} sec`
  }
  return `${milliseconds} ms`
}

const MetricCard: React.FC<{
  title: string
  value: string
  description: string
  icon: React.ReactNode
}> = ({ title, value, description, icon }) => (
  <Card className="gap-4 py-4">
    <CardHeader className="flex flex-row items-start justify-between gap-3 px-4 pb-0">
      <div className="space-y-1">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </div>
      <div className="rounded-lg border border-border/60 bg-muted/40 p-2 text-muted-foreground">
        {icon}
      </div>
    </CardHeader>
    <CardContent className="px-4 pt-0 text-sm text-muted-foreground">
      {description}
    </CardContent>
  </Card>
)

const PeriodTable: React.FC<{
  title: string
  rows: RtkPeriodStat[]
}> = ({ title, rows }) => {
  if (rows.length === 0) return null

  return (
    <div className="space-y-3 rounded-xl border border-border/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">
          {rows.length} period{rows.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="space-y-2">
        {rows.map(row => (
          <div
            key={`${title}-${row.label}`}
            className="grid grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))] gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
          >
            <div>
              <p className="font-medium text-foreground">{row.label}</p>
              <p className="text-xs text-muted-foreground">
                {row.commands} command{row.commands === 1 ? '' : 's'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Saved</p>
              <p className="font-medium text-foreground">
                {formatTokens(row.saved)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Reduction</p>
              <p className="font-medium text-foreground">
                {formatPercent(row.savingsPct)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Time</p>
              <p className="font-medium text-foreground">
                {formatDuration(row.timeMs)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function renderRtkContent(rtkGain: ReturnType<typeof useRtkGain>) {
  const rtkErrorMessage = getQueryErrorMessage(
    rtkGain.error,
    'Failed to load RTK savings.'
  )

  if (rtkGain.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading RTK savings...
      </div>
    )
  }

  if (rtkGain.isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{rtkErrorMessage}</p>
        <Button variant="outline" size="sm" onClick={() => rtkGain.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    )
  }

  if (!rtkGain.data || rtkGain.data.summary.totalCommands === 0) {
    return (
      <Empty className="border border-border/70 bg-muted/10 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Sparkles className="h-5 w-5" />
          </EmptyMedia>
          <EmptyTitle>No RTK savings yet</EmptyTitle>
          <EmptyDescription>
            RTK starts reporting once its Claude hook, Codex instructions, or
            OpenCode plugin rewrites commands and records them.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const { summary, daily, weekly, monthly, fetchedAt } = rtkGain.data

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Tokens Saved"
          value={formatTokens(summary.totalSaved)}
          description={`${formatTokens(summary.totalInput)} input vs ${formatTokens(summary.totalOutput)} output tokens processed.`}
          icon={<Sparkles className="h-4 w-4" />}
        />
        <MetricCard
          title="Average Reduction"
          value={formatPercent(summary.avgSavingsPct)}
          description="Average reduction across all RTK-rewritten commands."
          icon={<Activity className="h-4 w-4" />}
        />
        <MetricCard
          title="Commands Rewritten"
          value={formatTokens(summary.totalCommands)}
          description="Tracked commands included in RTK gain totals."
          icon={<Terminal className="h-4 w-4" />}
        />
        <MetricCard
          title="Execution Time"
          value={formatDuration(summary.totalTimeMs)}
          description={`Average ${formatDuration(summary.avgTimeMs)} per command.`}
          icon={<Timer className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <PeriodTable title="Daily" rows={daily.slice(0, 5)} />
        <PeriodTable title="Weekly" rows={weekly.slice(0, 5)} />
        <PeriodTable title="Monthly" rows={monthly.slice(0, 5)} />
      </div>

      <p className="text-xs text-muted-foreground">
        Last updated: {new Date(fetchedAt * 1000).toLocaleString()}
      </p>
    </div>
  )
}

export const UsagePane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({ enabled: !!codexStatus.data?.installed })
  const codexUsage = useCodexUsage({
    enabled: !!codexStatus.data?.installed && !!codexAuth.data?.authenticated,
  })
  const rtkEnabled = preferences?.rtk_ai_enabled ?? false
  const rtkGain = useRtkGain({ enabled: rtkEnabled })

  const codexErrorMessage = getQueryErrorMessage(
    codexUsage.error,
    'Failed to load Codex usage.'
  )
  const isRefreshing =
    codexUsage.isFetching || codexAuth.isFetching || rtkGain.isFetching

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">
            Usage data auto-refreshes every 5 minutes.
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            {isRefreshing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Refreshing...
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                Up to date
              </>
            )}
          </span>
        </div>
      </div>

      <SettingsSection title="Claude">
        <p className="text-sm text-muted-foreground">
          Claude usage tracking is temporarily disabled due to an authentication
          bug that causes repeated logouts.
        </p>
      </SettingsSection>

      <SettingsSection title="Codex">
        {!codexStatus.data?.installed ? (
          <p className="text-sm text-muted-foreground">
            Codex CLI is not installed.
          </p>
        ) : codexAuth.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking authentication...
          </div>
        ) : !codexAuth.data?.authenticated ? (
          <p className="text-sm text-muted-foreground">
            Codex is not authenticated. Run `codex` in your terminal to log in.
          </p>
        ) : codexUsage.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading usage...
          </div>
        ) : codexUsage.isError ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{codexErrorMessage}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => codexUsage.refetch()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : codexUsage.data ? (
          <div className="space-y-5">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">Plan</p>
              <p className="text-sm font-medium text-foreground">
                {codexUsage.data.planType ?? 'Unknown'}
              </p>
              {codexUsage.data.creditsRemaining !== null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Credits remaining: {codexUsage.data.creditsRemaining}
                </p>
              )}
            </div>

            <UsageRow label="Session" usage={codexUsage.data.session} />
            <UsageRow label="Weekly" usage={codexUsage.data.weekly} />
            <UsageRow label="Reviews" usage={codexUsage.data.reviews} />

            {codexUsage.data.modelLimits.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-foreground">
                  Additional Limits
                </p>
                {codexUsage.data.modelLimits.map(limit => (
                  <div
                    key={limit.label}
                    className="space-y-2 rounded-md border border-border p-3"
                  >
                    <p className="text-sm text-foreground">{limit.label}</p>
                    <UsageRow label="Session" usage={limit.session} />
                    <UsageRow label="Weekly" usage={limit.weekly} />
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Last updated:{' '}
              {new Date(codexUsage.data.fetchedAt * 1000).toLocaleString()}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No usage data available.
          </p>
        )}
      </SettingsSection>

      {rtkEnabled && (
        <SettingsSection title="RTK">
          <p className="text-sm text-muted-foreground">
            RTK is configured through its native Claude hook, Codex
            instructions, and OpenCode plugin. This panel reads `rtk gain` so
            you can see whether those integrations are actually producing
            savings.
          </p>
          {renderRtkContent(rtkGain)}
        </SettingsSection>
      )}
    </div>
  )
}
