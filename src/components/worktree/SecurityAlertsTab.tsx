import { Loader2, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { isGhAuthError } from '@/services/github'
import { GhAuthError } from '@/components/shared/GhAuthError'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SecurityAlertItem, AdvisoryItem } from './NewWorktreeItems'
import type { DependabotAlert, RepositoryAdvisory } from '@/types/github'

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

export interface SecurityAlertsTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  includeClosed: boolean
  setIncludeClosed: (include: boolean) => void
  alerts: DependabotAlert[]
  isLoading: boolean
  isRefetching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectAlert: (alert: DependabotAlert, background?: boolean) => void
  onInvestigateAlert: (alert: DependabotAlert, background?: boolean) => void
  onPreviewAlert: (alert: DependabotAlert) => void
  creatingFromNumber: number | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onGhLogin: () => void
  isGhInstalled: boolean
  // Repository advisories
  filteredAdvisories: RepositoryAdvisory[]
  isLoadingAdvisories: boolean
  isRefetchingAdvisories: boolean
  onSelectAdvisory: (advisory: RepositoryAdvisory, background?: boolean) => void
  onInvestigateAdvisory: (
    advisory: RepositoryAdvisory,
    background?: boolean
  ) => void
  onPreviewAdvisory: (advisory: RepositoryAdvisory) => void
  creatingFromGhsaId: string | null
}

export function SecurityAlertsTab({
  searchQuery,
  setSearchQuery,
  includeClosed,
  setIncludeClosed,
  alerts,
  isLoading,
  isRefetching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectAlert,
  onInvestigateAlert,
  onPreviewAlert,
  creatingFromNumber,
  searchInputRef,
  onGhLogin,
  isGhInstalled,
  filteredAdvisories,
  isLoadingAdvisories,
  isRefetchingAdvisories,
  onSelectAdvisory,
  onInvestigateAdvisory,
  onPreviewAdvisory,
  creatingFromGhsaId,
}: SecurityAlertsTabProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search and filters */}
      <div className="p-3 space-y-2 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search alerts by #number, package, CVE, or GHSA ID..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRefresh}
                disabled={isRefetching || isRefetchingAdvisories}
                className={cn(
                  'flex items-center justify-center h-8 w-8 rounded-md border border-border',
                  'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                  'transition-colors',
                  (isRefetching || isRefetchingAdvisories) &&
                    'opacity-50 cursor-not-allowed'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4 text-muted-foreground',
                    (isRefetching || isRefetchingAdvisories) && 'animate-spin'
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh security data</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-resolved"
            checked={includeClosed}
            onCheckedChange={checked => setIncludeClosed(checked === true)}
          />
          <label
            htmlFor="include-resolved"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            Include resolved alerts
          </label>
        </div>
      </div>

      {/* Alerts and advisories list */}
      <ScrollArea className="flex-1">
        {isLoading && isLoadingAdvisories && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading security data...
            </span>
          </div>
        )}

        {error &&
          (isGhAuthError(error) ? (
            <GhAuthError onLogin={onGhLogin} isGhInstalled={isGhInstalled} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {error.message || 'Failed to load security alerts'}
              </span>
            </div>
          ))}

        {!isLoading &&
          !isLoadingAdvisories &&
          !error &&
          alerts.length === 0 &&
          filteredAdvisories.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <span className="text-sm text-muted-foreground">
                {searchQuery
                  ? 'No alerts or advisories match your search'
                  : 'No open security alerts or advisories found'}
              </span>
            </div>
          )}

        {/* Dependabot Alerts section grouped by state */}
        {!isLoading && !error && alerts.length > 0 && (
          <div className="py-1">
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Dependabot Alerts
            </div>
            {alerts.map((alert, index) => {
              const showStateHeader =
                index === 0 || alert.state !== alerts[index - 1]?.state
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
                    isCreating={creatingFromNumber === alert.number}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={bg => onSelectAlert(alert, bg)}
                    onInvestigate={bg => onInvestigateAlert(alert, bg)}
                    onPreview={() => onPreviewAlert(alert)}
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* Repository Advisories section grouped by state */}
        {!isLoadingAdvisories && filteredAdvisories.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Repository Advisories
              </div>
              {filteredAdvisories.map((advisory, index) => {
                const combinedIndex = alerts.length + index
                const showStateHeader =
                  index === 0 ||
                  advisory.state !== filteredAdvisories[index - 1]?.state
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
                      isCreating={creatingFromGhsaId === advisory.ghsaId}
                      onMouseEnter={() => setSelectedIndex(combinedIndex)}
                      onClick={bg => onSelectAdvisory(advisory, bg)}
                      onInvestigate={bg => onInvestigateAdvisory(advisory, bg)}
                      onPreview={() => onPreviewAdvisory(advisory)}
                    />
                  </div>
                )
              })}
            </div>
          )}
      </ScrollArea>
    </div>
  )
}
