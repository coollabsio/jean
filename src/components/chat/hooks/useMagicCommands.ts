import { useEffect, useLayoutEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'

export interface WorkflowRunDetail {
  workflowName: string
  runUrl: string
  runId: string
  branch: string
  displayTitle: string
  projectPath: string | null
}

interface MagicCommandHandlers {
  handleSaveContext: () => void
  handleLoadContext: () => void
  handleCommit: () => void
  handleCommitAndPush: () => void
  handlePull: () => void
  handlePush: () => void
  handleOpenPr: () => void
  handleReview: () => void
  handleMerge: () => void
  handleResolveConflicts: () => void
  handleInvestigateWorkflowRun: (detail: WorkflowRunDetail) => void
  handleInvestigate: (type: 'issue' | 'pr') => void
}

interface UseMagicCommandsOptions extends MagicCommandHandlers {
  /** Whether this ChatWindow is rendered in modal mode */
  isModal?: boolean
  /** Whether the session chat modal is currently open */
  sessionModalOpen?: boolean
}

/**
 * Listens for 'magic-command' custom events from MagicModal and dispatches to appropriate handlers.
 *
 * PERFORMANCE: Uses refs to keep event listener stable across handler changes.
 * The event listener is set up once and uses refs to access current handler versions.
 *
 * DEDUPLICATION: When a session modal is open, the main ChatWindow skips listener registration.
 * The modal ChatWindow (inside SessionChatModal) will handle events instead.
 */
export function useMagicCommands({
  handleSaveContext,
  handleLoadContext,
  handleCommit,
  handleCommitAndPush,
  handlePull,
  handlePush,
  handleOpenPr,
  handleReview,
  handleMerge,
  handleResolveConflicts,
  handleInvestigateWorkflowRun,
  handleInvestigate,
  isModal = false,
  sessionModalOpen = false,
}: UseMagicCommandsOptions): void {
  // Store handlers in ref so event listener always has access to current versions
  const handlersRef = useRef<MagicCommandHandlers>({
    handleSaveContext,
    handleLoadContext,
    handleCommit,
    handleCommitAndPush,
    handlePull,
    handlePush,
    handleOpenPr,
    handleReview,
    handleMerge,
    handleResolveConflicts,
    handleInvestigateWorkflowRun,
    handleInvestigate,
  })

  // Update refs in useLayoutEffect to avoid linter warning about ref updates during render
  // useLayoutEffect runs synchronously after render, ensuring refs are updated before effects
  useLayoutEffect(() => {
    handlersRef.current = {
      handleSaveContext,
      handleLoadContext,
      handleCommit,
      handleCommitAndPush,
      handlePull,
      handlePush,
      handleOpenPr,
      handleReview,
      handleMerge,
      handleResolveConflicts,
      handleInvestigateWorkflowRun,
      handleInvestigate,
    }
  })

  useEffect(() => {
    // If a session modal is open, don't register listener here — the modal
    // ChatWindow will handle events instead.
    if (!isModal && sessionModalOpen) {
      return
    }

    const handleMagicCommand = (
      e: CustomEvent<
        { command: string; sessionId?: string } & Partial<WorkflowRunDetail>
      >
    ) => {
      const { command, ...rest } = e.detail
      const handlers = handlersRef.current
      switch (command) {
        case 'save-context':
          handlers.handleSaveContext()
          break
        case 'load-context':
          handlers.handleLoadContext()
          break
        case 'commit':
          handlers.handleCommit()
          break
        case 'commit-and-push':
          handlers.handleCommitAndPush()
          break
        case 'pull':
          handlers.handlePull()
          break
        case 'push':
          handlers.handlePush()
          break
        case 'open-pr':
          handlers.handleOpenPr()
          break
        case 'review':
          handlers.handleReview()
          break
        case 'merge':
          handlers.handleMerge()
          break
        case 'resolve-conflicts':
          handlers.handleResolveConflicts()
          break
        case 'investigate':
          handlers.handleInvestigate(
            (rest as { type: 'issue' | 'pr' }).type ?? 'issue'
          )
          break
        case 'investigate-workflow-run':
          handlers.handleInvestigateWorkflowRun(rest as WorkflowRunDetail)
          break
      }
    }

    window.addEventListener(
      'magic-command',
      handleMagicCommand as EventListener
    )
    return () =>
      window.removeEventListener(
        'magic-command',
        handleMagicCommand as EventListener
      )
  }, [isModal, sessionModalOpen]) // Re-register when modal state changes

  // Consume pending magic command set by MagicModal.
  // Only the non-modal ChatWindow should consume it.
  const pendingMagicCommand = useChatStore(state => state.pendingMagicCommand)
  useEffect(() => {
    if (!pendingMagicCommand) return
    if (isModal) return

    useChatStore.getState().setPendingMagicCommand(null)

    const handlers = handlersRef.current
    switch (pendingMagicCommand.command) {
      case 'merge':
        handlers.handleMerge()
        break
      case 'resolve-conflicts':
        handlers.handleResolveConflicts()
        break
    }
  }, [pendingMagicCommand, isModal])
}
