import { GitBranch, MessageSquare } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  contextLinkMatchLabel,
  type ContextLinkMatch,
  type ContextLinkRef,
} from '@/hooks/useContextLinkUsage'
import { cn } from '@/lib/utils'

export type GetContextLinkMatches = (ref: ContextLinkRef) => ContextLinkMatch[]

/**
 * Compact "In <worktree › session>" marker for items that already have a
 * worktree or session. With `onOpen`, clicking it opens the first match.
 */
export function ContextLinkBadge({
  matches,
  currentWorktreeId,
  onOpen,
}: {
  matches?: ContextLinkMatch[]
  /** Matches in this worktree show only the session name */
  currentWorktreeId?: string
  onOpen?: (match: ContextLinkMatch) => void
}) {
  const first = matches?.[0]
  if (!matches || !first) return null
  const extra = matches.length - 1
  const Icon = first.sessionId ? MessageSquare : GitBranch
  const className = cn(
    'inline-flex min-w-0 max-w-[7rem] shrink items-center gap-1 self-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:max-w-[14rem]',
    onOpen && 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
  )
  const content = (
    <>
      <Icon className="h-3 w-3 shrink-0 text-current" />
      <span className="truncate">
        In {contextLinkMatchLabel(first, currentWorktreeId)}
      </span>
      {extra > 0 && <span className="shrink-0">+{extra}</span>}
    </>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onOpen ? (
          <button
            type="button"
            data-testid="context-link-badge"
            aria-label={`Open ${contextLinkMatchLabel(first, currentWorktreeId)}`}
            className={className}
            onClick={event => {
              event.stopPropagation()
              onOpen(first)
            }}
          >
            {content}
          </button>
        ) : (
          <span data-testid="context-link-badge" className={className}>
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <div className="font-medium">Already in:</div>
          {matches.map(match => (
            <div key={`${match.worktreeId}:${match.sessionId ?? ''}`}>
              {contextLinkMatchLabel(match, currentWorktreeId)}
            </div>
          ))}
          {onOpen && <div className="mt-1 opacity-70">Click to open</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
