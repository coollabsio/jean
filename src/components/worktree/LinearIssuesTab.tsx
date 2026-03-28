import { Loader2, Search, RefreshCw, AlertCircle } from 'lucide-react'
import { isLinearAuthError } from '@/services/linear'
import { LinearAuthError } from '@/components/shared/LinearAuthError'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LinearIssueItem } from './LinearIssueItem'
import type { LinearIssue } from '@/types/linear'

export interface LinearIssuesTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  issues: LinearIssue[]
  isLoading: boolean
  isRefetching: boolean
  isSearching: boolean
  error: Error | null
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectIssue: (issue: LinearIssue, background?: boolean) => void
  onInvestigateIssue: (issue: LinearIssue, background?: boolean) => void
  onPreviewIssue?: (issue: LinearIssue) => void
  creatingFromId: string | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

export function LinearIssuesTab({
  searchQuery,
  setSearchQuery,
  issues,
  isLoading,
  isRefetching,
  isSearching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectIssue,
  onInvestigateIssue,
  onPreviewIssue,
  creatingFromId,
  searchInputRef,
}: LinearIssuesTabProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search */}
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
      <ScrollArea className="flex-1">
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

        {!isLoading && !error && issues.length === 0 && !isSearching && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              {searchQuery
                ? 'No issues match your search'
                : 'No active issues found'}
            </span>
          </div>
        )}

        {!isLoading && !error && issues.length === 0 && isSearching && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Searching Linear...
            </span>
          </div>
        )}

        {!isLoading && !error && issues.length > 0 && (
          <div className="py-1">
            {issues.map((issue, index) => (
              <LinearIssueItem
                key={issue.id}
                issue={issue}
                index={index}
                isSelected={index === selectedIndex}
                isCreating={creatingFromId === issue.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={bg => onSelectIssue(issue, bg)}
                onInvestigate={bg => onInvestigateIssue(issue, bg)}
                onPreview={
                  onPreviewIssue ? () => onPreviewIssue(issue) : undefined
                }
              />
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
