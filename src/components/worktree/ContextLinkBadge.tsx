import { GitBranch } from '@/components/icons/reicon'
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

export type GetContextLinkMatches = (ref: ContextLinkRef) => ContextLinkMatch[]

/** Compact "In <worktree › session>" marker for items that already have a worktree. */
export function ContextLinkBadge({
  matches,
}: {
  matches?: ContextLinkMatch[]
}) {
  const first = matches?.[0]
  if (!matches || !first) return null
  const extra = matches.length - 1

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="context-link-badge"
          className="inline-flex min-w-0 max-w-[7rem] shrink items-center gap-1 self-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:max-w-[14rem]"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate">In {contextLinkMatchLabel(first)}</span>
          {extra > 0 && <span className="shrink-0">+{extra}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <div className="font-medium">Already in:</div>
          {matches.map(match => (
            <div key={match.worktreeId}>{contextLinkMatchLabel(match)}</div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
