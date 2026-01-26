import { memo } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  useClaudeUsageLimits,
  useSessionUsage,
  useHookContextData,
  formatCost,
  formatResetTime,
  formatPacingDelta,
  getPacingDeltaColor,
  formatTokens,
} from '@/services/claude-usage'

interface ClaudeUsageStatusBarProps {
  worktreeId: string | null
  worktreePath: string | null
  sessionId: string | null
}

/**
 * Status bar showing Claude Code usage information:
 * - S: Session cost and context percentage
 * - L: 5-hour limit utilization and reset time
 * - W: 7-day limit utilization (shown only when L >= 90%)
 */
export const ClaudeUsageStatusBar = memo(function ClaudeUsageStatusBar({
  worktreeId,
  worktreePath,
  sessionId,
}: ClaudeUsageStatusBarProps) {
  const { data: limits } = useClaudeUsageLimits()
  const { data: sessionUsage } = useSessionUsage(
    worktreeId,
    worktreePath,
    sessionId
  )
  // Hook data provides accurate context % when installed
  const { data: hookData } = useHookContextData(sessionId)

  // Don't render if no session data
  if (!sessionUsage) {
    return null
  }

  // Merge data: prefer hook data for cost and context % (more accurate)
  const displayUsage = {
    ...sessionUsage,
    // Use hook data when available
    contextPercentage: hookData?.contextPercentage ?? sessionUsage.contextPercentage,
    estimatedCostUsd: hookData?.costUsd ?? sessionUsage.estimatedCostUsd,
    // Extra info from hook for tooltip
    contextTokens: hookData?.contextTokens,
    contextMaxTokens: hookData?.contextMaxTokens,
    isFromHook: !!hookData,
  }

  const fiveHour = limits?.fiveHour
  const sevenDay = limits?.sevenDay

  // Show weekly only if 5-hour limit is >= 90%
  const showWeekly = fiveHour && fiveHour.utilization >= 90

  return (
    <TooltipProvider delayDuration={300}>
      <div className="hidden @md:flex items-center text-xs text-muted-foreground select-none">
        {/* Session info: S: $cost | XX% */}
        <SessionInfo usage={displayUsage} />

        {/* 5-hour limit: L: XX% (Xh Xm) */}
        {fiveHour && (
          <>
            <Separator />
            <LimitInfo label="L" limit={fiveHour} showPacingDelta={false} />
          </>
        )}

        {/* 7-day limit: W: XX% (+X.X%) (XXh) - only when L >= 90% */}
        {showWeekly && sevenDay && (
          <>
            <Separator />
            <LimitInfo label="W" limit={sevenDay} showPacingDelta />
          </>
        )}

        {/* Trailing separator before main toolbar */}
        <Separator />
      </div>
    </TooltipProvider>
  )
})

/** Vertical separator */
function Separator() {
  return <div className="h-4 w-px bg-border/50 mx-2" />
}

interface SessionInfoProps {
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheTokens: number
    contextPercentage: number
    estimatedCostUsd: number
    // Extra info from hook (when available)
    contextTokens?: number
    contextMaxTokens?: number
    isFromHook: boolean
  }
}

/** Session cost and context percentage */
function SessionInfo({ usage }: SessionInfoProps) {
  const contextColor = getContextColor(usage.contextPercentage)

  // Format context info for tooltip
  const contextMaxK = usage.contextMaxTokens
    ? `${Math.round(usage.contextMaxTokens / 1000)}K`
    : '200K'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-muted/50 cursor-default">
          <span className="text-muted-foreground/70">S:</span>
          <span>{formatCost(usage.estimatedCostUsd)}</span>
          <span className="text-muted-foreground/50">|</span>
          <span className={contextColor}>
            {Math.round(usage.contextPercentage)}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="text-xs">
        <div className="space-y-1">
          <div className="font-medium">Session Usage</div>
          <div>
            Input: {formatTokens(usage.totalInputTokens)} tokens
          </div>
          <div>
            Output: {formatTokens(usage.totalOutputTokens)} tokens
          </div>
          {usage.totalCacheTokens > 0 && !usage.isFromHook && (
            <div>
              Cache: {formatTokens(usage.totalCacheTokens)} tokens
            </div>
          )}
          <div className="pt-1 border-t border-border/50">
            Context: {Math.round(usage.contextPercentage)}% of {contextMaxK}
            {usage.contextTokens && (
              <span className="text-muted-foreground/70">
                {' '}({formatTokens(usage.contextTokens)})
              </span>
            )}
          </div>
          <div>
            Est. cost: {formatCost(usage.estimatedCostUsd)}
          </div>
          {!usage.isFromHook && (
            <div className="pt-1 text-muted-foreground/70 text-[10px]">
              Enable context hook in settings for accurate %
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

interface LimitInfoProps {
  label: 'L' | 'W'
  limit: {
    utilization: number
    resetsAt: string | null
  }
  showPacingDelta: boolean
}

/** Limit utilization and reset time */
function LimitInfo({ label, limit, showPacingDelta }: LimitInfoProps) {
  const utilizationColor = getUtilizationColor(limit.utilization)
  const pacingDelta = showPacingDelta && limit.resetsAt
    ? formatPacingDelta(limit.utilization, limit.resetsAt)
    : null
  const pacingDeltaNum = showPacingDelta && limit.resetsAt
    ? limit.utilization - getTimeElapsedPercent(limit.resetsAt, label === 'W' ? 168 : 5)
    : 0

  const labelFull = label === 'L' ? '5-hour limit' : '7-day limit'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/50 cursor-default">
          <span className="text-muted-foreground/70">{label}:</span>
          <span className={utilizationColor}>
            {Math.round(limit.utilization)}%
          </span>
          {pacingDelta && (
            <span className={cn('text-[10px]', getPacingDeltaColor(pacingDeltaNum))}>
              ({pacingDelta})
            </span>
          )}
          {limit.resetsAt && (
            <span className="text-muted-foreground/50">
              ({formatResetTime(limit.resetsAt)})
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div className="space-y-1">
          <div className="font-medium">{labelFull}</div>
          <div>
            Utilization: {limit.utilization.toFixed(1)}%
          </div>
          {limit.resetsAt && (
            <div>
              Resets in: {formatResetTime(limit.resetsAt)}
            </div>
          )}
          {showPacingDelta && pacingDelta && (
            <div className={getPacingDeltaColor(pacingDeltaNum)}>
              Pacing: {pacingDelta} {pacingDeltaNum >= 0 ? '(ahead)' : '(behind)'}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** Get color class based on context percentage */
function getContextColor(percentage: number): string {
  if (percentage >= 90) return 'text-red-500'
  if (percentage >= 70) return 'text-yellow-500'
  return 'text-muted-foreground'
}

/** Get color class based on utilization */
function getUtilizationColor(utilization: number): string {
  if (utilization >= 90) return 'text-red-500'
  if (utilization >= 70) return 'text-yellow-500'
  if (utilization >= 50) return 'text-orange-500'
  return 'text-muted-foreground'
}

/** Calculate time elapsed percent for pacing delta */
function getTimeElapsedPercent(resetsAt: string, totalHours: number): number {
  const resetDate = new Date(resetsAt)
  const now = new Date()
  const diffMs = resetDate.getTime() - now.getTime()
  const hoursRemaining = Math.max(0, diffMs / 3600000)
  return ((totalHours - hoursRemaining) / totalHours) * 100
}
