import type { ToolCall } from '@/types/chat'
import { isAskUserQuestion, isPlanToolCall } from '@/types/chat'
import { usePreferences } from '@/services/preferences'
import { useChatStore } from '@/store/chat-store'
import { resolveApprovalLabel } from './approval-label-utils'
import { SplitButton } from '@/components/ui/split-button'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ApprovalActionMenu,
  type ApprovalModelOverride,
} from './ApprovalModelSubmenu'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'

interface ExitPlanModeButtonProps {
  toolCalls: ToolCall[] | undefined
  isApproved: boolean
  isLatestPlanRequest?: boolean
  hasFollowUpMessage?: boolean
  onPlanApproval?: () => void
  onPlanApprovalYolo?: () => void
  onClearContextApproval?: (override?: ApprovalModelOverride) => void
  onClearContextBuildApproval?: (override?: ApprovalModelOverride) => void
  onWorktreeBuildApproval?: (override?: ApprovalModelOverride) => void
  onWorktreeYoloApproval?: (override?: ApprovalModelOverride) => void
  buttonRef?: React.RefObject<HTMLButtonElement | null>
  shortcut?: string
  shortcutYolo?: string
  shortcutClearContext?: string
  shortcutClearContextBuild?: string
  sessionId?: string
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
  sessionId,
  shortcutYolo,
  hideApproveButtons,
}: ExitPlanModeButtonProps) {
  const { data: preferences } = usePreferences()
  const sessionBackend = useChatStore(state =>
    sessionId ? (state.selectedBackends[sessionId] ?? null) : null
  )
  const buildNewContextLabel = resolveApprovalLabel(
    'build',
    preferences,
    sessionBackend,
    { forceModeOverride: true }
  )
  const yoloNewContextLabel = resolveApprovalLabel(
    'yolo',
    preferences,
    sessionBackend,
    { forceModeOverride: true }
  )

  if (!toolCalls) return null

  const exitPlanTools = toolCalls.filter(isPlanToolCall)
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
  const hasYoloDropdownItems =
    !!onClearContextApproval || !!onWorktreeYoloApproval

  const approveTooltip = shortcut
    ? `Approve plan (${shortcut})`
    : 'Approve plan'
  const yoloTooltip = shortcutYolo
    ? `Approve with Full access (${shortcutYolo})`
    : 'Approve with Full access'
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {hasYoloDropdownItems ? (
        <SplitButton
          label="Full access"
          tooltip={yoloTooltip}
          onClick={() => onPlanApprovalYolo?.()}
        >
          <ApprovalActionMenu
            yoloDefaultModelLabel={yoloNewContextLabel}
            clearContextShortcut={formatShortcutDisplay(
              DEFAULT_KEYBINDINGS.approve_plan_clear_context
            )}
            worktreeYoloShortcut={formatShortcutDisplay(
              DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo
            )}
            onClearContextApprove={onClearContextApproval}
            onWorktreeYoloApprove={onWorktreeYoloApproval}
          />
        </SplitButton>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" onClick={() => onPlanApprovalYolo?.()}>
              Full access
            </Button>
          </TooltipTrigger>
          <TooltipContent>{yoloTooltip}</TooltipContent>
        </Tooltip>
      )}
      {hasApproveDropdownItems ? (
        <SplitButton
          label="Approve"
          tooltip={approveTooltip}
          variant="outline"
          onClick={() => onPlanApproval?.()}
        >
          <ApprovalActionMenu
            buildDefaultModelLabel={buildNewContextLabel}
            clearContextBuildShortcut={formatShortcutDisplay(
              DEFAULT_KEYBINDINGS.approve_plan_clear_context_build
            )}
            worktreeBuildShortcut={formatShortcutDisplay(
              DEFAULT_KEYBINDINGS.approve_plan_worktree_build
            )}
            onClearContextBuildApprove={onClearContextBuildApproval}
            onWorktreeBuildApprove={onWorktreeBuildApproval}
          />
        </SplitButton>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
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
    </div>
  )
}
