import { Eye, Loader2, RotateCw, X } from 'lucide-react'
import { SentryIssuesTab } from '@/components/worktree/SentryIssuesTab'
import type { SentryIssue, SentryIssueContext } from '@/types/sentry'

interface SentryItemsTabProps {
  projectId: string
  searchQuery: string
  setSearchQuery: (query: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  loadedContexts: SentryIssueContext[]
  isLoadingContexts: boolean
  loadingIds: Set<string>
  removingIds: Set<string>
  onView: (context: SentryIssueContext) => void
  onRefreshContext: (context: SentryIssueContext) => void
  onRemove: (context: SentryIssueContext) => void
  issues: SentryIssue[]
  isLoading: boolean
  isRefetching: boolean
  error: unknown
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectIssue: (issue: SentryIssue) => void
}

export function SentryItemsTab({
  projectId,
  searchQuery,
  setSearchQuery,
  searchInputRef,
  loadedContexts,
  isLoadingContexts,
  loadingIds,
  removingIds,
  onView,
  onRefreshContext,
  onRemove,
  issues,
  isLoading,
  isRefetching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectIssue,
}: SentryItemsTabProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isLoadingContexts ? (
        <div className="px-4 py-3 border-b border-border text-sm text-muted-foreground">
          <Loader2 className="inline h-4 w-4 mr-2 animate-spin" />
          Loading loaded Sentry issues...
        </div>
      ) : loadedContexts.length > 0 ? (
        <div className="border-b border-border">
          <div className="px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/30">
            Loaded Sentry Issues
          </div>
          {loadedContexts.map(context => (
            <div
              key={context.id}
              className="flex items-center gap-2 px-4 py-1.5 hover:bg-accent group"
            >
              <span className="text-xs text-muted-foreground font-mono">
                {context.shortId}
              </span>
              <span className="text-sm truncate flex-1">{context.title}</span>
              <button
                type="button"
                onClick={() => onView(context)}
                aria-label={`View ${context.shortId}`}
                className="p-1 rounded hover:bg-accent-foreground/10"
              >
                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={() => onRefreshContext(context)}
                disabled={loadingIds.has(context.id)}
                aria-label={`Refresh ${context.shortId}`}
                className="p-1 rounded hover:bg-accent-foreground/10 disabled:opacity-50"
              >
                {loadingIds.has(context.id) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onRemove(context)}
                disabled={removingIds.has(context.id)}
                aria-label={`Remove ${context.shortId}`}
                className="p-1 rounded hover:bg-destructive/10 disabled:opacity-50"
              >
                {removingIds.has(context.id) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <SentryIssuesTab
        projectId={projectId}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        issues={issues}
        isLoading={isLoading}
        isRefetching={isRefetching}
        error={error}
        onRefresh={onRefresh}
        selectedIndex={selectedIndex}
        setSelectedIndex={setSelectedIndex}
        onSelectIssue={onSelectIssue}
        onInvestigateIssue={onSelectIssue}
        creatingFromId={loadingIds.values().next().value ?? null}
        searchInputRef={searchInputRef}
      />
    </div>
  )
}
