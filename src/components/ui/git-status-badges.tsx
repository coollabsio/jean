import { ArrowDownUp } from '@/components/icons/reicon'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

interface GitStatusBadgesProps {
  behindCount: number
  unpushedCount: number
  diffAdded: number
  diffRemoved: number
  branchDiffAdded?: number
  branchDiffRemoved?: number
  onSync?: (e: React.MouseEvent) => void
  onDiffClick?: (e: React.MouseEvent) => void
  onBranchDiffClick?: (e: React.MouseEvent) => void
}

export function GitStatusBadges({
  behindCount,
  unpushedCount,
  diffAdded,
  diffRemoved,
  branchDiffAdded = 0,
  branchDiffRemoved = 0,
  onSync,
  onDiffClick,
  onBranchDiffClick,
}: GitStatusBadgesProps) {
  const hasDiff = diffAdded > 0 || diffRemoved > 0
  const hasBranchDiff = branchDiffAdded > 0 || branchDiffRemoved > 0
  const hasRemoteDivergence = behindCount > 0 || unpushedCount > 0
  if (!behindCount && !unpushedCount && !hasDiff && !hasBranchDiff) return null

  const syncTooltip = (() => {
    const parts: string[] = []
    if (behindCount > 0) {
      parts.push(`pull ${behindCount} commit${behindCount > 1 ? 's' : ''}`)
    }
    if (unpushedCount > 0) {
      parts.push(`push ${unpushedCount} commit${unpushedCount > 1 ? 's' : ''}`)
    }
    if (parts.length === 0) return 'Sync with remote'
    return `Sync: ${parts.join(', ')}`
  })()

  return (
    <span className="inline-flex items-center gap-1.5">
      {hasDiff && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDiffClick}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs tabular-nums leading-none hover:opacity-70 transition-opacity"
            >
              <span className="text-success">+{diffAdded}</span>
              <span className="text-destructive">-{diffRemoved}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{`+${diffAdded}/-${diffRemoved} lines — click to view diff`}</TooltipContent>
        </Tooltip>
      )}
      {hasBranchDiff && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBranchDiffClick}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs tabular-nums leading-none hover:opacity-70 transition-opacity"
            >
              <span className="text-success">+{branchDiffAdded}</span>
              <span className="text-destructive">-{branchDiffRemoved}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{`+${branchDiffAdded}/-${branchDiffRemoved} lines vs base — click to view diff`}</TooltipContent>
        </Tooltip>
      )}
      {hasRemoteDivergence && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge asChild variant="info">
              <button
                type="button"
                onClick={onSync}
                className="cursor-pointer gap-0.5 text-2xs hover:bg-info/20"
              >
                <ArrowDownUp />
                {behindCount > 0 && unpushedCount > 0
                  ? `${behindCount}/${unpushedCount}`
                  : behindCount > 0
                    ? behindCount
                    : unpushedCount}
              </button>
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{syncTooltip}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
