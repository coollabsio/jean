import {
  Search,
  Loader2,
  RefreshCw,
  AlertCircle,
  X,
  Eye,
  RotateCw,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isLinearAuthError } from '@/services/linear'
import { LinearAuthError } from '@/components/shared/LinearAuthError'
import type { LinearIssue, LoadedLinearIssueContext } from '@/types/linear'

interface LinearItemsTabProps {
  searchQuery: string
  setSearchQuery: (q: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  // Loaded contexts
  loadedContexts: LoadedLinearIssueContext[]
  isLoadingContexts: boolean
  hasLoadedContexts: boolean
  loadingLinearIds: Set<string>
  removingLinearIds: Set<string>
  onViewLoaded: (ctx: LoadedLinearIssueContext) => void
  onRemoveLoaded: (identifier: string) => void
  onRefreshLoaded: (issueId: string, identifier: string) => void
  // Available issues
  filteredIssues: LinearIssue[]
  isLoading: boolean
  isRefetching: boolean
  isSearching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  onSelectIssue: (issue: LinearIssue) => void
}

export function LinearItemsTab({
  searchQuery,
  setSearchQuery,
  searchInputRef,
  loadedContexts,
  isLoadingContexts,
  hasLoadedContexts,
  loadingLinearIds,
  removingLinearIds,
  onViewLoaded,
  onRemoveLoaded,
  onRefreshLoaded,
  filteredIssues,
  isLoading,
  isRefetching,
  isSearching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectIssue,
}: LinearItemsTabProps) {
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
            Loaded Linear Issues
          </div>
          <div className="max-h-[150px] overflow-y-auto">
            {loadedContexts.map(ctx => (
              <div
                key={ctx.identifier}
                className="flex items-center gap-2 px-4 py-1.5 hover:bg-accent group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground font-mono">
                      {ctx.identifier}
                    </span>
                    <span className="text-sm truncate">{ctx.title}</span>
                    {ctx.commentCount > 0 && (
                      <span className="text-xs text-muted-foreground">
                        ({ctx.commentCount} comments)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onViewLoaded(ctx)}
                        className="p-1 rounded hover:bg-accent-foreground/10"
                      >
                        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>View context</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          onRefreshLoaded(ctx.identifier, ctx.identifier)
                        }
                        disabled={loadingLinearIds.has(ctx.identifier)}
                        className="p-1 rounded hover:bg-accent-foreground/10 disabled:opacity-50"
                      >
                        {loadingLinearIds.has(ctx.identifier) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Refresh</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onRemoveLoaded(ctx.identifier)}
                        disabled={removingLinearIds.has(ctx.identifier)}
                        className="p-1 rounded hover:bg-destructive/10 disabled:opacity-50"
                      >
                        {removingLinearIds.has(ctx.identifier) ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : (
                          <X className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Remove</TooltipContent>
                  </Tooltip>
                </div>
              </div>
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
              placeholder="Search issues by identifier, title, or description..."
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
            <TooltipContent>Refresh issues</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Issues list */}
      <ScrollArea className="flex-1 min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading issues...
            </span>
          </div>
        )}

        {error &&
          (isLinearAuthError(error) ? (
            <LinearAuthError />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {error.message || 'Failed to load issues'}
              </span>
            </div>
          ))}

        {!isLoading &&
          !error &&
          filteredIssues.length === 0 &&
          !isSearching && (
            <div className="flex items-center justify-center py-8">
              <span className="text-sm text-muted-foreground">
                {searchQuery
                  ? 'No issues match your search'
                  : hasLoadedContexts
                    ? 'All active issues already loaded'
                    : 'No active issues found'}
              </span>
            </div>
          )}

        {!isLoading && !error && filteredIssues.length === 0 && isSearching && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Searching Linear...
            </span>
          </div>
        )}

        {!isLoading && !error && filteredIssues.length > 0 && (
          <div className="py-1">
            {filteredIssues.map((issue, index) => (
              <button
                key={issue.id}
                data-load-item-index={index}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onSelectIssue(issue)}
                disabled={loadingLinearIds.has(issue.identifier)}
                className={cn(
                  'w-full flex items-start gap-3 px-4 py-2 text-left transition-colors',
                  'hover:bg-accent',
                  index === selectedIndex && 'bg-accent',
                  loadingLinearIds.has(issue.identifier) && 'opacity-50'
                )}
              >
                {loadingLinearIds.has(issue.identifier) ? (
                  <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
                ) : (
                  <div
                    className="h-4 w-4 mt-0.5 flex-shrink-0 rounded-full border-2"
                    style={{ borderColor: issue.state.color }}
                    title={issue.state.name}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground font-mono">
                      {issue.identifier}
                    </span>
                    <span className="text-sm font-medium truncate">
                      {issue.title}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {issue.priority > 0 && (
                      <span className="px-1.5 py-0.5 text-xs rounded-full bg-muted text-muted-foreground">
                        {issue.priorityLabel}
                      </span>
                    )}
                    {issue.labels.slice(0, 3).map(label => (
                      <span
                        key={label.name}
                        className="px-1.5 py-0.5 text-xs rounded-full"
                        style={{
                          backgroundColor: `${label.color}20`,
                          color: label.color,
                          border: `1px solid ${label.color}40`,
                        }}
                      >
                        {label.name}
                      </span>
                    ))}
                    {issue.labels.length > 3 && (
                      <span className="text-xs text-muted-foreground">
                        +{issue.labels.length - 3}
                      </span>
                    )}
                    {issue.assignee && (
                      <span className="text-xs text-muted-foreground ml-1">
                        {issue.assignee.displayName}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
            {isSearching && (
              <div className="flex items-center justify-center py-2">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="ml-1.5 text-xs text-muted-foreground">
                  Searching Linear for more results...
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
