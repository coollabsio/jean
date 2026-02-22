import { useEffect, useRef, type RefObject } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { cancelChatMessage } from '@/services/chat'
import { isNativeApp, isServerMode } from '@/lib/environment'
import { logger } from '@/lib/logger'
import type {
  ContentBlock,
  QueuedMessage,
  SessionDigest,
  Session,
} from '@/types/chat'

interface UseChatWindowEventsParams {
  inputRef: RefObject<HTMLTextAreaElement | null>
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  isModal: boolean
  isViewingCanvasTab: boolean
  // Plan dialog
  latestPlanContent: string | null
  latestPlanFilePath: string | null
  setPlanDialogContent: (content: string | null) => void
  setIsPlanDialogOpen: (open: boolean) => void
  // Recap dialog
  session: Session | null | undefined
  isRecapDialogOpen: boolean
  recapDialogDigest: SessionDigest | null
  setRecapDialogDigest: (d: SessionDigest | null) => void
  setIsRecapDialogOpen: (open: boolean) => void
  setIsGeneratingRecap: (g: boolean) => void
  // Git diff
  gitStatus: { base_branch?: string } | null | undefined
  sessionModalOpen: boolean
  setDiffRequest: (
    req:
      | { type: 'uncommitted' | 'branch'; worktreePath: string; baseBranch: string }
      | null
      | ((
          prev: { type: 'uncommitted' | 'branch'; worktreePath: string; baseBranch: string } | null
        ) => { type: 'uncommitted' | 'branch'; worktreePath: string; baseBranch: string } | null)
  ) => void
  // Auto-scroll
  isAtBottom: boolean
  scrollToBottom: (instant?: boolean) => void
  streamingContent: string
  currentStreamingContentBlocks: ContentBlock[]
  isSending: boolean
  currentQueuedMessages: QueuedMessage[]
  // Create session
  createSession: { mutate: (args: { worktreeId: string; worktreePath: string }, opts?: { onSuccess?: (session: { id: string }) => void }) => void }
  // Debug/preferences
  preferences: { debug_mode_enabled?: boolean } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  savePreferences: { mutate: (prefs: any) => void }
  // Context operations
  handleSaveContext: () => void
  handleLoadContext: () => void
  // Run script
  runScript: string | null | undefined
  // Plan approval (keyboard shortcuts)
  hasStreamingPlan: boolean
  pendingPlanMessage: { id: string } | null | undefined
  handleStreamingPlanApproval: () => void
  handleStreamingPlanApprovalYolo: () => void
  handlePlanApproval: (messageId: string) => void
  handlePlanApprovalYolo: (messageId: string) => void
  /** Whether the active session uses Codex backend (no native approval flow) */
  isCodexBackend: boolean
}

/**
 * Manages all window event listeners for ChatWindow.
 * Consolidates focus, plan, recap, git-diff, cancel, create-session,
 * cycle-mode, set-chat-input, debug-mode, and context command events.
 */
