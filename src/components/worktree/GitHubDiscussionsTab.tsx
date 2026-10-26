import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Search,
} from '@/components/icons/reicon'
import { isGhAuthError } from '@/services/github'
import { GhAuthError } from '@/components/shared/GhAuthError'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { formatRelative } from '@/components/agents/AgentActivity'
import { cn } from '@/lib/utils'
import {
  ContextLinkBadge,
  type GetContextLinkMatches,
} from './ContextLinkBadge'
import { githubRowClass } from './NewWorktreeItems'
import type { GitHubDiscussion } from '@/types/github'

interface GitHubDiscussionsTabProps {
  searchQuery: string
  setSearchQuery: (query: string) => void
  includeClosed: boolean
  setIncludeClosed: (include: boolean) => void
  discussions: GitHubDiscussion[]
  isLoading: boolean
  isRefetching: boolean
  isSearching: boolean
  error: Error | null
  onRefresh: () => void
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectDiscussion: (
    discussion: GitHubDiscussion,
    background?: boolean
  ) => void
  creatingFromNumber: number | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onLogin: () => void
  isGhInstalled: boolean
  getContextMatches?: GetContextLinkMatches
}

export function GitHubDiscussionsTab({
  searchQuery,
  setSearchQuery,
  includeClosed,
  setIncludeClosed,
  discussions,
  isLoading,
  isRefetching,
  isSearching,
  error,
  onRefresh,
  hasMore,
  isLoadingMore,
  onLoadMore,
  selectedIndex,
  setSelectedIndex,
  onSelectDiscussion,
  creatingFromNumber,
  searchInputRef,
  onLogin,
  isGhInstalled,
  getContextMatches,
}: GitHubDiscussionsTabProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="p-3 space-y-2 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search by #number, title, category..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-base md:text-sm"
            />
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefetching}
            aria-label="Refresh discussions"
            className="flex items-center justify-center h-8 w-8 rounded-md border border-border hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw
              className={cn(
                'h-4 w-4 text-muted-foreground',
                isRefetching && 'animate-spin'
              )}
            />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-closed-discussions"
            checked={includeClosed}
            onCheckedChange={checked => setIncludeClosed(checked === true)}
          />
          <label
            htmlFor="include-closed-discussions"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            Include closed discussions
          </label>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Loading
            discussions...
          </div>
        )}

        {error &&
          (isGhAuthError(error) ? (
            <GhAuthError onLogin={onLogin} isGhInstalled={isGhInstalled} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {error.message || 'Failed to load discussions'}
              </span>
            </div>
          ))}

        {!isLoading && !error && discussions.length === 0 && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {isSearching ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Searching
                GitHub...
              </>
            ) : searchQuery ? (
              'No discussions match your search'
            ) : (
              'No open discussions found'
            )}
          </div>
        )}

        {!isLoading && !error && discussions.length > 0 && (
          <div>
            {discussions.map((discussion, index) => {
              const isCreating = creatingFromNumber === discussion.number
              return (
                <DiscussionItem
                  key={discussion.number}
                  discussion={discussion}
                  index={index}
                  isSelected={index === selectedIndex}
                  isCreating={isCreating}
                  contextMatches={getContextMatches?.({
                    type: 'discussion',
                    id: discussion.number,
                  })}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={background =>
                    onSelectDiscussion(discussion, background)
                  }
                />
              )
            })}
            {hasMore && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isLoadingMore}
                className="flex w-full items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              >
                {isLoadingMore && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Load more discussions
              </button>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function DiscussionItem({
  discussion,
  index,
  isSelected,
  isCreating,
  contextMatches,
  onMouseEnter,
  onClick,
}: {
  discussion: GitHubDiscussion
  index: number
  isSelected: boolean
  isCreating: boolean
  contextMatches?: ReturnType<GetContextLinkMatches>
  onMouseEnter: () => void
  onClick: (background: boolean) => void
}) {
  const createdAt = Date.parse(discussion.createdAt)
  return (
    <div
      data-item-index={index}
      onMouseEnter={onMouseEnter}
      onClick={e => !isCreating && onClick(e.metaKey || e.ctrlKey)}
      className={githubRowClass(isSelected, false, isCreating)}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <MessagesSquare
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            discussion.closed
              ? 'text-purple-600 dark:text-purple-400'
              : 'text-success'
          )}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="min-w-0 text-sm font-semibold leading-5">
            {discussion.title}
          </span>
          {discussion.category && (
            <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">
              {discussion.category.name}
            </span>
          )}
          {discussion.isAnswered && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/20 bg-success/10 px-1.5 py-px text-[11px] font-medium text-success">
              <CheckCircle2 className="h-3 w-3" />
              Answered
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground truncate">
          #{discussion.number}
          {!Number.isNaN(createdAt) &&
            ` opened ${formatRelative(createdAt / 1000)}`}
          {discussion.author && (
            <>
              {' by '}
              <span className="text-foreground/70">
                {discussion.author.login}
              </span>
            </>
          )}
          {` · ${discussion.commentCount} ${discussion.commentCount === 1 ? 'comment' : 'comments'}`}
        </div>
      </div>
      <ContextLinkBadge matches={contextMatches} />
    </div>
  )
}
