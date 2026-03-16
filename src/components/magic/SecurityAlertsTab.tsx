import { Search, Loader2, RefreshCw, AlertCircle } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isGhAuthError } from '@/services/github'
import { GhAuthError } from '@/components/shared/GhAuthError'
import { LoadedSecurityItem, SecurityAlertItem, LoadedAdvisoryItem, AdvisoryItem } from './LoadContextItems'
import type {
  DependabotAlert,
  RepositoryAdvisory,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
} from '@/types/github'

const ALERT_STATE_LABELS: Record<string, string> = {
  open: 'Open',
  dismissed: 'Dismissed',
  fixed: 'Fixed',
  auto_dismissed: 'Auto-Dismissed',
}

const ADVISORY_STATE_LABELS: Record<string, string> = {
  published: 'Published',
  triage: 'Triage',
  draft: 'Draft',
  closed: 'Closed',
}

const STATE_DOT_COLORS: Record<string, string> = {
  open: 'bg-orange-500',
  published: 'bg-orange-500',
  fixed: 'bg-green-500',
  closed: 'bg-muted-foreground',
  dismissed: 'bg-muted-foreground',
  auto_dismissed: 'bg-muted-foreground',
  triage: 'bg-yellow-500',
  draft: 'bg-blue-500',
}

interface SecurityAlertsTabProps {
  loadedContexts: LoadedSecurityAlertContext[]
  filteredAlerts: DependabotAlert[]
  searchQuery: string
  setSearchQuery: (q: string) => void
  includeClosed: boolean
  setIncludeClosed: (v: boolean) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  isLoadingContexts: boolean
  isLoading: boolean
  isRefetching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  loadingNumbers: Set<number>
  removingNumbers: Set<number>
  hasLoadedContexts: boolean
  onSelectAlert: (alert: DependabotAlert) => void
  onViewAlert: (ctx: LoadedSecurityAlertContext) => void
  onPreviewAlert: (alert: DependabotAlert) => void
  onRemoveAlert: (num: number) => void
  onLoadAlert: (num: number, refresh: boolean) => void
  onGhLogin: () => void
  isGhInstalled: boolean
  // Advisory props (optional for backward compatibility)
  loadedAdvisoryContexts?: LoadedAdvisoryContext[]
  filteredAdvisories?: RepositoryAdvisory[]
  isLoadingAdvisories?: boolean
  isRefetchingAdvisories?: boolean
  hasLoadedAdvisoryContexts?: boolean
  isLoadingAdvisoryContexts?: boolean
  loadingAdvisoryGhsaIds?: Set<string>
  removingAdvisoryGhsaIds?: Set<string>
  onSelectAdvisory?: (advisory: RepositoryAdvisory) => void
  onViewAdvisory?: (ctx: LoadedAdvisoryContext) => void
  onPreviewAdvisory?: (advisory: RepositoryAdvisory) => void
  onRemoveAdvisory?: (ghsaId: string) => void
  onLoadAdvisory?: (ghsaId: string, refresh: boolean) => void
}

