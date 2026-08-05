import { useCallback } from 'react'
import { Loader2, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { isGhAuthError } from '@/services/github'
import { GhAuthError } from '@/components/shared/GhAuthError'
import { isGlabAuthError } from '@/services/glab-cli'
import { GlabAuthError } from '@/components/shared/GlabAuthError'
import { providerLabels } from '@/services/git-provider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PRItem } from './NewWorktreeItems'
import { BulkInvestigateBar } from './BulkInvestigateBar'
import { SelectAllControl } from './ItemSelectCheckbox'
import { useMultiSelect } from './hooks/useMultiSelect'
import type { GitHubPullRequest } from '@/types/github'
import type { GitProvider } from '@/types/provider'

export interface GitHubPRsTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  includeClosed: boolean
  setIncludeClosed: (include: boolean) => void
  prs: GitHubPullRequest[]
  isLoading: boolean
  isRefetching: boolean
  isSearching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectPR: (pr: GitHubPullRequest, background?: boolean) => void
  onInvestigatePR: (pr: GitHubPullRequest, background?: boolean) => void
  onBulkInvestigatePRs?: (prs: GitHubPullRequest[]) => void | Promise<void>
  onStackPR: (pr: GitHubPullRequest, background?: boolean) => void
  onPreviewPR: (pr: GitHubPullRequest) => void
  creatingFromNumber: number | null
  stackingFromPR: number | null
  isBulkInvestigating?: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onLogin: () => void
  isCliInstalled: boolean
  provider?: GitProvider
  /**
   * Whether the git-host provider has been resolved. While false the provider
   * still defaults to `github`, so we defer the auth-error branch to avoid a
   * transient "Sign in to GitHub" flash on GitLab projects.
   */
  providerResolved?: boolean
}

const getPRKey = (pr: GitHubPullRequest) => pr.number

export function GitHubPRsTab({
  searchQuery,
  setSearchQuery,
  includeClosed,
  setIncludeClosed,
  prs,
  isLoading,
  isRefetching,
  isSearching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectPR,
  onInvestigatePR,
  onBulkInvestigatePRs,
  onStackPR,
  onPreviewPR,
  creatingFromNumber,
  stackingFromPR,
  isBulkInvestigating = false,
  searchInputRef,
  onLogin,
  isCliInstalled,
  provider = 'github',
  providerResolved = true,
}: GitHubPRsTabProps) {
  const labels = providerLabels(provider)
  const prPluralLower = `${labels.pullRequest.toLowerCase()}s`
  const multi = useMultiSelect(prs, getPRKey)

  const handleBulkInvestigate = useCallback(async () => {
    if (!onBulkInvestigatePRs || multi.selectedItems.length < 1) return
    await onBulkInvestigatePRs(multi.selectedItems)
    multi.clear()
  }, [onBulkInvestigatePRs, multi])

  const handleLabelClick = (labelName: string) => {
    const token = `label:"${labelName}"`
    if (!searchQuery.includes(token)) {
      setSearchQuery(searchQuery ? `${searchQuery} ${token}` : token)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="p-3 space-y-2 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder='Search by #number, title, branch, label… or label:"bug"'
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-base md:text-sm"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onRefresh}
                disabled={isRefetching}
                aria-label="Refresh pull requests"
                className={cn(
                  'flex items-center justify-center h-8 w-8 rounded-md border border-border',
                  'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                  'transition-colors',
                  isRefetching && 'opacity-50 cursor-not-allowed'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-4 w-4 text-muted-foreground',
                    isRefetching && 'animate-spin'
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh {prPluralLower}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Checkbox
            id="include-closed-prs"
            checked={includeClosed}
            onCheckedChange={checked => setIncludeClosed(checked === true)}
          />
          <label
            htmlFor="include-closed-prs"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            Include closed/merged {labels.pullRequestsShort}
          </label>
          {!isLoading && !error && prs.length > 0 && (
            <SelectAllControl
              id="select-all-prs"
              allChecked={multi.allVisibleChecked}
              someChecked={multi.someVisibleChecked}
              onToggleAll={multi.toggleAllVisible}
              ariaLabel="Select all visible pull requests"
            />
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading {prPluralLower}...
            </span>
          </div>
        )}

        {error && !providerResolved && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error &&
          providerResolved &&
          ((provider === 'gitlab' ? isGlabAuthError(error) : isGhAuthError(error)) ? (
            provider === 'gitlab' ? (
              <GlabAuthError onLogin={onLogin} isGlabInstalled={isCliInstalled} />
            ) : (
              <GhAuthError onLogin={onLogin} isGhInstalled={isCliInstalled} />
            )
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {error.message || `Failed to load ${prPluralLower}`}
              </span>
            </div>
          ))}

        {!isLoading && !error && prs.length === 0 && !isSearching && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              {searchQuery
                ? `No ${labels.pullRequestsShort} match your search`
                : `No open ${prPluralLower} found`}
            </span>
          </div>
        )}

        {!isLoading && !error && prs.length === 0 && isSearching && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Searching {labels.name}...
            </span>
          </div>
        )}

        {!isLoading && !error && prs.length > 0 && (
          <div className="py-1">
            {prs.map((pr, index) => (
              <PRItem
                key={pr.number}
                pr={pr}
                index={index}
                isSelected={index === selectedIndex}
                isCreating={creatingFromNumber === pr.number}
                isStacking={stackingFromPR === pr.number}
                isChecked={multi.isChecked(pr.number)}
                onCheckedChange={checked => multi.toggle(pr.number, checked)}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={bg => onSelectPR(pr, bg)}
                onInvestigate={bg => onInvestigatePR(pr, bg)}
                onStack={bg => onStackPR(pr, bg)}
                onPreview={() => onPreviewPR(pr)}
                onLabelClick={handleLabelClick}
              />
            ))}
            {isSearching && (
              <div className="flex items-center justify-center py-2">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="ml-1.5 text-xs text-muted-foreground">
                  Searching {labels.name} for more results...
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {multi.showBulkBar && onBulkInvestigatePRs && (
        <BulkInvestigateBar
          count={multi.checkedCount}
          isLoading={isBulkInvestigating}
          noun={multi.checkedCount === 1 ? 'PR' : 'PRs'}
          onClear={multi.clear}
          onInvestigate={() => void handleBulkInvestigate()}
        />
      )}
    </div>
  )
}
