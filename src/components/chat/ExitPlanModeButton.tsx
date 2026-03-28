import type { ToolCall } from '@/types/chat'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { usePreferences } from '@/services/preferences'
import { resolveApprovalLabel } from './approval-label-utils'
import { SplitButton } from '@/components/ui/split-button'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'

interface ExitPlanModeButtonProps {
  toolCalls: ToolCall[] | undefined
  isApproved: boolean
  isLatestPlanRequest?: boolean
  hasFollowUpMessage?: boolean
  onPlanApproval?: () => void
  onPlanApprovalYolo?: () => void
  onClearContextApproval?: () => void
  onClearContextBuildApproval?: () => void
  onWorktreeBuildApproval?: () => void
  onWorktreeYoloApproval?: () => void
  buttonRef?: React.RefObject<HTMLButtonElement | null>
  shortcut?: string
  shortcutYolo?: string
  shortcutClearContext?: string
  shortcutClearContextBuild?: string
  hideApproveButtons?: boolean
}

export function ExitPlanModeButton({
  toolCalls,
  isApproved,
  isLatestPlanRequest = true,
  hasFollowUpMessage = false,
  onPlanApproval,
  onPlanApprovalYolo,
  onClearContextApproval,
  onClearContextBuildApproval,
  onWorktreeBuildApproval,
  onWorktreeYoloApproval,
  buttonRef,
  shortcut,
  shortcutYolo,
  hideApproveButtons,
}: ExitPlanModeButtonProps) {
  const { data: preferences } = usePreferences()
  const buildLabel = resolveApprovalLabel('build', preferences)
  const yoloLabel = resolveApprovalLabel('yolo', preferences)

  if (!toolCalls) return null

  const exitPlanTools = toolCalls.filter(isExitPlanMode)
  const tool = exitPlanTools[exitPlanTools.length - 1]
  if (!tool) return null

  const hasQuestions = toolCalls.some(isAskUserQuestion)
  if (hasQuestions && !isApproved) return null

  if (
    isApproved ||
    !isLatestPlanRequest ||
    hasFollowUpMessage ||
    hideApproveButtons
  )
    return null

  const hasApproveDropdownItems =
    !!onClearContextBuildApproval || !!onWorktreeBuildApproval
  const hasAutoDropdownItems =
    !!onClearContextApproval || !!onWorktreeYoloApproval

  const approveTooltip = shortcut
    ? `Approve plan (${shortcut})`
    : 'Approve plan'
  const yoloTooltip = shortcutYolo
    ? `Approve with yolo mode (${shortcutYolo})`
    : 'Approve with yolo mode'

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {/* Approve button - split if dropdown items exist */}
      {hasApproveDropdownItems ? (
        <SplitButton
          label="Approve"
          tooltip={approveTooltip}
          onClick={() => onPlanApproval?.()}
        >
          <DropdownMenuItem onClick={() => onClearContextBuildApproval?.()}>
            <span className="flex flex-col">
              <span>New Session</span>
              {buildLabel && (
                <span className="text-[10px] text-muted-foreground">
                  {buildLabel}
                </span>
              )}
            </span>
            <DropdownMenuShortcut>
              {formatShortcutDisplay(
                DEFAULT_KEYBINDINGS.approve_plan_clear_context_build
              )}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          {onWorktreeBuildApproval && (
            <DropdownMenuItem onClick={() => onWorktreeBuildApproval()}>
              <span className="flex flex-col">
                <span>New Worktree</span>
                {buildLabel && (
                  <span className="text-[10px] text-muted-foreground">
                    {buildLabel}
                  </span>
                )}
              </span>
              <DropdownMenuShortcut>
                {formatShortcutDisplay(
                  DEFAULT_KEYBINDINGS.approve_plan_worktree_build
                )}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
        </SplitButton>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={buttonRef}
              size="sm"
              onClick={() => onPlanApproval?.()}
            >
              Approve
            </Button>
          </TooltipTrigger>
          <TooltipContent>{approveTooltip}</TooltipContent>
        </Tooltip>
      )}

      {/* Auto button - split if dropdown items exist */}
      {hasAutoDropdownItems ? (
        <SplitButton
          label="YOLO"
          tooltip={yoloTooltip}
          variant="outline"
          onClick={() => onPlanApprovalYolo?.()}
        >
          <DropdownMenuItem onClick={() => onClearContextApproval?.()}>
            <span className="flex flex-col">
              <span>New Session (YOLO)</span>
              {yoloLabel && (
                <span className="text-[10px] text-muted-foreground">
                  {yoloLabel}
                </span>
              )}
            </span>
            <DropdownMenuShortcut>
              {formatShortcutDisplay(
                DEFAULT_KEYBINDINGS.approve_plan_clear_context
              )}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          {onWorktreeYoloApproval && (
            <DropdownMenuItem onClick={() => onWorktreeYoloApproval()}>
              <span className="flex flex-col">
                <span>New Worktree (YOLO)</span>
                {yoloLabel && (
                  <span className="text-[10px] text-muted-foreground">
                    {yoloLabel}
                  </span>
                )}
              </span>
              <DropdownMenuShortcut>
                {formatShortcutDisplay(
                  DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo
                )}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
        </SplitButton>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPlanApprovalYolo?.()}
            >
              YOLO
            </Button>
          </TooltipTrigger>
          <TooltipContent>{yoloTooltip}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
