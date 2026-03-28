import { useCallback, useEffect, useState } from 'react'
import type { SessionCardData } from '../session-card-utils'
import type { LabelData, SessionDigest } from '@/types/chat'
import type { ApprovalContext } from '../PlanDialog'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'

interface UseCanvasShortcutEventsOptions {
  /** Currently selected card (null if none selected) */
  selectedCard: SessionCardData | null
  /** Whether shortcuts are enabled (disable when modal open) */
  enabled: boolean
  /** Worktree ID for approval context */
  worktreeId: string
  /** Worktree path for approval context */
  worktreePath: string
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
  /** Plan dialog file path (if open) */
  planDialogPath: string | null
  /** Plan dialog content (if open, for inline plans) */
  planDialogContent: string | null
  /** Approval context for the open plan dialog */
  planApprovalContext: ApprovalContext | null
  /** The card associated with the open plan dialog */
  planDialogCard: SessionCardData | null
  /** Close plan dialog */
  closePlanDialog: () => void
  /** Recap dialog digest (if open) */
  recapDialogDigest: SessionDigest | null
  /** Whether the recap dialog is open (includes loading state) */
  isRecapDialogOpen: boolean
  /** Whether a recap is being generated */
  isGeneratingRecap: boolean
  /** Regenerate the recap for the currently open dialog */
  regenerateRecap: () => void
  /** Close recap dialog */
  closeRecapDialog: () => void
  /** Handle plan view button click */
  handlePlanView: (card: SessionCardData) => void
  /** Handle recap view button click */
  handleRecapView: (card: SessionCardData) => void
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
 * Listens for approve-plan, approve-plan-yolo, open-plan, open-recap events.
 */
export function useCanvasShortcutEvents({
  selectedCard,
  enabled,
  worktreeId,
  worktreePath,
  onPlanApproval,
  onPlanApprovalYolo,
  onClearContextApproval,
  onClearContextApprovalBuild,
  onWorktreeApproval,
  onWorktreeApprovalYolo,
  skipLabelHandling,
}: UseCanvasShortcutEventsOptions): UseCanvasShortcutEventsResult {
  // Plan dialog state
  const [planDialogPath, setPlanDialogPath] = useState<string | null>(null)
  const [planDialogContent, setPlanDialogContent] = useState<string | null>(
    null
  )
  const [planApprovalContext, setPlanApprovalContext] =
    useState<ApprovalContext | null>(null)
  const [planDialogCard, setPlanDialogCard] = useState<SessionCardData | null>(
    null
  )

  // Label modal state
  const [labelModalSessionId, setLabelModalSessionId] = useState<string | null>(
    null
  )
  const [labelModalCurrentLabel, setLabelModalCurrentLabel] =
    useState<LabelData | null>(null)

  // Recap dialog state
  const [recapDialogDigest, setRecapDialogDigest] =
    useState<SessionDigest | null>(null)
  const [recapDialogSessionId, setRecapDialogSessionId] = useState<
    string | null
  >(null)
  const [isGeneratingRecap, setIsGeneratingRecap] = useState(false)
  const [recapDialogMessageCount, setRecapDialogMessageCount] = useState<
    number | null
  >(null)

  // Handle plan view
  const handlePlanView = useCallback(
    (card: SessionCardData) => {
      if (card.planFilePath) {
        setPlanDialogPath(card.planFilePath)
        setPlanDialogContent(null)
      } else if (card.planContent) {
        setPlanDialogContent(card.planContent)
        setPlanDialogPath(null)
      }

      // Set approval context for the dialog
      setPlanApprovalContext({
        worktreeId,
        worktreePath,
        sessionId: card.session.id,
        pendingPlanMessageId: card.pendingPlanMessageId,
      })
      setPlanDialogCard(card)
    },
    [worktreeId, worktreePath]
  )

  // Handle recap view — show existing digest or generate on-demand
  const handleRecapView = useCallback(async (card: SessionCardData) => {
    const sessionId = card.session.id
    const currentMessageCount =
      card.session.message_count ?? card.session.messages.length

    if (card.recapDigest) {
      setRecapDialogDigest(card.recapDigest)
      setRecapDialogSessionId(sessionId)
      setRecapDialogMessageCount(currentMessageCount)
      return
    }

    // Need at least 2 messages to generate a recap
    if (currentMessageCount < 2) {
      toast.info('Not enough messages to generate a recap')
      return
    }

    // Open dialog in loading state and generate on-demand
    setRecapDialogSessionId(sessionId)
    setRecapDialogDigest(null)
    setRecapDialogMessageCount(currentMessageCount)
    setIsGeneratingRecap(true)

    try {
      const digest = await invoke<SessionDigest>('generate_session_digest', {
        sessionId,
      })

      useChatStore.getState().markSessionNeedsDigest(sessionId)
      useChatStore.getState().setSessionDigest(sessionId, digest)

      // Persist to disk (fire and forget)
      invoke('update_session_digest', { sessionId, digest }).catch(err => {
        console.error(
          '[useCanvasShortcutEvents] Failed to persist digest:',
          err
        )
      })

      setRecapDialogDigest(digest)
    } catch (error) {
      setRecapDialogDigest(null)
      setRecapDialogSessionId(null)
      toast.error(`Failed to generate recap: ${error}`)
    } finally {
      setIsGeneratingRecap(false)
    }
  }, [])

  // Close handlers
  const closePlanDialog = useCallback(() => {
    setPlanDialogPath(null)
    setPlanDialogContent(null)
    setPlanApprovalContext(null)
    setPlanDialogCard(null)
  }, [])

  const closeLabelModal = useCallback(() => {
    setLabelModalSessionId(null)
    setLabelModalCurrentLabel(null)
  }, [])

  const handleOpenLabelModal = useCallback((card: SessionCardData) => {
    setLabelModalSessionId(card.session.id)
    setLabelModalCurrentLabel(card.label)
  }, [])

  // Regenerate recap for the currently open session
  const regenerateRecap = useCallback(async () => {
    const sessionId = recapDialogSessionId
    if (!sessionId || isGeneratingRecap) return

    // Check if there's new context since last generation
    if (
      recapDialogDigest?.message_count != null &&
      recapDialogMessageCount != null &&
      recapDialogDigest.message_count >= recapDialogMessageCount
    ) {
      toast.info('No new messages since last recap')
      return
    }

    setRecapDialogDigest(null)
    setIsGeneratingRecap(true)

    try {
      const digest = await invoke<SessionDigest>('generate_session_digest', {
        sessionId,
      })

      useChatStore.getState().markSessionNeedsDigest(sessionId)
      useChatStore.getState().setSessionDigest(sessionId, digest)

      invoke('update_session_digest', { sessionId, digest }).catch(err => {
        console.error(
          '[useCanvasShortcutEvents] Failed to persist digest:',
          err
        )
      })

      setRecapDialogDigest(digest)
    } catch (error) {
      toast.error(`Failed to generate recap: ${error}`)
    } finally {
      setIsGeneratingRecap(false)
    }
  }, [
    recapDialogSessionId,
    isGeneratingRecap,
    recapDialogDigest,
    recapDialogMessageCount,
  ])

  const closeRecapDialog = useCallback(() => {
    setRecapDialogDigest(null)
    setRecapDialogSessionId(null)
    setIsGeneratingRecap(false)
    setRecapDialogMessageCount(null)
  }, [])

  // Listen for open-recap event while dialog is open to regenerate
  // (The global keybinding handler intercepts R key and dispatches open-recap,
  // but the main event listener below is disabled when dialog is open)
  useEffect(() => {
    if (!recapDialogSessionId) return

    const handleRegenerateViaEvent = () => {
      regenerateRecap()
    }

    window.addEventListener('open-recap', handleRegenerateViaEvent)
    return () =>
      window.removeEventListener('open-recap', handleRegenerateViaEvent)
  }, [recapDialogSessionId, regenerateRecap])

  // Close recap dialog when the associated session starts sending
  useEffect(() => {
    if (!recapDialogSessionId) return

    let wasSending =
      useChatStore.getState().sendingSessionIds[recapDialogSessionId] ?? false
    const unsubscribe = useChatStore.subscribe(state => {
      const isSending = state.sendingSessionIds[recapDialogSessionId] ?? false
      if (isSending && !wasSending) {
        setRecapDialogDigest(null)
        setRecapDialogSessionId(null)
      }
      wasSending = isSending
    })

    return unsubscribe
  }, [recapDialogSessionId])

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

    const handleOpenPlanEvent = () => {
      if (selectedCard.planFilePath || selectedCard.planContent) {
        handlePlanView(selectedCard)
      } else {
        toast.info('No plan available for this session')
      }
    }

    const handleOpenRecapEvent = () => {
      handleRecapView(selectedCard)
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
    window.addEventListener('open-plan', handleOpenPlanEvent)
    window.addEventListener('open-recap', handleOpenRecapEvent)
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
      window.removeEventListener('open-plan', handleOpenPlanEvent)
      window.removeEventListener('open-recap', handleOpenRecapEvent)
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
    handlePlanView,
    handleRecapView,
    skipLabelHandling,
  ])

  return {
    planDialogPath,
    planDialogContent,
    planApprovalContext,
    planDialogCard,
    closePlanDialog,
    recapDialogDigest,
    isRecapDialogOpen: !!recapDialogSessionId,
    isGeneratingRecap,
    regenerateRecap,
    closeRecapDialog,
    handlePlanView,
    handleRecapView,
    isLabelModalOpen: !!labelModalSessionId,
    labelModalSessionId,
    labelModalCurrentLabel,
    closeLabelModal,
    handleOpenLabelModal,
  }
}
