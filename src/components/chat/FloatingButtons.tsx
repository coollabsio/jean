import { memo, useCallback } from 'react'
import { AlertCircle, ArrowDown, Check, ChevronDown } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'

interface FloatingButtonsProps {
  /** Whether a plan needs approval (streaming or pending) */
  showApproveButton: boolean
  /** Whether findings exist and are not visible */
  showFindingsButton: boolean
  /** Whether user is at the bottom of scroll */
  isAtBottom: boolean
  /** Keyboard shortcut for approve */
  approveShortcut: string
  /** Callback for approve (build mode) */
  onApprove: () => void
  /** Callback for approve (yolo mode) */
  onYoloApprove: () => void
  /** Callback for clear context build approval */
  onClearContextBuildApprove?: () => void
  /** Callback for clear context yolo approval */
  onClearContextApprove?: () => void
  /** Callback for worktree build approval */
  onWorktreeBuildApprove?: () => void
  /** Callback for worktree yolo approval */
  onWorktreeYoloApprove?: () => void
  /** Callback to scroll to findings */
  onScrollToFindings: () => void
  /** Callback to scroll to bottom */
  onScrollToBottom: () => void
}

/**
 * Floating action buttons (approve, findings, scroll to bottom)
 * Memoized to prevent re-renders when parent state changes
 */
export const FloatingButtons = memo(function FloatingButtons({
  showApproveButton: showApprove,
  showFindingsButton,
  isAtBottom,
  approveShortcut,
  onApprove,
  onYoloApprove,
  onClearContextBuildApprove,
  onClearContextApprove,
  onWorktreeBuildApprove,
  onWorktreeYoloApprove,
  onScrollToFindings,
  onScrollToBottom,
}: FloatingButtonsProps) {
  const showApproveButton = showApprove && !isAtBottom

  const withScroll = useCallback(
    (fn?: () => void) => () => {
      fn?.()
      onScrollToBottom()
    },
    [onScrollToBottom]
  )

  return (
    <>
      {/* Right side - Approve, Findings, Bottom buttons */}
      <div className="absolute bottom-4 right-4 flex gap-2">
        {/* Floating Approve button with dropdown - shown when main approve button is not visible */}
        {showApproveButton && (
          <div className="inline-flex shadow-md rounded-lg">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  className="h-8 gap-1.5 rounded-r-none text-sm"
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
                  className="h-8 px-1.5 rounded-l-none border-l border-l-primary-foreground/20"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={withScroll(onYoloApprove)}>
                  YOLO
                  <DropdownMenuShortcut>
                    {formatShortcutDisplay(
                      DEFAULT_KEYBINDINGS.approve_plan_yolo
                    )}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
                {onClearContextBuildApprove && (
                  <DropdownMenuItem
                    onClick={withScroll(onClearContextBuildApprove)}
                  >
                    New Session
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(
                        DEFAULT_KEYBINDINGS.approve_plan_clear_context_build
                      )}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
                {onClearContextApprove && (
                  <DropdownMenuItem onClick={withScroll(onClearContextApprove)}>
                    New Session (YOLO)
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(
                        DEFAULT_KEYBINDINGS.approve_plan_clear_context
                      )}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
                {onWorktreeBuildApprove && (
                  <DropdownMenuItem
                    onClick={withScroll(onWorktreeBuildApprove)}
                  >
                    New Worktree
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(
                        DEFAULT_KEYBINDINGS.approve_plan_worktree_build
                      )}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
                {onWorktreeYoloApprove && (
                  <DropdownMenuItem onClick={withScroll(onWorktreeYoloApprove)}>
                    New Worktree (YOLO)
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(
                        DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo
                      )}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {/* Go to findings button - shown when findings exist and are not visible */}
        {showFindingsButton && (
          <button
            type="button"
            onClick={onScrollToFindings}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-muted/90 px-3 text-sm text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            <span>Findings</span>
          </button>
        )}
        {/* Scroll to bottom button */}
        {!isAtBottom && (
          <button
            type="button"
            onClick={onScrollToBottom}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-muted/90 px-3 text-sm text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            <span>Bottom</span>
          </button>
        )}
      </div>
    </>
  )
})
