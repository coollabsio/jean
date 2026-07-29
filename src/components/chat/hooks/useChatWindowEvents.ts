import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useIsMobile } from '@/hooks/use-mobile'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { cancelChatMessage } from '@/services/chat'
import { logger } from '@/lib/logger'
import type { ContentBlock, QueuedMessage, Session } from '@/types/chat'

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
  session: Session | null | undefined
  // Git diff
  gitStatus: { base_branch?: string; base_remote?: string } | null | undefined
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
  hasPendingPlanApproval: boolean
  pendingPlanMessage: { id: string } | null | undefined
  handlePlanApproval: (messageId: string) => void
  handlePlanApprovalYolo: (messageId: string) => void
  handleClearContextApproval: (messageId: string) => void
  handleClearContextApprovalBuild: (messageId: string) => void
  handleWorktreeBuildApproval: (messageId: string) => void
  handleWorktreeYoloApproval: (messageId: string) => void
  /** Ref to the chat scroll viewport for keyboard scrolling */
  scrollViewportRef: RefObject<HTMLDivElement | null>
  /** Begin a user-initiated keyboard scroll: cancels auto-scroll, blocks handleScroll */
  beginKeyboardScroll: () => void
  /** End a user-initiated keyboard scroll: unblocks handleScroll */
  endKeyboardScroll: () => void
}

