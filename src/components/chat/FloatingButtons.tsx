import { memo, useCallback } from 'react'
import { AlertCircle, ArrowDown, Check } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'

interface FloatingButtonsProps {
  /** Whether there's a pending plan (from persisted message) */
  hasPendingPlan: boolean
  /** Whether there's a streaming plan */
  hasStreamingPlan: boolean
  /** Whether findings exist and are not visible */
  showFindingsButton: boolean
  /** Whether user is at the bottom of scroll */
  isAtBottom: boolean
  /** Keyboard shortcut for approve */
  approveShortcut: string
  /** Callback for streaming plan approval */
  onStreamingPlanApproval: () => void
  /** Callback for pending plan approval (needs message ID) */
  onPendingPlanApproval: () => void
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
  hasPendingPlan,
  hasStreamingPlan,
  showFindingsButton,
  isAtBottom,
  approveShortcut,
  onStreamingPlanApproval,
  onPendingPlanApproval,
  onScrollToFindings,
  onScrollToBottom,
}: FloatingButtonsProps) {
  // Show floating approve button when user scrolls up (same as "Go to bottom" button)
  const showApproveButton = (hasPendingPlan || hasStreamingPlan) && !isAtBottom

  const handleApprove = useCallback(() => {
    if (hasStreamingPlan) {
      onStreamingPlanApproval()
    } else {
      onPendingPlanApproval()
    }
    // Also scroll to bottom so user sees the result
    onScrollToBottom()
  }, [hasStreamingPlan, onStreamingPlanApproval, onPendingPlanApproval, onScrollToBottom])

  return (
    <div className="absolute bottom-4 right-4 z-20 flex gap-2">
      {/* Floating Approve button - shown when main approve button is not visible */}
      {showApproveButton && (
        <button
          type="button"
          onClick={handleApprove}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground shadow-md transition-all hover:bg-primary/90"
        >
          <Check className="h-3.5 w-3.5" />
          <span>Approve</span>
          <Kbd className="ml-0.5 h-4 text-[10px] bg-primary-foreground/20 text-primary-foreground">
            {approveShortcut}
          </Kbd>
        </button>
      )}
      {/* Go to findings button - shown when findings exist and are not visible */}
      {showFindingsButton && (
        <button
          type="button"
          onClick={onScrollToFindings}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-muted/90 px-3 text-sm text-muted-foreground shadow-md backdrop-blur-sm transition-all hover:bg-muted hover:text-foreground"
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
          className="flex h-8 items-center gap-1.5 rounded-lg bg-muted/90 px-3 text-sm text-muted-foreground shadow-md backdrop-blur-sm transition-all hover:bg-muted hover:text-foreground"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          <span>Bottom</span>
        </button>
      )}
    </div>
  )
})
