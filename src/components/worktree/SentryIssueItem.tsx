import { AlertTriangle, Loader2, Wand2 } from 'lucide-react'
import { getModifierSymbol } from '@/lib/platform'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SentryIssue } from '@/types/sentry'

interface SentryIssueItemProps {
  issue: SentryIssue
  index: number
  isSelected: boolean
  isCreating: boolean
  onMouseEnter: () => void
  onClick: (background: boolean) => void
  onInvestigate: (background: boolean) => void
}

function formatCompactCount(value: string | number): string {
  const count = Number(value)
  if (!Number.isFinite(count)) return String(value)

  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(count)
}

export function SentryIssueItem({
  issue,
  index,
  isSelected,
  isCreating,
  onMouseEnter,
  onClick,
  onInvestigate,
}: SentryIssueItemProps) {
  return (
    <div
      data-item-index={index}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex items-start gap-2 sm:gap-3 px-3 py-2.5 sm:py-2 text-left transition-colors hover:bg-accent',
        isSelected && 'bg-accent',
        isCreating && 'opacity-50'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 mt-0.5 text-orange-500 shrink-0" />
      )}
      <button
        onClick={event => onClick(event.metaKey || event.ctrlKey)}
        disabled={isCreating}
        data-testid="sentry-issue-content"
        className="min-w-0 flex-1 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div data-testid="sentry-issue-mobile" className="min-w-0 sm:hidden">
          <span className="block min-w-0 truncate text-sm font-medium">
            {issue.title}
          </span>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
            <span className="shrink-0 whitespace-nowrap font-mono">
              {issue.shortId}
            </span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {formatCompactCount(issue.count)} events
            </span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {formatCompactCount(issue.userCount)}{' '}
              {issue.userCount === 1 ? 'user' : 'users'}
            </span>
          </div>
        </div>

        <div
          data-testid="sentry-issue-desktop"
          className="hidden min-w-0 gap-x-3 gap-y-1 sm:grid sm:grid-cols-[6.5rem_minmax(0,1fr)]"
        >
          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">
            {issue.shortId}
          </span>
          <span className="min-w-0 truncate text-sm font-medium">
            {issue.title}
          </span>
          <span className="whitespace-nowrap text-xs capitalize text-muted-foreground">
            {issue.level}
          </span>
          <div
            data-testid="sentry-issue-metadata"
            className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground"
          >
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {issue.count} events
            </span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {issue.userCount} {issue.userCount === 1 ? 'user' : 'users'}
            </span>
            {issue.culprit && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate" title={issue.culprit}>
                  {issue.culprit}
                </span>
              </>
            )}
          </div>
        </div>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={event => {
              event.stopPropagation()
              onInvestigate(event.metaKey || event.ctrlKey)
            }}
            disabled={isCreating}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-foreground/80 hover:bg-muted disabled:opacity-30"
          >
            <Wand2 className="h-3 w-3 dark:text-yellow-400" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Investigate ({getModifierSymbol()}+M)</TooltipContent>
      </Tooltip>
    </div>
  )
}