/**
 * Manages all window event listeners for ChatWindow.
 * Consolidates focus, plan, git-diff, cancel, create-session,
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
  gitStatus,
  setDiffRequest,
  isAtBottom,
  scrollToBottom,
  currentStreamingContentBlocks,
  isSending,
  currentQueuedMessages,
  preferences,
  patchPreferences,
  handleSaveContext,
  handleLoadContext,
  runScripts,
  hasPendingPlanApproval,
  pendingPlanMessage,
  handlePlanApproval,
  handlePlanApprovalYolo,
  handleClearContextApproval,
  handleClearContextApprovalBuild,
  handleWorktreeBuildApproval,
  handleWorktreeYoloApproval,
  scrollViewportRef,
  beginKeyboardScroll,
  endKeyboardScroll,
}: UseChatWindowEventsParams) {
  const isMobile = useIsMobile()
  const focusChatInput = useCallback(() => {
    inputRef.current?.focus()
  }, [inputRef])

  // Focus input on mount, session change, or worktree change (skip on mobile to avoid keyboard popup)
  useEffect(() => {
    if (!isMobile) {
      focusChatInput()
    }
  }, [activeSessionId, activeWorktreeId, focusChatInput, isMobile])

  // When opening a worktree with a visible terminal, xterm can asynchronously
  // steal focus after the chat input focused. Re-assert focus for a short
  // window, but only if focus is still on the body or inside the terminal.
  useEffect(() => {
    if (isMobile || !activeWorktreeId) return

    const shouldReassertFocus = () => {
      const activeElement = document.activeElement as HTMLElement | null
      return (
        !activeElement ||
        activeElement === document.body ||
        activeElement.tagName === 'BODY' ||
        !!activeElement.closest('.xterm, [data-terminal-emulator]')
      )
    }

    const timeouts = [0, 75, 200].map(delay =>
      window.setTimeout(() => {
        if (shouldReassertFocus()) {
          focusChatInput()
        }
      }, delay)
    )

    return () => {
      for (const timeout of timeouts) {
        window.clearTimeout(timeout)
      }
    }
  }, [activeWorktreeId, focusChatInput, isMobile])

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
    const handler = () => focusChatInput()
    window.addEventListener('focus-chat-input', handler)
    return () => window.removeEventListener('focus-chat-input', handler)
  }, [focusChatInput])

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

  // CMD+T: Open configured default; CMD+SHIFT+T / plus buttons open picker
  useEffect(() => {
    const handler = (event: Event) => {
      if (!activeWorktreeId || !activeWorktreePath) return
      const intent =
        (event as CustomEvent<{ intent?: 'default' | 'picker' }>).detail
          ?.intent ?? 'picker'
      useUIStore.getState().openNewSessionModeModal({
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        origin: isModal ? 'modal' : 'chat',
        intent,
      })
    }
    window.addEventListener('create-new-session', handler)
    return () => window.removeEventListener('create-new-session', handler)
  }, [activeWorktreeId, activeWorktreePath, isModal])

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
      const baseRemote = gitStatus?.base_remote
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
            baseRemote,
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
          baseRemote,
        }
      })
    }
    window.addEventListener('open-git-diff', handler)
    return () => window.removeEventListener('open-git-diff', handler)
  }, [
    activeWorktreePath,
    gitStatus?.base_branch,
    gitStatus?.base_remote,
    setDiffRequest,
  ])

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
      if (!activeWorktreeId || !first) return
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

  // Append text to chat input from external context providers (browser Grab).
  useEffect(() => {
    const handler = (e: CustomEvent<{ text: string }>) => {
      const { text } = e.detail
      const sessionId = activeSessionId
      const textarea = inputRef.current
      if (!sessionId || !text || !textarea) return

      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? textarea.value.length
      const current = textarea.value
      const nextValue = current.slice(0, start) + text + current.slice(end)
      textarea.value = nextValue
      textarea.selectionStart = textarea.selectionEnd = start + text.length
      useChatStore.getState().setInputDraft(sessionId, nextValue)
      textarea.focus()
    }
    window.addEventListener('append-chat-input', handler as EventListener)
    return () =>
      window.removeEventListener('append-chat-input', handler as EventListener)
  }, [activeSessionId, inputRef])

  // Save external context as a pending pasted-text attachment (browser Grab).
  useEffect(() => {
    const handler = (
      e: CustomEvent<{ content: string; filename?: string }>
    ) => {
      const { content, filename } = e.detail
      const sessionId = activeSessionId
      if (!sessionId || !content) return

      void invoke<{ id: string; path: string; filename: string; size: number }>(
        'save_pasted_text',
        { content, filename }
      )
        .then(result => {
          useChatStore.getState().addPendingTextFile(sessionId, {
            id: result.id,
            path: result.path,
            filename: result.filename,
            size: result.size,
            content,
          })
          inputRef.current?.focus()
        })
        .catch(error => {
          toast.error('Failed to attach DOM context', {
            description: String(error),
          })
        })
    }
    window.addEventListener('attach-pasted-text', handler as EventListener)
    return () =>
      window.removeEventListener('attach-pasted-text', handler as EventListener)
  }, [activeSessionId, inputRef])

  // Approve plan keyboard shortcut
  useEffect(() => {
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasPendingPlanApproval && pendingPlanMessage) {
        handlePlanApproval(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan', handler)
    return () => window.removeEventListener('approve-plan', handler)
  }, [isModal, hasPendingPlanApproval, pendingPlanMessage, handlePlanApproval])

  // CMD+Up/Down: Scroll chat by one page with eased animation
  // Plain Up/Down: Scroll by a small increment
  const scrollAnimationRef = useRef<number | null>(null)
  const lastScrollAtRef = useRef<number>(0)
  useEffect(() => {
    const easeOut = (t: number) => 1 - (1 - t) ** 3
    const handler = (
      e: CustomEvent<{
        direction: 'up' | 'down'
        amount?: 'small' | 'medium' | 'page'
      }>
    ) => {
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
      const isSmall = e.detail.amount === 'small'
      const isMedium = e.detail.amount === 'medium'
      const magnitude = isSmall
        ? 100
        : isMedium
          ? viewport.clientHeight * 0.35
          : viewport.clientHeight * 0.75
      const delta = e.detail.direction === 'up' ? -magnitude : magnitude
      const now = performance.now()
      // Held-key repeat: previous press very recent → jump instantly so
      // queued animations don't stack and cause lag.
      const isRepeat = isSmall && now - lastScrollAtRef.current < 180
      lastScrollAtRef.current = now
      if (scrollAnimationRef.current) {
        cancelAnimationFrame(scrollAnimationRef.current)
        scrollAnimationRef.current = null
      }
      if (isRepeat) {
        viewport.scrollTop = scrollTop + delta
        endKeyboardScroll()
        return
      }
      const duration = isSmall ? 120 : isMedium ? 180 : 250
      const start = viewport.scrollTop
      const startTime = now
      const step = (t: number) => {
        const progress = Math.min((t - startTime) / duration, 1)
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

  // Approve plan yolo keyboard shortcut
  useEffect(() => {
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasPendingPlanApproval && pendingPlanMessage) {
        handlePlanApprovalYolo(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-yolo', handler)
    return () => window.removeEventListener('approve-plan-yolo', handler)
  }, [
    isModal,
    hasPendingPlanApproval,
    pendingPlanMessage,
    handlePlanApprovalYolo,
  ])

  // Clear context and yolo keyboard shortcut
  useEffect(() => {
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasPendingPlanApproval && pendingPlanMessage) {
        handleClearContextApproval(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-clear-context', handler)
    return () =>
      window.removeEventListener('approve-plan-clear-context', handler)
  }, [
    isModal,
    hasPendingPlanApproval,
    pendingPlanMessage,
    handleClearContextApproval,
  ])

  // Clear context and build keyboard shortcut
  useEffect(() => {
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasPendingPlanApproval && pendingPlanMessage) {
        handleClearContextApprovalBuild(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-clear-context-build', handler)
    return () =>
      window.removeEventListener('approve-plan-clear-context-build', handler)
  }, [
    isModal,
    hasPendingPlanApproval,
    pendingPlanMessage,
    handleClearContextApprovalBuild,
  ])

  // Worktree build keyboard shortcut
  useEffect(() => {
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasPendingPlanApproval && pendingPlanMessage) {
        handleWorktreeBuildApproval(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-worktree-build', handler)
    return () =>
      window.removeEventListener('approve-plan-worktree-build', handler)
  }, [
    isModal,
    hasPendingPlanApproval,
    pendingPlanMessage,
    handleWorktreeBuildApproval,
  ])

  // Worktree yolo keyboard shortcut
  useEffect(() => {
    const handler = () => {
      if (!isModal && useUIStore.getState().sessionChatModalOpen) return
      if (hasPendingPlanApproval && pendingPlanMessage) {
        handleWorktreeYoloApproval(pendingPlanMessage.id)
      }
    }
    window.addEventListener('approve-plan-worktree-yolo', handler)
    return () =>
      window.removeEventListener('approve-plan-worktree-yolo', handler)
  }, [
    isModal,
    hasPendingPlanApproval,
    pendingPlanMessage,
    handleWorktreeYoloApproval,
  ])
}
