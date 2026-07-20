import { AlertCircle, Loader2, RefreshCw, Search } from 'lucide-react'
import { isSentryAuthError } from '@/services/sentry'
import { SentryAuthError } from '@/components/shared/SentryAuthError'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SentryIssueItem } from './SentryIssueItem'
import type { SentryIssue } from '@/types/sentry'

interface SentryIssuesTabProps {
  projectId: string
  searchQuery: string
  setSearchQuery: (query: string) => void
  issues: SentryIssue[]
  isLoading: boolean
  isRefetching: boolean
  error: unknown
  onRefresh: () => void
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelectIssue: (issue: SentryIssue, background?: boolean) => void
  onInvestigateIssue: (issue: SentryIssue, background?: boolean) => void
  creatingFromId: string | null
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

export function SentryIssuesTab({
  projectId,
  searchQuery,
  setSearchQuery,
  issues,
  isLoading,
  isRefetching,
  error,
  onRefresh,
  selectedIndex,
  setSelectedIndex,
  onSelectIssue,
  onInvestigateIssue,
  creatingFromId,
  searchInputRef,
}: SentryIssuesTabProps) {
  const errorMessage = error instanceof Error ? error.message : String(error)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="p-3 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search unresolved Sentry issues..."
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              className="pl-9 h-8 text-base md:text-sm"
            />
          </div>
          <button
            onClick={onRefresh}
            disabled={isRefetching}
            aria-label="Refresh Sentry issues"
            className="flex items-center justify-center h-8 w-8 rounded-md border border-border hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefetching && 'animate-spin')}
            />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Loading issues...
          </div>
        )}
        {error != null &&
          (isSentryAuthError(error) ? (
            <SentryAuthError projectId={projectId} error={error} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="h-5 w-5 text-destructive mb-2" />
              <span className="text-sm text-muted-foreground">
                {errorMessage || 'Failed to load Sentry issues'}
              </span>
            </div>
          ))}
        {!isLoading && !error && issues.length === 0 && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {searchQuery
              ? 'No Sentry issues match your search'
              : 'No unresolved Sentry issues found'}
          </div>
        )}
        {!isLoading && !error && issues.length > 0 && (
          <div className="py-1">
            {issues.map((issue, index) => (
              <SentryIssueItem
                key={issue.id}
                issue={issue}
                index={index}
                isSelected={index === selectedIndex}
                isCreating={creatingFromId === issue.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={background => onSelectIssue(issue, background)}
                onInvestigate={background =>
                  onInvestigateIssue(issue, background)
                }
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
