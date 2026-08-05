import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { useWorkflowRuns } from '@/services/github'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { useUIStore } from '@/store/ui-store'
import { countUnreadFailedWorkflowRuns } from '@/components/shared/workflow-run-utils'
import type { GhAuthStatus } from '@/types/gh-cli'

const BADGE_STALE_TIME = 5 * 60 * 1000 // 5 minutes — background badge, not active UI

interface FailedRunsBadgeProps {
  projectPath: string
  branch?: string
  className?: string
}

export function FailedRunsBadge({
  projectPath,
  branch,
  className,
}: FailedRunsBadgeProps) {
  const queryClient = useQueryClient()
  const authData = queryClient.getQueryData<GhAuthStatus>(ghCliQueryKeys.auth())
  const isAuthenticated = authData?.authenticated ?? false
  const seenFailedWorkflowRunIds = useUIStore(
    state => state.seenFailedWorkflowRunIds
  )

  const { data: result } = useWorkflowRuns(projectPath, branch, {
    enabled: isAuthenticated,
    staleTime: BADGE_STALE_TIME,
  })

  const totalRuns = result?.runs?.length ?? 0
  const unreadFailedCount = useMemo(
    () =>
      countUnreadFailedWorkflowRuns(
        result?.runs ?? [],
        seenFailedWorkflowRunIds
      ),
    [result?.runs, seenFailedWorkflowRunIds]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const { setWorkflowRunsModalOpen } = useUIStore.getState()
      setWorkflowRunsModalOpen(true, projectPath, branch)
    },
    [projectPath, branch]
  )

  if (totalRuns === 0) return null

  // Red badge with unread failure count only
  if (unreadFailedCount > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            className={cn(
              'shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-500/20',
              className
            )}
          >
            <span className="flex items-center gap-0.5">
              <AlertCircle className="h-3 w-3" />
              {unreadFailedCount}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{`${unreadFailedCount} unread failed workflow run${unreadFailedCount > 1 ? 's' : ''}`}</TooltipContent>
      </Tooltip>
    )
  }

  // Subtle icon-only button when all failures have been seen (or none failed)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          aria-label="View workflow runs"
          className={cn(
            'shrink-0 rounded bg-muted-foreground/10 px-2.5 py-[4.5px] text-[11px] text-muted-foreground/50 transition-colors hover:bg-muted-foreground/20 hover:text-muted-foreground',
            className
          )}
        >
          <span className="flex  items-center">
            <Activity className="h-3 w-3" />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>View workflow runs</TooltipContent>
    </Tooltip>
  )
}
