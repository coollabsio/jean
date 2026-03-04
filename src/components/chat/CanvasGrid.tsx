import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { SessionCard } from './SessionCard'
import { LabelModal } from './LabelModal'
import { SessionChatModal } from './SessionChatModal'
import { PlanDialog } from './PlanDialog'
import { RecapDialog } from './RecapDialog'
import { CloseWorktreeDialog } from './CloseWorktreeDialog'
import { usePreferences } from '@/services/preferences'
import { useRenameSession } from '@/services/chat'
import { useCanvasKeyboardNav } from './hooks/useCanvasKeyboardNav'
import { useCanvasShortcutEvents } from './hooks/useCanvasShortcutEvents'
import { type SessionCardData, groupCardsByStatus } from './session-card-utils'
import {
  copyTextToClipboard,
  formatSessionToMarkdown,
  generateExportFileName,
  getSessionForExport,
  writeSessionExportFile,
} from '@/lib/session-export-utils'

interface CanvasGridProps {
  cards: SessionCardData[]
  worktreeId: string
  worktreePath: string
  selectedIndex: number | null
  onSelectedIndexChange: (index: number | null) => void
  selectedSessionId: string | null
  onSelectedSessionIdChange: (id: string | null) => void
  onArchiveSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onPlanApproval: (card: SessionCardData, updatedPlan?: string) => void
  onPlanApprovalYolo: (card: SessionCardData, updatedPlan?: string) => void
  onClearContextApproval: (card: SessionCardData, updatedPlan?: string) => void
  onClearContextApprovalBuild: (card: SessionCardData, updatedPlan?: string) => void
  onCloseWorktree: () => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * Shared canvas grid component with keyboard navigation and dialogs.
 * Used by WorktreeCanvasView for worktree-level session display.
 */
export function CanvasGrid({
  cards,
  worktreeId,
  worktreePath,
  selectedIndex,
  onSelectedIndexChange,
  selectedSessionId,
  onSelectedSessionIdChange,
  onArchiveSession,
  onDeleteSession,
  onPlanApproval,
  onPlanApprovalYolo,
  onClearContextApproval,
  onClearContextApprovalBuild,
  onCloseWorktree,
  searchInputRef,
}: CanvasGridProps) {
  // Track session modal open state for magic command keybindings
  useEffect(() => {
    useUIStore
      .getState()
      .setSessionChatModalOpen(
        !!selectedSessionId,
        selectedSessionId ? worktreeId : null
      )
  }, [selectedSessionId, worktreeId])

  // Track canvas selected session for magic menu
  const setCanvasSelectedSession =
    useChatStore.getState().setCanvasSelectedSession

  // Use ref for cards to avoid stale closures in keyboard nav callbacks
  const cardsRef = useRef(cards)
  cardsRef.current = cards

  // Handle clicking on a session card - open modal
  const handleSessionClick = useCallback(
    (sessionId: string) => {
      onSelectedSessionIdChange(sessionId)
      setCanvasSelectedSession(worktreeId, sessionId)
    },
    [worktreeId, onSelectedSessionIdChange, setCanvasSelectedSession]
  )

  // Handle selection from keyboard nav
  const handleSelect = useCallback(
    (index: number) => {
      const card = cardsRef.current[index]
      if (card) {
        handleSessionClick(card.session.id)
      }
    },
    [handleSessionClick]
  )

  // Handle selection change for tracking in store
  const handleSelectionChange = useCallback(
    (index: number) => {
      const card = cardsRef.current[index]
      if (card) {
        setCanvasSelectedSession(worktreeId, card.session.id)
        // Sync projects store so CMD+O uses the correct worktree
        useProjectsStore.getState().selectWorktree(worktreeId)
        // Register worktree path so OpenInModal can find it
        useChatStore.getState().registerWorktreePath(worktreeId, worktreePath)
      }
    },
    [worktreeId, worktreePath, setCanvasSelectedSession]
  )

  // Get selected card for shortcut events
  const selectedCard =
    selectedIndex !== null ? (cards[selectedIndex] ?? null) : null

  // Shortcut events (plan, recap, approve) - must be before keyboard nav to get dialog states
  const {
    planDialogPath,
    planDialogContent,
    planApprovalContext,
    planDialogCard,
    closePlanDialog,
    recapDialogDigest,
    isRecapDialogOpen,
    isGeneratingRecap,
    regenerateRecap,
    closeRecapDialog,
    handlePlanView,
    handleRecapView,
    isLabelModalOpen,
    labelModalSessionId,
    labelModalCurrentLabel,
    closeLabelModal,
    handleOpenLabelModal,
  } = useCanvasShortcutEvents({
    selectedCard,
    enabled: !selectedSessionId && selectedIndex !== null,
    worktreeId,
    worktreePath,
    onPlanApproval,
    onPlanApprovalYolo,
    onClearContextApproval,
    onClearContextApprovalBuild,
  })

  // Keyboard navigation - disable when any modal/dialog is open
  const isModalOpen =
    !!selectedSessionId ||
    !!planDialogPath ||
    !!planDialogContent ||
    isRecapDialogOpen ||
    isLabelModalOpen
  const { cardRefs } = useCanvasKeyboardNav({
    cards,
    selectedIndex,
    onSelectedIndexChange,
    onSelect: handleSelect,
    enabled: !isModalOpen,
    onSelectionChange: handleSelectionChange,
  })

  // Handle approve from dialog (with updated plan content)
  const handleDialogApprove = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        onPlanApproval(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, onPlanApproval]
  )

