import { useEffect, useRef, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import {
  useUpdateSessionState,
  useSessions,
  chatQueryKeys,
} from '@/services/chat'
import { logger } from '@/lib/logger'
import type {
  QuestionAnswer,
  PermissionDenial,
  ExecutionMode,
  Session,
  WorktreeSessions,
} from '@/types/chat'

// Simple debounce implementation with flush support
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): T & { cancel: () => void; flush: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pendingArgs: any[] | null = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const debounced = ((...args: any[]) => {
    pendingArgs = args
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      fn(...args)
      timeoutId = null
      pendingArgs = null
    }, delay)
  }) as T & { cancel: () => void; flush: () => void }

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
      pendingArgs = null
    }
  }

  debounced.flush = () => {
    if (timeoutId && pendingArgs) {
      clearTimeout(timeoutId)
      fn(...pendingArgs)
      timeoutId = null
      pendingArgs = null
    }
  }

  return debounced
}

interface SessionState {
  answeredQuestions: string[]
  submittedAnswers: Record<string, QuestionAnswer[]>
  fixedFindings: string[]
  pendingPermissionDenials: PermissionDenial[]
  deniedMessageContext: {
    message: string
    model: string
    thinking_level: string
  } | null
  isReviewing: boolean
  waitingForInput: boolean
  planFilePath: string | null
  pendingPlanMessageId: string | null
  enabledMcpServers: string[] | null
  selectedExecutionMode: ExecutionMode | null
}

/**
 * Hook that handles session-specific state persistence:
 * 1. Loads session state from the Session object when session changes
 * 2. Subscribes to Zustand changes and debounce saves to session file
 *
 * This hook should be used at the app level (e.g., in App.tsx)
 */
