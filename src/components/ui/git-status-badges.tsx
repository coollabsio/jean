import { ArrowDown, ArrowUp } from 'lucide-react'
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
  onPull?: (e: React.MouseEvent) => void
  onPush?: (e: React.MouseEvent) => void
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
  onPull,
  onPush,
  onDiffClick,
  onBranchDiffClick,
}: GitStatusBadgesProps) {
  const hasDiff = diffAdded > 0 || diffRemoved > 0
  const hasBranchDiff = branchDiffAdded > 0 || branchDiffRemoved > 0
  if (!behindCount && !unpushedCount && !hasDiff && !hasBranchDiff) return null

  return (
    <span className="inline-flex items-center gap-1.5">
      {hasDiff && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDiffClick}
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 text-xs font-medium leading-none transition-opacity"
            >
              <span className="text-green-500">+{diffAdded}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-red-500">-{diffRemoved}</span>
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
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 text-xs font-medium leading-none hover:opacity-70 transition-opacity"
            >
              <span className="text-green-500">+{branchDiffAdded}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-red-500">-{branchDiffRemoved}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{`+${branchDiffAdded}/-${branchDiffRemoved} lines vs base — click to view diff`}</TooltipContent>
        </Tooltip>
      )}
      {behindCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onPull}
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <ArrowDown className="h-3 w-3" />
              {behindCount}
            </button>
          </TooltipTrigger>
          <TooltipContent>{`Pull ${behindCount} commit${behindCount > 1 ? 's' : ''} from remote`}</TooltipContent>
        </Tooltip>
      )}
      {unpushedCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onPush}
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-500 transition-colors hover:bg-orange-500/20"
            >
              <ArrowUp className="h-3 w-3" />
              {unpushedCount}
            </button>
          </TooltipTrigger>
          <TooltipContent>{`Push ${unpushedCount} commit${unpushedCount > 1 ? 's' : ''} to remote`}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
