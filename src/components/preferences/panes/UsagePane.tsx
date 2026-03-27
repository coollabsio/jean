import React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  useCodexCliAuth,
  useCodexCliStatus,
  useCodexUsage,
} from '@/services/codex-cli'
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

export const UsagePane: React.FC = () => {
  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({ enabled: !!codexStatus.data?.installed })
  const codexUsage = useCodexUsage({
    enabled: !!codexStatus.data?.installed && !!codexAuth.data?.authenticated,
  })

  const codexErrorMessage = getQueryErrorMessage(
    codexUsage.error,
    'Failed to load Codex usage.'
  )
  const isRefreshing = codexUsage.isFetching || codexAuth.isFetching

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
    </div>
  )
}