export function useChatWindowEvents({
  inputRef,
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  isModal,
  isViewingCanvasTab,
  latestPlanContent,
  latestPlanFilePath,
  setPlanDialogContent,
  setIsPlanDialogOpen,
  session,
  isRecapDialogOpen,
  recapDialogDigest,
  setRecapDialogDigest,
  setIsRecapDialogOpen,
  setIsGeneratingRecap,
  gitStatus,
  sessionModalOpen,
  setDiffRequest,
  isAtBottom,
  scrollToBottom,
  streamingContent,
  currentStreamingContentBlocks,
  isSending,
  currentQueuedMessages,
  createSession,
  preferences,
  savePreferences,
  handleSaveContext,
  handleLoadContext,
  runScript,
  hasStreamingPlan,
  pendingPlanMessage,
  handleStreamingPlanApproval,
  handleStreamingPlanApprovalYolo,
  handlePlanApproval,
  handlePlanApprovalYolo,
  isCodexBackend,
}: UseChatWindowEventsParams) {
  // Focus input on mount, session change, or worktree change
  useEffect(() => {
    inputRef.current?.focus()
  }, [activeSessionId, activeWorktreeId, inputRef])

  // Scroll to bottom on worktree switch
  useEffect(() => {
    scrollToBottom(true)
  }, [activeWorktreeId, scrollToBottom])

  // Auto-scroll on new messages/streaming
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom()
    }
  }, [
    session?.messages.length,
    streamingContent,
    currentStreamingContentBlocks.length,
    isSending,
    isAtBottom,
    scrollToBottom,
    currentQueuedMessages.length,
  ])

  // CMD+L: Focus chat input
  useEffect(() => {
    const handler = () => inputRef.current?.focus()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [inputRef])

  // P key: Open plan dialog
  useEffect(() => {
    if (isViewingCanvasTab) return
    const handler = () => {
      if (latestPlanContent) {
        setPlanDialogContent(latestPlanContent)
        setIsPlanDialogOpen(true)
      } else if (latestPlanFilePath) {
        setIsPlanDialogOpen(true)
      } else {
        toast.info('No plan available for this session')
      }
    }
    window.addEventListener('open-plan', handler)
    return () => window.removeEventListener('open-plan', handler)
  }, [latestPlanContent, latestPlanFilePath, isViewingCanvasTab, setPlanDialogContent, setIsPlanDialogOpen])

  // R key: Open recap dialog
  useEffect(() => {
    if (isViewingCanvasTab && !isModal) return
    const handleOpenRecap = async () => {
      if (!activeSessionId) return

      if (isRecapDialogOpen) {
        const currentCount = session?.messages.length ?? 0
        const digestCount = recapDialogDigest?.message_count ?? 0
        if (currentCount <= digestCount) {
          toast.info('No new messages since last recap')
          return
        }
      }

      const cachedDigest = useChatStore
        .getState()
        .getSessionDigest(activeSessionId)
      const existingDigest = cachedDigest ?? session?.digest ?? null

      if (existingDigest && !isRecapDialogOpen) {
        setRecapDialogDigest(existingDigest)
        setIsRecapDialogOpen(true)
        return
      }

      const messageCount = session?.messages.length ?? 0
      if (messageCount < 2) {
        toast.info('Not enough messages to generate a recap')
        return
      }

      setRecapDialogDigest(null)
      setIsRecapDialogOpen(true)
      setIsGeneratingRecap(true)

      try {
        const digest = await invoke<SessionDigest>('generate_session_digest', {
          sessionId: activeSessionId,
        })
        useChatStore.getState().markSessionNeedsDigest(activeSessionId)
        useChatStore.getState().setSessionDigest(activeSessionId, digest)
        invoke('update_session_digest', {
          sessionId: activeSessionId,
          digest,
        }).catch(err => {
          console.error('[ChatWindow] Failed to persist digest:', err)
        })
        setRecapDialogDigest(digest)
      } catch (error) {
        setRecapDialogDigest(null)
        setIsRecapDialogOpen(false)
        toast.error(`Failed to generate recap: ${error}`)
      } finally {
        setIsGeneratingRecap(false)
      }
    }
    window.addEventListener('open-recap', handleOpenRecap)
    return () => window.removeEventListener('open-recap', handleOpenRecap)
  }, [
    isViewingCanvasTab,
    isModal,
    activeSessionId,
    session,
    isRecapDialogOpen,
    recapDialogDigest,
    setRecapDialogDigest,
    setIsRecapDialogOpen,
    setIsGeneratingRecap,
  ])

  // CMD+T: Create new session
  useEffect(() => {
    const handler = () => {
      if (!activeWorktreeId || !activeWorktreePath) return
      createSession.mutate(
        { worktreeId: activeWorktreeId, worktreePath: activeWorktreePath },
        {
          onSuccess: session => {
            useChatStore
              .getState()
              .setActiveSession(activeWorktreeId, session.id)
            window.dispatchEvent(
              new CustomEvent('open-session-modal', {
                detail: { sessionId: session.id },
              })
            )
          },
        }
      )
    }
    window.addEventListener('create-new-session', handler)
    return () => window.removeEventListener('create-new-session', handler)
  }, [activeWorktreeId, activeWorktreePath, createSession])

  // SHIFT+TAB: Cycle execution mode
  useEffect(() => {
    if (!activeSessionId) return
    const handler = () => {
      useChatStore.getState().cycleExecutionMode(activeSessionId)
    }
    window.addEventListener('cycle-execution-mode', handler)
    return () => window.removeEventListener('cycle-execution-mode', handler)
  }, [activeSessionId])

  // CMD+G: Open git diff
  useEffect(() => {
    if (!isModal && isViewingCanvasTab && sessionModalOpen) return

    const handler = () => {
      if (!activeWorktreePath) return
      const baseBranch = gitStatus?.base_branch ?? 'main'
      setDiffRequest(prev => {
        if (prev) {
          return {
            ...prev,
            type: prev.type === 'uncommitted' ? 'branch' : 'uncommitted',
          }
        }
        return { type: 'uncommitted', worktreePath: activeWorktreePath, baseBranch }
      })
    }
    window.addEventListener('open-git-diff', handler)
    return () => window.removeEventListener('open-git-diff', handler)
  }, [isModal, isViewingCanvasTab, sessionModalOpen, activeWorktreePath, gitStatus?.base_branch, setDiffRequest])

  // ESC: Cancel prompt
  const cancelContextRef = useRef({ activeWorktreeId, activeSessionId })
  cancelContextRef.current = { activeWorktreeId, activeSessionId }

  useEffect(() => {
    const handler = () => {
      const state = useChatStore.getState()
      const wtId = cancelContextRef.current.activeWorktreeId
      logger.debug('cancel-prompt event received', {
        wtId,
        activeSessionId: cancelContextRef.current.activeSessionId,
      })
      if (!wtId) {
        logger.debug('cancel-prompt: no worktreeId, aborting')
        return
      }

      const isCanvas = state.viewingCanvasTab[wtId] ?? true
      const canvasSession = state.canvasSelectedSessionIds[wtId] ?? null
      const activeSession =
        cancelContextRef.current.activeSessionId ??
        state.activeSessionIds[wtId] ??
        null

      const sessionToCancel =
        isCanvas && canvasSession ? canvasSession : activeSession
      if (!sessionToCancel) {
        logger.debug('cancel-prompt: no sessionToCancel', {
          isCanvas,
          canvasSession,
          activeSession,
        })
        return
      }

      const isSendingTarget = state.sendingSessionIds[sessionToCancel] ?? false
      if (!isSendingTarget) {
        logger.debug('cancel-prompt: session not sending', {
          sessionToCancel,
          sendingSessionIds: state.sendingSessionIds,
        })
        return
      }

      logger.debug('cancel-prompt: cancelling', { sessionToCancel, wtId })
      cancelChatMessage(sessionToCancel, wtId)
    }
    window.addEventListener('cancel-prompt', handler)
    return () => window.removeEventListener('cancel-prompt', handler)
  }, [])

  // Context commands (save/load/run-script)
  useEffect(() => {
    const handleSave = () => handleSaveContext()
    const handleLoad = () => handleLoadContext()
    const handleRun = () => {
      if (!isServerMode() || !activeWorktreeId || !runScript) return
      useTerminalStore.getState().startRun(activeWorktreeId, runScript)
    }
    window.addEventListener('command:save-context', handleSave)
    window.addEventListener('command:load-context', handleLoad)
    window.addEventListener('command:run-script', handleRun)
    return () => {
      window.removeEventListener('command:save-context', handleSave)
      window.removeEventListener('command:load-context', handleLoad)
      window.removeEventListener('command:run-script', handleRun)
    }
  }, [handleSaveContext, handleLoadContext, activeWorktreeId, runScript])

  // Toggle debug mode
  useEffect(() => {
    const handler = () => {
      if (!preferences) return
      savePreferences.mutate({
        ...preferences,
        debug_mode_enabled: !preferences.debug_mode_enabled,
      })
    }
    window.addEventListener('command:toggle-debug-mode', handler)
    return () => window.removeEventListener('command:toggle-debug-mode', handler)
  }, [preferences, savePreferences])

  // Set chat input from external (conflict resolution flow)
  useEffect(() => {
    const handler = (e: CustomEvent<{ text: string }>) => {
      const { text } = e.detail
      const state = useChatStore.getState()
      const sessionId = activeSessionId
      if (sessionId && text) {
        state.setInputDraft(sessionId, text)
        inputRef.current?.focus()
      }
    }
    window.addEventListener('set-chat-input', handler as EventListener)
    return () =>
      window.removeEventListener('set-chat-input', handler as EventListener)
  }, [activeSessionId, inputRef])

  // Approve plan keyboard shortcut (no-op for Codex which has no native approval flow)
  useEffect(() => {
    if (!isModal && isViewingCanvasTab) return
    if (isCodexBackend) return
    const handler = () => {
      if (hasStreamingPlan) {
        handleStreamingPlanApproval()
        return
      }
      if (pendingPlanMessage) {
        handlePlanApproval(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan', handler)
    return () => window.removeEventListener('approve-plan', handler)
  }, [
    isModal,
    isViewingCanvasTab,
    isCodexBackend,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApproval,
    handlePlanApproval,
  ])

  // Approve plan yolo keyboard shortcut (no-op for Codex)
  useEffect(() => {
    if (!isModal && isViewingCanvasTab) return
    if (isCodexBackend) return
    const handler = () => {
      if (hasStreamingPlan) {
        handleStreamingPlanApprovalYolo()
        return
      }
      if (pendingPlanMessage) {
        handlePlanApprovalYolo(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-yolo', handler)
    return () => window.removeEventListener('approve-plan-yolo', handler)
  }, [
    isModal,
    isViewingCanvasTab,
    isCodexBackend,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApprovalYolo,
    handlePlanApprovalYolo,
  ])
}
