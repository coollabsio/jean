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
import {
  LoadedIssueItem,
  LoadedPRItem,
  IssueItem,
  PRItem,
} from './LoadContextItems'
import type {
  GitHubIssue,
  GitHubPullRequest,
  LoadedIssueContext,
  LoadedPullRequestContext,
} from '@/types/github'

type GitHubItemsTabConfig =
  | {
      kind: 'issues'
      loadedContexts: LoadedIssueContext[]
      filteredItems: GitHubIssue[]
      onSelectItem: (issue: GitHubIssue) => void
      onViewItem: (ctx: LoadedIssueContext) => void
      onPreviewItem: (issue: GitHubIssue) => void
      onRemoveItem: (num: number) => void
      onLoadItem: (num: number, refresh: boolean) => void
    }
  | {
      kind: 'prs'
      loadedContexts: LoadedPullRequestContext[]
      filteredItems: GitHubPullRequest[]
      onSelectItem: (pr: GitHubPullRequest) => void
      onViewItem: (ctx: LoadedPullRequestContext) => void
      onPreviewItem: (pr: GitHubPullRequest) => void
      onRemoveItem: (num: number) => void
      onLoadItem: (num: number, refresh: boolean) => void
    }

interface GitHubItemsTabProps {
  config: GitHubItemsTabConfig
  searchQuery: string
  setSearchQuery: (q: string) => void
  includeClosed: boolean
  setIncludeClosed: (v: boolean) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  isLoadingContexts: boolean
  isLoading: boolean
  isRefetching: boolean
  isSearching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  loadingNumbers: Set<number>
  removingNumbers: Set<number>
  hasLoadedContexts: boolean
  onGhLogin: () => void
  isGhInstalled: boolean
}

export function GitHubItemsTab({
  config,
  searchQuery,
  setSearchQuery,
  includeClosed,
  setIncludeClosed,
  searchInputRef,
  isLoadingContexts,
  isLoading,
  isRefetching,
  isSearching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  loadingNumbers,
  removingNumbers,
  hasLoadedContexts,
  onGhLogin,
  isGhInstalled,
}: GitHubItemsTabProps) {
  const isIssues = config.kind === 'issues'
  const label = isIssues ? 'issues' : 'pull requests'
  const searchPlaceholder = isIssues
    ? 'Search issues by #number, title, or description...'
    : 'Search PRs by #number, title, branch, or description...'
  const closedLabel = isIssues
    ? 'Include closed issues'
    : 'Include closed/merged PRs'
  const loadedLabel = isIssues ? 'Loaded Issues' : 'Loaded Pull Requests'
  const checkboxId = isIssues
    ? 'load-include-closed-issues'
    : 'load-include-closed-prs'

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Loaded items section */}
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
            {loadedLabel}
          </div>
          <div className="max-h-[150px] overflow-y-auto">
            {config.kind === 'issues'
              ? config.loadedContexts.map(ctx => (
                  <LoadedIssueItem
                    key={ctx.number}
                    context={ctx}
                    isLoading={loadingNumbers.has(ctx.number)}
                    isRemoving={removingNumbers.has(ctx.number)}
                    onRefresh={() => config.onLoadItem(ctx.number, true)}
                    onRemove={() => config.onRemoveItem(ctx.number)}
                    onView={() => config.onViewItem(ctx)}
                  />
                ))
              : config.loadedContexts.map(ctx => (
                  <LoadedPRItem
                    key={ctx.number}
                    context={ctx}
                    isLoading={loadingNumbers.has(ctx.number)}
                    isRemoving={removingNumbers.has(ctx.number)}
                    onRefresh={() => config.onLoadItem(ctx.number, true)}
                    onRemove={() => config.onRemoveItem(ctx.number)}
                    onView={() => config.onViewItem(ctx)}
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
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onRefresh}
                disabled={isRefetching}
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
            <TooltipContent>Refresh {label}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={includeClosed}
            onCheckedChange={checked => setIncludeClosed(checked === true)}
          />
          <label
            htmlFor={checkboxId}
            className="text-xs text-muted-foreground cursor-pointer"
          >
            {closedLabel}
          </label>
        </div>
      </div>

      {/* Items list */}
      <ScrollArea className="flex-1 min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading {label}...
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
                {error.message || `Failed to load ${label}`}
              </span>
            </div>
          ))}

        {!isLoading &&
          !error &&
          config.filteredItems.length === 0 &&
          !isSearching && (
            <div className="flex items-center justify-center py-8">
              <span className="text-sm text-muted-foreground">
                {searchQuery
                  ? `No ${label} match your search`
                  : hasLoadedContexts
                    ? `All open ${label} already loaded`
                    : `No open ${label} found`}
              </span>
            </div>
          )}

        {!isLoading &&
          !error &&
          config.filteredItems.length === 0 &&
          isSearching && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Searching GitHub...
              </span>
            </div>
          )}

        {!isLoading && !error && config.filteredItems.length > 0 && (
          <div className="py-1">
            {config.kind === 'issues'
              ? config.filteredItems.map((issue, index) => (
                  <IssueItem
                    key={issue.number}
                    issue={issue}
                    index={index}
                    isSelected={index === selectedIndex}
                    isLoading={loadingNumbers.has(issue.number)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => config.onSelectItem(issue)}
                    onPreview={() => config.onPreviewItem(issue)}
                  />
                ))
              : config.filteredItems.map((pr, index) => (
                  <PRItem
                    key={pr.number}
                    pr={pr}
                    index={index}
                    isSelected={index === selectedIndex}
                    isLoading={loadingNumbers.has(pr.number)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => config.onSelectItem(pr)}
                    onPreview={() => config.onPreviewItem(pr)}
                  />
                ))}
            {isSearching && (
              <div className="flex items-center justify-center py-2">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="ml-1.5 text-xs text-muted-foreground">
                  Searching GitHub for more results...
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
