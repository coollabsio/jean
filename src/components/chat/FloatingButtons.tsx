import { memo, useCallback } from 'react'
import { AlertCircle, Check, ChevronDown } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import {
  ApprovalActionMenu,
  type ApprovalModelOverride,
} from './ApprovalModelSubmenu'

interface FloatingButtonsProps {
  /** Whether a plan needs approval (streaming or pending) */
  showApproveButton: boolean
  /** Whether findings exist and are not visible */
  showFindingsButton: boolean
  /** Whether user is at the bottom of scroll */
  isAtBottom: boolean
  /** Keyboard shortcut for approve */
  approveShortcut: string
  /** Callback for approve (selected permissions) */
  onApprove: () => void
  /** Callback for approve (Full access) */
  onYoloApprove: () => void
  /** Label for the build default backend/model */
  buildDefaultModelLabel?: string | null
  /** Label for the yolo default backend/model */
  yoloDefaultModelLabel?: string | null
  /** Callback for clear context build approval */
  onClearContextBuildApprove?: (override?: ApprovalModelOverride) => void
  /** Callback for clear context yolo approval */
  onClearContextApprove?: (override?: ApprovalModelOverride) => void
  /** Callback for worktree build approval */
  onWorktreeBuildApprove?: (override?: ApprovalModelOverride) => void
  /** Callback for worktree yolo approval */
  onWorktreeYoloApprove?: (override?: ApprovalModelOverride) => void
  /** Callback to scroll to findings */
  onScrollToFindings: () => void
  /** Callback to scroll to bottom after an approval */
  onScrollToBottom: () => void
}

/**
 * Composer tab buttons (approve, findings)
 * Memoized to prevent re-renders when parent state changes
 */
export const FloatingButtons = memo(function FloatingButtons({
  showApproveButton: showApprove,
  showFindingsButton,
  isAtBottom,
  approveShortcut,
  onApprove,
  onYoloApprove,
  buildDefaultModelLabel,
  yoloDefaultModelLabel,
  onClearContextBuildApprove,
  onClearContextApprove,
  onWorktreeBuildApprove,
  onWorktreeYoloApprove,
  onScrollToFindings,
  onScrollToBottom,
}: FloatingButtonsProps) {
  const showApproveButton = showApprove && !isAtBottom

  const withScroll = useCallback(
    (
      fn?: (override?: ApprovalModelOverride) => void,
      override?: ApprovalModelOverride
    ) =>
      () => {
        fn?.(override)
        onScrollToBottom()
      },
    [onScrollToBottom]
  )

  return (
    <>
      {/* Approve, Findings tabs - rendered inside the composer tab row */}
      {/* Floating approval buttons with dropdowns - shown when main approve buttons are not visible */}
      {showApproveButton && (
        <div className="flex items-end gap-1">
          <div className="inline-flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  className="h-6 gap-1 rounded-none rounded-tl-md bg-primary px-2 text-xs hover:bg-primary hover:brightness-110"
                  onClick={withScroll(onYoloApprove)}
                >
                  Full access
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Approve with Full access (
                {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_yolo)})
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="h-6 rounded-none rounded-tr-md border-l border-l-primary-foreground/20 bg-primary px-1.5 hover:bg-primary hover:brightness-110"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ApprovalActionMenu
                  yoloDefaultModelLabel={yoloDefaultModelLabel}
                  clearContextShortcut={formatShortcutDisplay(
                    DEFAULT_KEYBINDINGS.approve_plan_clear_context
                  )}
                  worktreeYoloShortcut={formatShortcutDisplay(
                    DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo
                  )}
                  onClearContextApprove={
                    onClearContextApprove
                      ? (override?: ApprovalModelOverride) => {
                          onClearContextApprove(override)
                          onScrollToBottom()
                        }
                      : undefined
                  }
                  onWorktreeYoloApprove={
                    onWorktreeYoloApprove
                      ? (override?: ApprovalModelOverride) => {
                          onWorktreeYoloApprove(override)
                          onScrollToBottom()
                        }
                      : undefined
                  }
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="inline-flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 rounded-none rounded-tl-md border-b-0 bg-card px-2 text-xs hover:bg-muted dark:bg-card dark:hover:bg-muted"
                  onClick={withScroll(onApprove)}
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </Button>
              </TooltipTrigger>
              <TooltipContent>Approve plan ({approveShortcut})</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 rounded-none rounded-tr-md border-b-0 border-l-0 bg-card px-1.5 hover:bg-muted dark:bg-card dark:hover:bg-muted"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ApprovalActionMenu
                  buildDefaultModelLabel={buildDefaultModelLabel}
                  clearContextBuildShortcut={formatShortcutDisplay(
                    DEFAULT_KEYBINDINGS.approve_plan_clear_context_build
                  )}
                  worktreeBuildShortcut={formatShortcutDisplay(
                    DEFAULT_KEYBINDINGS.approve_plan_worktree_build
                  )}
                  onClearContextBuildApprove={
                    onClearContextBuildApprove
                      ? (override?: ApprovalModelOverride) => {
                          onClearContextBuildApprove(override)
                          onScrollToBottom()
                        }
                      : undefined
                  }
                  onWorktreeBuildApprove={
                    onWorktreeBuildApprove
                      ? (override?: ApprovalModelOverride) => {
                          onWorktreeBuildApprove(override)
                          onScrollToBottom()
                        }
                      : undefined
                  }
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
      {/* Go to findings button - shown when findings exist and are not visible */}
      {showFindingsButton && (
        <button
          type="button"
          onClick={onScrollToFindings}
          className="flex h-6 items-center gap-1 rounded-t-md border border-b-0 border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <AlertCircle className="h-3.5 w-3.5" />
          <span>Findings</span>
        </button>
      )}
    </>
  )
})