export function useSessionStatePersistence() {
  // Subscribe to primitive values to trigger re-renders only when context actually changes.
  // Prefer full-view active session, fall back to canvas-modal selected session
  // (canvas modals don't set activeWorktreeId).
  const activeSessionId = useChatStore(state => {
    if (state.activeWorktreeId) {
      return state.activeSessionIds[state.activeWorktreeId] ?? null
    }
    return null
  })

  // Derive worktree context via getState() (non-reactive) keyed on the reactive activeSessionId
  const { effectiveWorktreeId, effectiveWorktreePath } = useMemo(() => {
    if (!activeSessionId)
      return {
        effectiveWorktreeId: null as string | null,
        effectiveWorktreePath: null as string | null,
      }
    const {
      activeWorktreeId,
      activeWorktreePath,
      sessionWorktreeMap,
      worktreePaths,
    } = useChatStore.getState()
    const wtId = activeWorktreeId ?? sessionWorktreeMap[activeSessionId] ?? null
    const wtPath =
      activeWorktreePath ?? (wtId ? (worktreePaths[wtId] ?? null) : null)
    return { effectiveWorktreeId: wtId, effectiveWorktreePath: wtPath }
  }, [activeSessionId])

  // Load sessions to get session data
  const { data: sessionsData } = useSessions(
    effectiveWorktreeId,
    effectiveWorktreePath
  )

  const queryClient = useQueryClient()
  const { mutate: updateSessionState } = useUpdateSessionState()

  // Track if we're loading from session (to avoid save loop)
  const isLoadingRef = useRef(false)
  // Track which session has been loaded from disk (skip re-loads on sessionsData refetch)
  const loadedSessionRef = useRef<string | null>(null)
  // Track last saved state to detect actual changes
  const lastSavedStateRef = useRef<SessionState | null>(null)

  // Create debounced save function
  const debouncedSaveRef = useRef<ReturnType<
    typeof debounce<(state: SessionState) => void>
  > | null>(null)

  // Get current session state from Zustand
  const getCurrentSessionState = useCallback(
    (sessionId: string): SessionState => {
      const {
        answeredQuestions,
        submittedAnswers,
        fixedFindings,
        pendingPermissionDenials,
        deniedMessageContext,
        reviewingSessions,
        waitingForInputSessionIds,
        planFilePaths,
        pendingPlanMessageIds,
        enabledMcpServers,
        executionModes,
      } = useChatStore.getState()

      const ctx = deniedMessageContext[sessionId]

      return {
        answeredQuestions: Array.from(
          answeredQuestions[sessionId] ?? new Set()
        ),
        submittedAnswers: submittedAnswers[sessionId] ?? {},
        fixedFindings: Array.from(fixedFindings[sessionId] ?? new Set()),
        pendingPermissionDenials: pendingPermissionDenials[sessionId] ?? [],
        deniedMessageContext: ctx
          ? {
              message: ctx.message,
              model: ctx.model ?? '',
              thinking_level: ctx.thinkingLevel ?? 'off',
            }
          : null,
        isReviewing: reviewingSessions[sessionId] ?? false,
        waitingForInput: waitingForInputSessionIds[sessionId] ?? false,
        planFilePath: planFilePaths[sessionId] ?? null,
        pendingPlanMessageId: pendingPlanMessageIds[sessionId] ?? null,
        enabledMcpServers: enabledMcpServers[sessionId] ?? null,
        selectedExecutionMode: executionModes[sessionId] ?? null,
      }
    },
    []
  )

  // Initialize debounced save function when worktree/session changes
  useEffect(() => {
    if (!effectiveWorktreeId || !effectiveWorktreePath || !activeSessionId) {
      return
    }

    const worktreeId = effectiveWorktreeId
    const worktreePath = effectiveWorktreePath
    const sessionId = activeSessionId

    debouncedSaveRef.current = debounce((state: SessionState) => {
      if (isLoadingRef.current) return

      updateSessionState({
        worktreeId,
        worktreePath,
        sessionId,
        answeredQuestions: state.answeredQuestions,
        submittedAnswers: state.submittedAnswers,
        fixedFindings: state.fixedFindings,
        pendingPermissionDenials: state.pendingPermissionDenials,
        deniedMessageContext: state.deniedMessageContext,
        isReviewing: state.isReviewing,
        // Only persist waitingForInput when clearing it (user approval action).
        // Setting it to true is handled by useStreamingEvents' chat:done handler
        // which persists directly via invoke(). Persisting true here risks
        // cross-client overwrites: native client's pauseSession sets true in its
        // Zustand, then this debounced save writes it to disk after web cleared it.
        waitingForInput: state.waitingForInput ? undefined : state.waitingForInput,
        planFilePath: state.planFilePath,
        pendingPlanMessageId: state.pendingPlanMessageId,
        enabledMcpServers: state.enabledMcpServers,
        selectedExecutionMode: state.selectedExecutionMode,
      })
    }, 500)

    return () => {
      debouncedSaveRef.current?.cancel()
    }
  }, [
    effectiveWorktreeId,
    effectiveWorktreePath,
    activeSessionId,
    updateSessionState,
  ])

  // Flush pending saves on page unload/reload to prevent data loss
  useEffect(() => {
    const handleBeforeUnload = () => {
      debouncedSaveRef.current?.flush()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  // Load session state from Session object when session changes
  useEffect(() => {
    if (!activeSessionId || !sessionsData) return

    // Only load from disk when switching to a new session.
    // Re-loading on every sessionsData refetch would overwrite in-memory
    // Zustand state with stale on-disk data (due to 500ms debounced saves),
    // causing answered questions / fixed findings to flicker.
    if (loadedSessionRef.current === activeSessionId) return

    const session = sessionsData.sessions.find(s => s.id === activeSessionId)
    if (!session) return

    // Mark as loaded only after finding the session (retry on next refetch if not found)
    loadedSessionRef.current = activeSessionId

    isLoadingRef.current = true

    logger.debug('Loading session state from session file', {
      sessionId: activeSessionId,
    })

    const currentState = useChatStore.getState()

    // Build updated state
    const updates: Partial<typeof currentState> = {}

    // Load answered questions
    if (session.answered_questions && session.answered_questions.length > 0) {
      updates.answeredQuestions = {
        ...currentState.answeredQuestions,
        [activeSessionId]: new Set(session.answered_questions),
      }
    }

    // Load submitted answers
    if (
      session.submitted_answers &&
      Object.keys(session.submitted_answers).length > 0
    ) {
      updates.submittedAnswers = {
        ...currentState.submittedAnswers,
        [activeSessionId]: session.submitted_answers,
      }
    }

    // Load fixed findings
    if (session.fixed_findings && session.fixed_findings.length > 0) {
      updates.fixedFindings = {
        ...currentState.fixedFindings,
        [activeSessionId]: new Set(session.fixed_findings),
      }
    }

    // Load pending permission denials
    if (
      session.pending_permission_denials &&
      session.pending_permission_denials.length > 0
    ) {
      updates.pendingPermissionDenials = {
        ...currentState.pendingPermissionDenials,
        [activeSessionId]: session.pending_permission_denials,
      }
    }

    // Load denied message context
    if (session.denied_message_context) {
      updates.deniedMessageContext = {
        ...currentState.deniedMessageContext,
        [activeSessionId]: {
          message: session.denied_message_context.message,
          model: session.denied_message_context.model,
          thinkingLevel: session.denied_message_context.thinking_level as
            | 'off'
            | 'think'
            | 'megathink'
            | 'ultrathink',
        },
      }
    }

    // Load reviewing status (handle both true and false to fix asymmetry bug)
    const isReviewing = session.is_reviewing ?? false
    const currentReviewing =
      currentState.reviewingSessions[activeSessionId] ?? false
    if (currentReviewing !== isReviewing) {
      updates.reviewingSessions = {
        ...currentState.reviewingSessions,
        [activeSessionId]: isReviewing,
      }
    }

    // Load review results from session data into Zustand store
    if (session.review_results) {
      updates.reviewResults = {
        ...currentState.reviewResults,
        [activeSessionId]: session.review_results,
      }
    }

    // Load fixed review findings from session data
    if (session.fixed_findings && session.fixed_findings.length > 0) {
      updates.fixedReviewFindings = {
        ...currentState.fixedReviewFindings,
        [activeSessionId]: new Set(session.fixed_findings),
      }
    }

    // Load waiting for input status
    const waitingForInput = session.waiting_for_input ?? false
    const currentWaiting =
      currentState.waitingForInputSessionIds[activeSessionId] ?? false
    if (currentWaiting !== waitingForInput) {
      updates.waitingForInputSessionIds = {
        ...currentState.waitingForInputSessionIds,
        [activeSessionId]: waitingForInput,
      }
    }

    // Load plan file path
    if (session.plan_file_path) {
      updates.planFilePaths = {
        ...currentState.planFilePaths,
        [activeSessionId]: session.plan_file_path,
      }
    }

    // Load pending plan message ID
    if (session.pending_plan_message_id) {
      updates.pendingPlanMessageIds = {
        ...currentState.pendingPlanMessageIds,
        [activeSessionId]: session.pending_plan_message_id,
      }
    }

    // Load enabled MCP servers override
    if (session.enabled_mcp_servers !== undefined) {
      updates.enabledMcpServers = {
        ...currentState.enabledMcpServers,
        [activeSessionId]: session.enabled_mcp_servers,
      }
    }

    // Load selected execution mode
    if (session.selected_execution_mode) {
      updates.executionModes = {
        ...currentState.executionModes,
        [activeSessionId]: session.selected_execution_mode,
      }
    }

    // NOTE: Do NOT load queued_messages from session data into Zustand here.
    // Queue state is synced in real-time via the queue:updated Tauri event
    // (useMainWindowEventListeners). Loading from TanStack cache is redundant
    // and can restore stale data, causing double execution.

    // When opening a session that's in plan-waiting state (Codex/Opencode plan mode),
    // transition it to review — viewing the session acts as acknowledgment.
    if (
      session.waiting_for_input &&
      session.waiting_for_input_type === 'plan' &&
      session.backend !== 'claude'
    ) {
      updates.waitingForInputSessionIds = {
        ...(updates.waitingForInputSessionIds ??
          currentState.waitingForInputSessionIds),
        [activeSessionId]: false,
      }
      updates.reviewingSessions = {
        ...(updates.reviewingSessions ?? currentState.reviewingSessions),
        [activeSessionId]: true,
      }
      // Update TanStack Query cache immediately to prevent timing gap
      // where persistedWaitingForInput keeps status as "waiting"
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(activeSessionId),
        old =>
          old
            ? {
                ...old,
                waiting_for_input: false,
                is_reviewing: true,
                waiting_for_input_type: null,
              }
            : old
      )
      if (effectiveWorktreeId) {
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(effectiveWorktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === activeSessionId
                  ? {
                      ...s,
                      waiting_for_input: false,
                      is_reviewing: true,
                      waiting_for_input_type: null,
                    }
                  : s
              ),
            }
          }
        )
      }
      // Persist the transition to disk
      if (effectiveWorktreeId && effectiveWorktreePath) {
        updateSessionState({
          worktreeId: effectiveWorktreeId,
          worktreePath: effectiveWorktreePath,
          sessionId: activeSessionId,
          isReviewing: true,
          waitingForInput: false,
          waitingForInputType: null,
        })
      }
    }

    // Apply all updates at once
    if (Object.keys(updates).length > 0) {
      useChatStore.setState(updates)
    }

    // Store initial state as last saved to avoid immediate re-save
    lastSavedStateRef.current = getCurrentSessionState(activeSessionId)

    // Allow saves after a short delay
    setTimeout(() => {
      isLoadingRef.current = false
    }, 100)

    logger.debug('Session state loaded', { sessionId: activeSessionId })
  }, [activeSessionId, sessionsData, getCurrentSessionState])

  // Auto-transition plan-waiting codex/opencode sessions to review when viewed.
  // This runs independently of the load effect and is NOT blocked by loadedSessionRef,
  // handling cases where the session was already loaded when it entered plan-waiting.
  useEffect(() => {
    if (
      !activeSessionId ||
      !sessionsData ||
      !effectiveWorktreeId ||
      !effectiveWorktreePath
    )
      return

    const session = sessionsData.sessions.find(s => s.id === activeSessionId)
    if (!session) return

    // Only for non-claude sessions in plan-waiting state
    if (
      !session.waiting_for_input ||
      session.waiting_for_input_type !== 'plan' ||
      session.backend === 'claude'
    )
      return

    // Guard: if Zustand already shows review + not waiting, skip (prevents loops)
    const state = useChatStore.getState()
    if (
      (state.reviewingSessions[activeSessionId] ?? false) &&
      !(state.waitingForInputSessionIds[activeSessionId] ?? false)
    )
      return

    // Transition Zustand state
    useChatStore.setState({
      waitingForInputSessionIds: {
        ...state.waitingForInputSessionIds,
        [activeSessionId]: false,
      },
      reviewingSessions: {
        ...state.reviewingSessions,
        [activeSessionId]: true,
      },
    })

    // Update TanStack Query cache immediately to prevent timing gap
    queryClient.setQueryData<Session>(
      chatQueryKeys.session(activeSessionId),
      old =>
        old
          ? {
              ...old,
              waiting_for_input: false,
              is_reviewing: true,
              waiting_for_input_type: null,
            }
          : old
    )
    queryClient.setQueryData<WorktreeSessions>(
      chatQueryKeys.sessions(effectiveWorktreeId),
      old => {
        if (!old) return old
        return {
          ...old,
          sessions: old.sessions.map(s =>
            s.id === activeSessionId
              ? {
                  ...s,
                  waiting_for_input: false,
                  is_reviewing: true,
                  waiting_for_input_type: null,
                }
              : s
          ),
        }
      }
    )

    // Persist to disk
    updateSessionState({
      worktreeId: effectiveWorktreeId,
      worktreePath: effectiveWorktreePath,
      sessionId: activeSessionId,
      isReviewing: true,
      waitingForInput: false,
      waitingForInputType: null,
    })
  }, [
    activeSessionId,
    sessionsData,
    effectiveWorktreeId,
    effectiveWorktreePath,
    updateSessionState,
    queryClient,
  ])

  // Subscribe to Zustand changes and save to session file
  useEffect(() => {
    if (!activeSessionId || !effectiveWorktreeId || !effectiveWorktreePath) {
      return
    }

    const sessionId = activeSessionId

    // Track previous values
    let prevAnsweredQuestions =
      useChatStore.getState().answeredQuestions[sessionId]
    let prevSubmittedAnswers =
      useChatStore.getState().submittedAnswers[sessionId]
    let prevFixedFindings = useChatStore.getState().fixedFindings[sessionId]
    let prevPendingDenials =
      useChatStore.getState().pendingPermissionDenials[sessionId]
    let prevDeniedContext =
      useChatStore.getState().deniedMessageContext[sessionId]
    let prevReviewing = useChatStore.getState().reviewingSessions[sessionId]
    let prevWaiting =
      useChatStore.getState().waitingForInputSessionIds[sessionId]
    let prevPlanFilePath = useChatStore.getState().planFilePaths[sessionId]
    let prevPendingPlanMessageId =
      useChatStore.getState().pendingPlanMessageIds[sessionId]
    let prevEnabledMcpServers =
      useChatStore.getState().enabledMcpServers[sessionId]
    let prevExecutionMode = useChatStore.getState().executionModes[sessionId]

    const unsubscribe = useChatStore.subscribe(state => {
      if (isLoadingRef.current) return

      const currentAnswered = state.answeredQuestions[sessionId]
      const currentSubmitted = state.submittedAnswers[sessionId]
      const currentFixed = state.fixedFindings[sessionId]
      const currentDenials = state.pendingPermissionDenials[sessionId]
      const currentDeniedCtx = state.deniedMessageContext[sessionId]
      const currentReviewing = state.reviewingSessions[sessionId]
      const currentWaiting = state.waitingForInputSessionIds[sessionId]
      const currentPlanFilePath = state.planFilePaths[sessionId]
      const currentPendingPlanMessageId = state.pendingPlanMessageIds[sessionId]
      const currentEnabledMcpServers = state.enabledMcpServers[sessionId]
      const currentExecutionMode = state.executionModes[sessionId]

      const hasChanges =
        currentAnswered !== prevAnsweredQuestions ||
        currentSubmitted !== prevSubmittedAnswers ||
        currentFixed !== prevFixedFindings ||
        currentDenials !== prevPendingDenials ||
        currentDeniedCtx !== prevDeniedContext ||
        currentReviewing !== prevReviewing ||
        currentWaiting !== prevWaiting ||
        currentPlanFilePath !== prevPlanFilePath ||
        currentPendingPlanMessageId !== prevPendingPlanMessageId ||
        currentEnabledMcpServers !== prevEnabledMcpServers ||
        currentExecutionMode !== prevExecutionMode

      if (hasChanges) {
        prevAnsweredQuestions = currentAnswered
        prevSubmittedAnswers = currentSubmitted
        prevFixedFindings = currentFixed
        prevPendingDenials = currentDenials
        prevDeniedContext = currentDeniedCtx
        prevReviewing = currentReviewing
        prevWaiting = currentWaiting
        prevPlanFilePath = currentPlanFilePath
        prevPendingPlanMessageId = currentPendingPlanMessageId
        prevEnabledMcpServers = currentEnabledMcpServers
        prevExecutionMode = currentExecutionMode

        const currentState = getCurrentSessionState(sessionId)
        debouncedSaveRef.current?.(currentState)
      }
    })

    return () => {
      unsubscribe()
      debouncedSaveRef.current?.cancel()
    }
  }, [
    activeSessionId,
    effectiveWorktreeId,
    effectiveWorktreePath,
    getCurrentSessionState,
  ])
}