export function SecurityAlertsTab({
  loadedContexts,
  filteredAlerts,
  searchQuery,
  setSearchQuery,
  includeClosed,
  setIncludeClosed,
  searchInputRef,
  isLoadingContexts,
  isLoading,
  isRefetching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  loadingNumbers,
  removingNumbers,
  hasLoadedContexts,
  onSelectAlert,
  onViewAlert,
  onPreviewAlert,
  onRemoveAlert,
  onLoadAlert,
  onGhLogin,
  isGhInstalled,
  // Advisory props
  loadedAdvisoryContexts,
  filteredAdvisories,
  isLoadingAdvisories,
  isRefetchingAdvisories,
  hasLoadedAdvisoryContexts,
  isLoadingAdvisoryContexts,
  loadingAdvisoryGhsaIds,
  removingAdvisoryGhsaIds,
  onSelectAdvisory,
  onViewAdvisory,
  onPreviewAdvisory,
  onRemoveAdvisory,
  onLoadAdvisory,
}: SecurityAlertsTabProps) {
  const advisories = filteredAdvisories ?? []
  const advisoryGhsaLoading = loadingAdvisoryGhsaIds ?? new Set<string>()
  const advisoryGhsaRemoving = removingAdvisoryGhsaIds ?? new Set<string>()

  // Alerts use indices 0..N-1, advisories use N..N+M-1
  const alertsCount = filteredAlerts.length
  const isAnyLoading = isLoading || (isLoadingAdvisories ?? false)
  const isAnyRefetching = isRefetching || (isRefetchingAdvisories ?? false)
  const combinedError = error ?? null
  const hasNoItems = filteredAlerts.length === 0 && advisories.length === 0
  const hasAnyLoadedContexts = hasLoadedContexts || (hasLoadedAdvisoryContexts ?? false)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Loaded alerts section */}
      {isLoadingContexts ? (
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        </div>
      ) : hasLoadedContexts ? (
        <div className="border-b border-border">
          <div className="px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/30">
            Loaded Alerts
          </div>
          <div className="max-h-[150px] overflow-y-auto">
            {loadedContexts.map(ctx => (
              <LoadedSecurityItem
                key={ctx.number}
                context={ctx}
                isLoading={loadingNumbers.has(ctx.number)}
                isRemoving={removingNumbers.has(ctx.number)}
                onRefresh={() => onLoadAlert(ctx.number, true)}
                onRemove={() => onRemoveAlert(ctx.number)}
                onView={() => onViewAlert(ctx)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Loaded advisories section */}
      {(isLoadingAdvisoryContexts ?? false) ? (
        !isLoadingContexts && (
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading advisories...
            </div>
          </div>
        )
      ) : (hasLoadedAdvisoryContexts ?? false) && loadedAdvisoryContexts ? (
        <div className="border-b border-border">
          <div className="px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/30">
            Loaded Advisories
          </div>
          <div className="max-h-[150px] overflow-y-auto">
            {loadedAdvisoryContexts.map(ctx => (
              <LoadedAdvisoryItem
                key={ctx.ghsaId}
                context={ctx}
                isLoading={advisoryGhsaLoading.has(ctx.ghsaId)}
                isRemoving={advisoryGhsaRemoving.has(ctx.ghsaId)}
                onRefresh={() => onLoadAdvisory?.(ctx.ghsaId, true)}
                onRemove={() => onRemoveAdvisory?.(ctx.ghsaId)}
                onView={() => onViewAdvisory?.(ctx)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Search section */}
      <div className="p-3 space-y-2 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search by #number, package, CVE, GHSA ID..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRefresh}
                disabled={isAnyRefetching}
                className={cn(
                  'flex items-center justify-center h-8 w-8 rounded-md border border-border',
                  'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                  'transition-colors',
                  isAnyRefetching && 'opacity-50 cursor-not-allowed'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4 text-muted-foreground',
                    isAnyRefetching && 'animate-spin'
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh alerts</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="load-include-resolved-alerts"
            checked={includeClosed}
            onCheckedChange={checked => setIncludeClosed(checked === true)}
          />
          <label
            htmlFor="load-include-resolved-alerts"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            Include resolved alerts
          </label>
        </div>
      </div>

      {/* Alerts and advisories list */}
      <ScrollArea className="flex-1 min-h-0">
        {isAnyLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading security alerts...
            </span>
          </div>
        )}

        {combinedError &&
          (isGhAuthError(combinedError) ? (
            <GhAuthError onLogin={onGhLogin} isGhInstalled={isGhInstalled} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {combinedError.message || 'Failed to load security alerts'}
              </span>
            </div>
          ))}

        {!isAnyLoading &&
          !combinedError &&
          hasNoItems && (
            <div className="flex items-center justify-center py-8">
              <span className="text-sm text-muted-foreground">
                {searchQuery
                  ? 'No alerts or advisories match your search'
                  : hasAnyLoadedContexts
                    ? 'All open alerts and advisories already loaded'
                    : 'No open security alerts or advisories found'}
              </span>
            </div>
          )}

        {!isAnyLoading && !combinedError && !hasNoItems && (
          <div className="py-1">
            {/* Dependabot alerts grouped by state */}
            {filteredAlerts.length > 0 && (
              <>
                {advisories.length > 0 && (
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/30">
                    Dependabot Alerts
                  </div>
                )}
                {filteredAlerts.map((alert, index) => {
                  const showStateHeader =
                    index === 0 ||
                    alert.state !== filteredAlerts[index - 1]?.state
                  return (
                    <div key={alert.number}>
                      {showStateHeader && (
                        <div className="flex items-center gap-1.5 px-3 py-1 mt-1 first:mt-0">
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full flex-shrink-0',
                              STATE_DOT_COLORS[alert.state] ?? 'bg-muted-foreground'
                            )}
                          />
                          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                            {ALERT_STATE_LABELS[alert.state] ?? alert.state}
                          </span>
                        </div>
                      )}
                      <SecurityAlertItem
                        alert={alert}
                        index={index}
                        isSelected={index === selectedIndex}
                        isLoading={loadingNumbers.has(alert.number)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => onSelectAlert(alert)}
                        onPreview={() => onPreviewAlert(alert)}
                      />
                    </div>
                  )
                })}
              </>
            )}

            {/* Repository advisories grouped by state */}
            {advisories.length > 0 && (
              <>
                {filteredAlerts.length > 0 && (
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/30 mt-1">
                    Repository Advisories
                  </div>
                )}
                {advisories.map((advisory, index) => {
                  const combinedIndex = alertsCount + index
                  const showStateHeader =
                    index === 0 ||
                    advisory.state !== advisories[index - 1]?.state
                  return (
                    <div key={advisory.ghsaId}>
                      {showStateHeader && (
                        <div className="flex items-center gap-1.5 px-3 py-1 mt-1 first:mt-0">
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full flex-shrink-0',
                              STATE_DOT_COLORS[advisory.state] ?? 'bg-muted-foreground'
                            )}
                          />
                          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                            {ADVISORY_STATE_LABELS[advisory.state] ?? advisory.state}
                          </span>
                        </div>
                      )}
                      <AdvisoryItem
                        advisory={advisory}
                        index={combinedIndex}
                        isSelected={combinedIndex === selectedIndex}
                        isLoading={advisoryGhsaLoading.has(advisory.ghsaId)}
                        onMouseEnter={() => setSelectedIndex(combinedIndex)}
                        onClick={() => onSelectAdvisory?.(advisory)}
                        onPreview={() => onPreviewAdvisory?.(advisory)}
                      />
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
