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
import { PRItem } from './NewWorktreeItems'
import type { GitHubPullRequest } from '@/types/github'

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
  onPreviewPR: (pr: GitHubPullRequest) => void
  creatingFromNumber: number | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onGhLogin: () => void
  isGhInstalled: boolean
}

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
  onPreviewPR,
  creatingFromNumber,
  searchInputRef,
  onGhLogin,
  isGhInstalled,
}: GitHubPRsTabProps) {
  const handleLabelClick = (labelName: string) => {
    const token = `label:"${labelName}"`
    if (!searchQuery.includes(token)) {
      setSearchQuery(searchQuery ? `${searchQuery} ${token}` : token)
    }
  }

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
              placeholder='Search by #number, title, branch, label… or label:"bug"'
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
            <TooltipContent>Refresh pull requests</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-closed-prs"
            checked={includeClosed}
            onCheckedChange={checked => setIncludeClosed(checked === true)}
          />
          <label
            htmlFor="include-closed-prs"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            Include closed/merged PRs
          </label>
        </div>
      </div>

      {/* PRs list */}
      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading pull requests...
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
                {error.message || 'Failed to load pull requests'}
              </span>
            </div>
          ))}

        {!isLoading && !error && prs.length === 0 && !isSearching && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">
              {searchQuery
                ? 'No PRs match your search'
                : 'No open pull requests found'}
            </span>
          </div>
        )}

        {!isLoading && !error && prs.length === 0 && isSearching && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Searching GitHub...
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
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={bg => onSelectPR(pr, bg)}
                onInvestigate={bg => onInvestigatePR(pr, bg)}
                onPreview={() => onPreviewPR(pr)}
                onLabelClick={handleLabelClick}
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
