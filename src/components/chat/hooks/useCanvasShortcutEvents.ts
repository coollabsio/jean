import { useCallback, useEffect, useState } from 'react'
import type { SessionCardData } from '../session-card-utils'
import type { LabelData } from '@/types/chat'
import { useUIStore } from '@/store/ui-store'

interface UseCanvasShortcutEventsOptions {
  /** Currently selected card (null if none selected) */
  selectedCard: SessionCardData | null
  /** Whether shortcuts are enabled (disable when modal open) */
  enabled: boolean
  /** Callback for plan approval */
  onPlanApproval: (card: SessionCardData, updatedPlan?: string) => void
  /** Callback for YOLO plan approval */
  onPlanApprovalYolo: (card: SessionCardData, updatedPlan?: string) => void
  /** Callback for clear context approval (new session with plan in yolo mode) */
  onClearContextApproval: (card: SessionCardData, updatedPlan?: string) => void
  /** Callback for clear context approval (new session with plan in build mode) */
  onClearContextApprovalBuild: (
    card: SessionCardData,
    updatedPlan?: string
  ) => void
  /** Callback for worktree approval (new worktree with plan in build mode) */
  onWorktreeApproval?:
    | ((card: SessionCardData, updatedPlan?: string) => void)
    | null
  /** Callback for worktree approval (new worktree with plan in yolo mode) */
  onWorktreeApprovalYolo?:
    | ((card: SessionCardData, updatedPlan?: string) => void)
    | null
  /** If true, skip handling toggle-session-label event (caller handles it) */
  skipLabelHandling?: boolean
}

interface UseCanvasShortcutEventsResult {
  /** Whether the label modal is open */
  isLabelModalOpen: boolean
  /** Session ID for the label modal */
  labelModalSessionId: string | null
  /** Current label for the label modal session */
  labelModalCurrentLabel: LabelData | null
  /** Close label modal */
  closeLabelModal: () => void
  /** Open label modal for a card */
  handleOpenLabelModal: (card: SessionCardData) => void
}

/**
 * Shared hook for canvas shortcut event handling.
 * Listens for plan approval events.
 */
export function useCanvasShortcutEvents({
  selectedCard,
  enabled,
  onPlanApproval,
  onPlanApprovalYolo,
  onClearContextApproval,
  onClearContextApprovalBuild,
  onWorktreeApproval,
  onWorktreeApprovalYolo,
  skipLabelHandling,
}: UseCanvasShortcutEventsOptions): UseCanvasShortcutEventsResult {
  // Label modal state
  const [labelModalSessionId, setLabelModalSessionId] = useState<string | null>(
    null
  )
  const [labelModalCurrentLabel, setLabelModalCurrentLabel] =
    useState<LabelData | null>(null)

  const closeLabelModal = useCallback(() => {
    setLabelModalSessionId(null)
    setLabelModalCurrentLabel(null)
  }, [])

  const handleOpenLabelModal = useCallback((card: SessionCardData) => {
    setLabelModalSessionId(card.session.id)
    setLabelModalCurrentLabel(card.label)
  }, [])

  // Listen for keyboard shortcut events
  useEffect(() => {
    if (!enabled || !selectedCard) return

    const handleApprovePlanEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onPlanApproval(selectedCard)
      }
    }

    const handleApprovePlanYoloEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onPlanApprovalYolo(selectedCard)
      }
    }

    const handleClearContextApproveEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onClearContextApproval(selectedCard)
      }
    }

    const handleClearContextApproveBuildEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending
      ) {
        onClearContextApprovalBuild(selectedCard)
      }
    }

    const handleWorktreeApproveEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending &&
        onWorktreeApproval
      ) {
        onWorktreeApproval(selectedCard)
      }
    }

    const handleWorktreeApproveYoloEvent = () => {
      if (useUIStore.getState().sessionChatModalOpen) return
      if (
        selectedCard.hasExitPlanMode &&
        !selectedCard.hasQuestion &&
        !selectedCard.isSending &&
        onWorktreeApprovalYolo
      ) {
        onWorktreeApprovalYolo(selectedCard)
      }
    }

    const handleToggleLabelEvent = () => {
      setLabelModalSessionId(selectedCard.session.id)
      setLabelModalCurrentLabel(selectedCard.label)
    }

    window.addEventListener('approve-plan', handleApprovePlanEvent)
    window.addEventListener('approve-plan-yolo', handleApprovePlanYoloEvent)
    window.addEventListener(
      'approve-plan-clear-context',
      handleClearContextApproveEvent
    )
    window.addEventListener(
      'approve-plan-clear-context-build',
      handleClearContextApproveBuildEvent
    )
    window.addEventListener(
      'approve-plan-worktree-build',
      handleWorktreeApproveEvent
    )
    window.addEventListener(
      'approve-plan-worktree-yolo',
      handleWorktreeApproveYoloEvent
    )
    if (!skipLabelHandling) {
      window.addEventListener('toggle-session-label', handleToggleLabelEvent)
    }

    return () => {
      window.removeEventListener('approve-plan', handleApprovePlanEvent)
      window.removeEventListener(
        'approve-plan-yolo',
        handleApprovePlanYoloEvent
      )
      window.removeEventListener(
        'approve-plan-clear-context',
        handleClearContextApproveEvent
      )
      window.removeEventListener(
        'approve-plan-clear-context-build',
        handleClearContextApproveBuildEvent
      )
      window.removeEventListener(
        'approve-plan-worktree-build',
        handleWorktreeApproveEvent
      )
      window.removeEventListener(
        'approve-plan-worktree-yolo',
        handleWorktreeApproveYoloEvent
      )
      if (!skipLabelHandling) {
        window.removeEventListener(
          'toggle-session-label',
          handleToggleLabelEvent
        )
      }
    }
  }, [
    enabled,
    selectedCard,
    onPlanApproval,
    onPlanApprovalYolo,
    onClearContextApproval,
    onClearContextApprovalBuild,
    onWorktreeApproval,
    onWorktreeApprovalYolo,
    skipLabelHandling,
  ])

  return {
    isLabelModalOpen: !!labelModalSessionId,
    labelModalSessionId,
    labelModalCurrentLabel,
    closeLabelModal,
    handleOpenLabelModal,
  }
}
