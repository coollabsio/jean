import { useEffect, useRef, type RefObject } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { cancelChatMessage } from '@/services/chat'
import { isNativeApp } from '@/lib/environment'
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
  setDiffRequest: (
    req:
      | {
          type: 'uncommitted' | 'branch'
          worktreePath: string
          baseBranch: string
        }
      | null
      | ((
          prev: {
            type: 'uncommitted' | 'branch'
            worktreePath: string
            baseBranch: string
          } | null
        ) => {
          type: 'uncommitted' | 'branch'
          worktreePath: string
          baseBranch: string
        } | null)
  ) => void
  // Auto-scroll
  isAtBottom: boolean
  scrollToBottom: (instant?: boolean) => void
  currentStreamingContentBlocks: ContentBlock[]
  isSending: boolean
  currentQueuedMessages: QueuedMessage[]
  // Create session
  createSession: {
    mutate: (
      args: { worktreeId: string; worktreePath: string },
      opts?: { onSuccess?: (session: { id: string }) => void }
    ) => void
  }
  // Debug/preferences
  preferences: { debug_mode_enabled?: boolean } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patchPreferences: { mutate: (prefs: any) => void }
  // Context operations
  handleSaveContext: () => void
  handleLoadContext: () => void
  // Run scripts
  runScripts: string[]
  // Plan approval (keyboard shortcuts)
  hasStreamingPlan: boolean
  pendingPlanMessage: { id: string } | null | undefined
  handleStreamingPlanApproval: () => void
  handleStreamingPlanApprovalYolo: () => void
  handlePlanApproval: (messageId: string) => void
  handlePlanApprovalYolo: (messageId: string) => void
  handleClearContextApproval: (messageId: string) => void
  handleStreamingClearContextApproval: () => void
  handleClearContextApprovalBuild: (messageId: string) => void
  handleStreamingClearContextApprovalBuild: () => void
  /** Whether the active session uses Codex backend (no native approval flow) */
  isCodexBackend: boolean
  /** Ref to the chat scroll viewport for keyboard scrolling */
  scrollViewportRef: RefObject<HTMLDivElement | null>
  /** Begin a user-initiated keyboard scroll: cancels auto-scroll, blocks handleScroll */
  beginKeyboardScroll: () => void
  /** End a user-initiated keyboard scroll: unblocks handleScroll */
  endKeyboardScroll: () => void
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
  setDiffRequest,
  isAtBottom,
  scrollToBottom,
  currentStreamingContentBlocks,
  isSending,
  currentQueuedMessages,
  createSession,
  preferences,
  patchPreferences,
  handleSaveContext,
  handleLoadContext,
  runScripts,
  hasStreamingPlan,
  pendingPlanMessage,
  handleStreamingPlanApproval,
  handleStreamingPlanApprovalYolo,
  handlePlanApproval,
  handlePlanApprovalYolo,
  handleClearContextApproval,
  handleStreamingClearContextApproval,
  handleClearContextApprovalBuild,
  handleStreamingClearContextApprovalBuild,
  isCodexBackend,
  scrollViewportRef,
  beginKeyboardScroll,
  endKeyboardScroll,
}: UseChatWindowEventsParams) {
  const isMobile = useIsMobile()

  // Focus input on mount, session change, or worktree change (skip on mobile to avoid keyboard popup)
  useEffect(() => {
    if (!isMobile) {
      inputRef.current?.focus()
    }
  }, [activeSessionId, activeWorktreeId, inputRef, isMobile])

  // Scroll to bottom on worktree switch
  useEffect(() => {
    scrollToBottom(true)
  }, [activeWorktreeId, scrollToBottom])

  // Auto-scroll on new messages/streaming
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isAtBottom and scrollToBottom are intentionally
  // read but not deps: isAtBottom changing shouldn't re-trigger scroll, and scrollToBottom is stable.
  // streamingContent is excluded because it changes every ~50ms during streaming, causing cascading
  // smooth scroll animations. Content block length changes are sufficient to track streaming progress.
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom()
    }
  }, [
    session?.messages.length,
    currentStreamingContentBlocks.length,
    isSending,
    currentQueuedMessages.length,
  ])

  // CMD+L / toolbar selection: Focus chat input
  useEffect(() => {
    const handler = () => inputRef.current?.focus()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [inputRef])

  // P key: Open plan dialog
  useEffect(() => {
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
  }, [
    latestPlanContent,
    latestPlanFilePath,
    setPlanDialogContent,
    setIsPlanDialogOpen,
  ])

  // R key: Open recap dialog
  useEffect(() => {
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
      const store = useChatStore.getState()
      store.cycleExecutionMode(activeSessionId)
      const mode =
        useChatStore.getState().executionModes[activeSessionId] ?? 'plan'
      // Broadcast to other clients (native ↔ web access)
      invoke('broadcast_session_setting', {
        sessionId: activeSessionId,
        key: 'executionMode',
        value: mode,
      }).catch(() => undefined)
      // Persist immediately
      if (activeWorktreeId && activeWorktreePath) {
        invoke('update_session_state', {
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          sessionId: activeSessionId,
          selectedExecutionMode: mode,
        }).catch(() => undefined)
      }
    }
    window.addEventListener('cycle-execution-mode', handler)
    return () => window.removeEventListener('cycle-execution-mode', handler)
  }, [activeSessionId, activeWorktreeId, activeWorktreePath])

  // CMD+G: Open git diff (also handles button clicks that dispatch with detail.type)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!activeWorktreePath) return
      const baseBranch = gitStatus?.base_branch ?? 'main'
      const requestedType = (e as CustomEvent).detail?.type as
        | 'uncommitted'
        | 'branch'
        | undefined

      setDiffRequest(prev => {
        if (requestedType) {
          // Explicit type from button click — open or switch to that type
          return {
            type: requestedType,
            worktreePath: activeWorktreePath,
            baseBranch,
          }
        }
        if (prev) {
          // CMD+G toggle between types
          return {
            ...prev,
            type: prev.type === 'uncommitted' ? 'branch' : 'uncommitted',
          }
        }
        return {
          type: 'uncommitted',
          worktreePath: activeWorktreePath,
          baseBranch,
        }
      })
    }
    window.addEventListener('open-git-diff', handler)
    return () => window.removeEventListener('open-git-diff', handler)
  }, [activeWorktreePath, gitStatus?.base_branch, setDiffRequest])

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
        isModal,
      })
      if (!wtId) {
        logger.debug('cancel-prompt: no worktreeId, aborting')
        return
      }

      // Non-modal: skip when session modal is open (modal's handler takes priority)
      if (!isModal && useUIStore.getState().sessionChatModalOpen) {
        logger.debug('cancel-prompt: non-modal skipping, session modal is open')
        return
      }

      const sessionToCancel =
        cancelContextRef.current.activeSessionId ??
        state.activeSessionIds[wtId] ??
        null

      if (!sessionToCancel) {
        logger.debug('cancel-prompt: no sessionToCancel', {
          sessionToCancel,
          isModal,
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
  }, []) // isModal is constant for the lifetime of ChatWindow

  // Context commands (save/load/run-script)
  useEffect(() => {
    const handleSave = () => handleSaveContext()
    const handleLoad = () => handleLoadContext()
    const handleRun = () => {
      const first = runScripts[0]
      if (!isNativeApp() || !activeWorktreeId || !first) return
      useTerminalStore.getState().startRun(activeWorktreeId, first)
    }
    window.addEventListener('command:save-context', handleSave)
    window.addEventListener('command:load-context', handleLoad)
    window.addEventListener('command:run-script', handleRun)
    return () => {
      window.removeEventListener('command:save-context', handleSave)
      window.removeEventListener('command:load-context', handleLoad)
      window.removeEventListener('command:run-script', handleRun)
    }
  }, [handleSaveContext, handleLoadContext, activeWorktreeId, runScripts])

  // Toggle debug mode
  useEffect(() => {
    const handler = () => {
      if (!preferences) return
      patchPreferences.mutate({
        debug_mode_enabled: !preferences.debug_mode_enabled,
      })
    }
    window.addEventListener('command:toggle-debug-mode', handler)
    return () =>
      window.removeEventListener('command:toggle-debug-mode', handler)
  }, [preferences, patchPreferences])

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
    if (isCodexBackend) return
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
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
    isCodexBackend,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApproval,
    handlePlanApproval,
  ])

  // CMD+Up/Down: Scroll chat by one page with eased animation
  const scrollAnimationRef = useRef<number | null>(null)
  useEffect(() => {
    const easeOut = (t: number) => 1 - (1 - t) ** 3
    const handler = (e: CustomEvent<{ direction: 'up' | 'down' }>) => {
      const viewport = scrollViewportRef.current
      if (!viewport) return
      const { scrollTop, scrollHeight, clientHeight } = viewport
      // Skip if already at the boundary
      if (
        e.detail.direction === 'down' &&
        scrollHeight - scrollTop - clientHeight < 2
      )
        return
      if (e.detail.direction === 'up' && scrollTop < 2) return
      beginKeyboardScroll()
      // Cancel any ongoing keyboard scroll animation
      if (scrollAnimationRef.current) {
        cancelAnimationFrame(scrollAnimationRef.current)
      }
      const delta =
        e.detail.direction === 'up'
          ? -viewport.clientHeight * 0.75
          : viewport.clientHeight * 0.75
      const start = viewport.scrollTop
      const startTime = performance.now()
      const duration = 250
      const step = (now: number) => {
        const progress = Math.min((now - startTime) / duration, 1)
        viewport.scrollTop = start + delta * easeOut(progress)
        if (progress < 1) {
          scrollAnimationRef.current = requestAnimationFrame(step)
        } else {
          scrollAnimationRef.current = null
          endKeyboardScroll()
        }
      }
      scrollAnimationRef.current = requestAnimationFrame(step)
    }
    window.addEventListener('scroll-chat', handler as EventListener)
    return () => {
      window.removeEventListener('scroll-chat', handler as EventListener)
      if (scrollAnimationRef.current) {
        cancelAnimationFrame(scrollAnimationRef.current)
        endKeyboardScroll()
      }
    }
  }, [scrollViewportRef, beginKeyboardScroll, endKeyboardScroll])

  // Approve plan yolo keyboard shortcut (no-op for Codex)
  useEffect(() => {
    if (isCodexBackend) return
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
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
    isCodexBackend,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApprovalYolo,
    handlePlanApprovalYolo,
  ])

  // Clear context and yolo keyboard shortcut (no-op for Codex)
  useEffect(() => {
    if (isCodexBackend) return
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasStreamingPlan) {
        handleStreamingClearContextApproval()
        return
      }
      if (pendingPlanMessage) {
        handleClearContextApproval(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-clear-context', handler)
    return () =>
      window.removeEventListener('approve-plan-clear-context', handler)
  }, [
    isModal,
    isCodexBackend,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingClearContextApproval,
    handleClearContextApproval,
  ])

  // Clear context and build keyboard shortcut (no-op for Codex)
  useEffect(() => {
    if (isCodexBackend) return
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasStreamingPlan) {
        handleStreamingClearContextApprovalBuild()
        return
      }
      if (pendingPlanMessage) {
        handleClearContextApprovalBuild(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-clear-context-build', handler)
    return () =>
      window.removeEventListener('approve-plan-clear-context-build', handler)
  }, [
    isModal,
    isCodexBackend,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingClearContextApprovalBuild,
    handleClearContextApprovalBuild,
  ])
}