  const handleDialogApproveYolo = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        onPlanApprovalYolo(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, onPlanApprovalYolo]
  )

  const handleDialogClearContextApprove = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        onClearContextApproval(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, onClearContextApproval]
  )

  const handleDialogClearContextApproveBuild = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        onClearContextApprovalBuild(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, onClearContextApprovalBuild]
  )

  // Listen for focus-canvas-search event
  useEffect(() => {
    const handleFocusSearch = () => searchInputRef?.current?.focus()
    window.addEventListener('focus-canvas-search', handleFocusSearch)
    return () =>
      window.removeEventListener('focus-canvas-search', handleFocusSearch)
  }, [searchInputRef])

  // Listen for close-session-or-worktree event to handle CMD+W
  const { data: preferences } = usePreferences()
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const pendingDeleteSessionId = useRef<string | null>(null)

  const executeCloseAction = useCallback(() => {
    if (pendingDeleteSessionId.current) {
      onDeleteSession(pendingDeleteSessionId.current)
      pendingDeleteSessionId.current = null
    }
    setCloseConfirmOpen(false)
  }, [onDeleteSession])

  useEffect(() => {
    const handleCloseSessionOrWorktree = (e: Event) => {
      // If modal is open, SessionChatModal intercepts CMD+W and closes itself — skip here
      if (selectedSessionId) return

      e.stopImmediatePropagation()

      // Close the selected session card, or the worktree if no card selected
      if (selectedIndex !== null && cards[selectedIndex]) {
        const activeCards = cards.filter(c => !c.session.archived_at)
        // Last session: route to worktree close (always confirms)
        if (activeCards.length <= 1) {
          onCloseWorktree()
          return
        }
        const card = cards[selectedIndex]
        const sessionId = card.session.id
        const sessionIsEmpty = !card.session.message_count
        if (preferences?.confirm_session_close !== false && !sessionIsEmpty) {
          pendingDeleteSessionId.current = sessionId
          setCloseConfirmOpen(true)
        } else {
          onDeleteSession(sessionId)
        }
      } else {
        onCloseWorktree()
      }
    }

    window.addEventListener(
      'close-session-or-worktree',
      handleCloseSessionOrWorktree,
      {
        capture: true,
      }
    )
    return () =>
      window.removeEventListener(
        'close-session-or-worktree',
        handleCloseSessionOrWorktree,
        { capture: true }
      )
  }, [
    selectedSessionId,
    selectedIndex,
    cards,
    onDeleteSession,
    onCloseWorktree,
    preferences?.confirm_session_close,
  ])

  const groups = useMemo(() => groupCardsByStatus(cards), [cards])

  // Rename session state
  const renameSession = useRenameSession()
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const handleStartRename = useCallback(
    (sessionId: string, currentName: string) => {
      setRenameValue(currentName)
      setRenamingSessionId(sessionId)
    },
    []
  )

  const handleRenameSubmit = useCallback(
    (sessionId: string) => {
      const newName = renameValue.trim()
      if (newName && newName !== cards.find(c => c.session.id === sessionId)?.session.name) {
        renameSession.mutate({ worktreeId, worktreePath, sessionId, newName })
      }
      setRenamingSessionId(null)
    },
    [renameValue, worktreeId, worktreePath, renameSession, cards]
  )

  const handleRenameCancel = useCallback(() => {
    setRenamingSessionId(null)
  }, [])

  const handleExportClipboard = useCallback(
    async (sessionId: string) => {
      if (!worktreeId || !worktreePath) return
      const session = await getSessionForExport(
        worktreeId,
        worktreePath,
        sessionId
      )
      const markdown = formatSessionToMarkdown(session)
      await copyTextToClipboard(markdown)
      toast.success('Copied to clipboard')
    },
    [worktreeId, worktreePath]
  )

  const handleExportFile = useCallback(
    async (sessionId: string, sessionName: string) => {
      if (!worktreeId || !worktreePath) return
      const session = await getSessionForExport(
        worktreeId,
        worktreePath,
        sessionId
      )
      const markdown = formatSessionToMarkdown(session)
      const fileName = generateExportFileName(sessionName)
      const relativePath = await writeSessionExportFile(
        worktreePath,
        fileName,
        markdown
      )
      toast.success(`Saved to ${relativePath}`)
    },
    [worktreeId, worktreePath]
  )

  // Track cumulative index offset per group for correct keyboard nav indices
  let indexOffset = 0

  return (
    <>
      <div className="flex flex-col gap-4">
        {groups.map(group => {
          const groupStartIndex = indexOffset
          indexOffset += group.cards.length
          return (
            <div key={group.key}>
              <div className="mb-2 flex items-baseline gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  {group.cards.length}
                </span>
              </div>
              <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
                {group.cards.map((card, i) => {
                  const globalIndex = groupStartIndex + i
                  return (
                    <SessionCard
                      key={card.session.id}
                      ref={el => {
                        cardRefs.current[globalIndex] = el
                      }}
                      card={card}
                      isSelected={selectedIndex === globalIndex}
                      onSelect={() => {
                        onSelectedIndexChange(globalIndex)
                        handleSessionClick(card.session.id)
                      }}
                      onArchive={() => onArchiveSession(card.session.id)}
                      onDelete={() => onDeleteSession(card.session.id)}
                      onPlanView={() => handlePlanView(card)}
                      onRecapView={() => handleRecapView(card)}
                      onApprove={() => onPlanApproval(card)}
                      onYolo={() => onPlanApprovalYolo(card)}
                      onClearContextApprove={() => onClearContextApproval(card)}
                      onClearContextBuildApprove={() => onClearContextApprovalBuild(card)}
                      onToggleLabel={() => handleOpenLabelModal(card)}
                      onToggleReview={() => {
                        const { reviewingSessions, setSessionReviewing } =
                          useChatStore.getState()
                        const isReviewing =
                          reviewingSessions[card.session.id] ||
                          !!card.session.review_results
                        setSessionReviewing(card.session.id, !isReviewing)
                      }}
                      isRenaming={renamingSessionId === card.session.id}
                      renameValue={renameValue}
                      onRenameValueChange={setRenameValue}
                      onRenameStart={handleStartRename}
                      onRenameSubmit={handleRenameSubmit}
                      onRenameCancel={handleRenameCancel}
                      onExportClipboard={() =>
                        handleExportClipboard(card.session.id)
                      }
                      onExportFile={() =>
                        handleExportFile(card.session.id, card.session.name)
                      }
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Plan Dialog */}
      {planDialogPath ? (
        <PlanDialog
          filePath={planDialogPath}
          isOpen={true}
          onClose={closePlanDialog}
          editable={true}
          disabled={planDialogCard?.isSending}
          approvalContext={planApprovalContext ?? undefined}
          onApprove={handleDialogApprove}
          onApproveYolo={handleDialogApproveYolo}
          onClearContextApprove={handleDialogClearContextApprove}
          onClearContextBuildApprove={handleDialogClearContextApproveBuild}
        />
      ) : planDialogContent ? (
        <PlanDialog
          content={planDialogContent}
          isOpen={true}
          onClose={closePlanDialog}
          editable={true}
          disabled={planDialogCard?.isSending}
          approvalContext={planApprovalContext ?? undefined}
          onApprove={handleDialogApprove}
          onApproveYolo={handleDialogApproveYolo}
          onClearContextApprove={handleDialogClearContextApprove}
          onClearContextBuildApprove={handleDialogClearContextApproveBuild}
        />
      ) : null}

      {/* Recap Dialog */}
      <RecapDialog
        digest={recapDialogDigest}
        isOpen={isRecapDialogOpen}
        onClose={closeRecapDialog}
        isGenerating={isGeneratingRecap}
        onRegenerate={regenerateRecap}
      />

      {/* Label Modal */}
      <LabelModal
        key={labelModalSessionId}
        isOpen={isLabelModalOpen}
        onClose={closeLabelModal}
        sessionId={labelModalSessionId}
        currentLabel={labelModalCurrentLabel}
      />

      {/* Session Chat Modal */}
      <SessionChatModal
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isOpen={!!selectedSessionId}
        onClose={() => onSelectedSessionIdChange(null)}
        onCloseWorktree={onCloseWorktree}
      />
      <CloseWorktreeDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        onConfirm={executeCloseAction}
        mode="session"
      />
    </>
  )
}
