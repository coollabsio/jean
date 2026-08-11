import { useEffect, useRef, useCallback, useMemo } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useUpdateSessionState, useSessions } from '@/services/chat'
import { sessionCanBeWaiting } from '@/components/chat/session-card-utils'
import { logger } from '@/lib/logger'
import {
  beginSessionStateHydration,
  endSessionStateHydration,
} from '@/lib/session-state-hydration'
import type {
  QuestionAnswer,
  PermissionDenial,
  CodexCommandApprovalRequest,
  CodexPermissionRequest,
  OpenCodePermissionRequest,
  CodexUserInputRequest,
  CodexMcpElicitationRequest,
  CodexDynamicToolCallRequest,
  ExecutionMode,
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
  pendingCodexCommandApprovalRequests: CodexCommandApprovalRequest[]
  pendingCodexPermissionRequests: CodexPermissionRequest[]
  pendingOpencodePermissionRequests: OpenCodePermissionRequest[]
  pendingCodexUserInputRequests: CodexUserInputRequest[]
  pendingCodexMcpElicitationRequests: CodexMcpElicitationRequest[]
  pendingCodexDynamicToolCallRequests: CodexDynamicToolCallRequest[]
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
  tableCheckedRows: Record<string, number[]>
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
  // Track modal worktree id so canvas-modal sessions still get persistence.
  const modalWorktreeId = useUIStore(state =>
    state.sessionChatModalOpen ? state.sessionChatModalWorktreeId : null
  )
  const activeSessionId = useChatStore(state => {
    const worktreeId = state.activeWorktreeId ?? modalWorktreeId
    if (worktreeId) {
      return state.activeSessionIds[worktreeId] ?? null
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
    const wtId =
      activeWorktreeId ??
      modalWorktreeId ??
      sessionWorktreeMap[activeSessionId] ??
      null
    const wtPath =
      (activeWorktreeId ? activeWorktreePath : null) ??
      (wtId ? (worktreePaths[wtId] ?? null) : null)
    return { effectiveWorktreeId: wtId, effectiveWorktreePath: wtPath }
  }, [activeSessionId, modalWorktreeId])

  // Load sessions to get session data
  const { data: sessionsData } = useSessions(
    effectiveWorktreeId,
    effectiveWorktreePath
  )

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
        fixedReviewFindings,
        pendingPermissionDenials,
        pendingCodexCommandApprovalRequests,
        pendingCodexPermissionRequests,
        pendingOpencodePermissionRequests,
        pendingCodexUserInputRequests,
        pendingCodexMcpElicitationRequests,
        pendingCodexDynamicToolCallRequests,
        deniedMessageContext,
        reviewingSessions,
        waitingForInputSessionIds,
        planFilePaths,
        pendingPlanMessageIds,
        enabledMcpServers,
        executionModes,
        tableCheckedRows,
      } = useChatStore.getState()

      const ctx = deniedMessageContext[sessionId]
      const combinedFixedFindings = new Set([
        ...(fixedFindings[sessionId] ?? new Set()),
        ...(fixedReviewFindings[sessionId] ?? new Set()),
      ])

      return {
        answeredQuestions: Array.from(
          answeredQuestions[sessionId] ?? new Set()
        ),
        submittedAnswers: submittedAnswers[sessionId] ?? {},
        fixedFindings: Array.from(combinedFixedFindings),
        pendingPermissionDenials: pendingPermissionDenials[sessionId] ?? [],
        pendingCodexCommandApprovalRequests:
          pendingCodexCommandApprovalRequests[sessionId] ?? [],
        pendingCodexPermissionRequests:
          pendingCodexPermissionRequests[sessionId] ?? [],
        pendingOpencodePermissionRequests:
          pendingOpencodePermissionRequests[sessionId] ?? [],
        pendingCodexUserInputRequests:
          pendingCodexUserInputRequests[sessionId] ?? [],
        pendingCodexMcpElicitationRequests:
          pendingCodexMcpElicitationRequests[sessionId] ?? [],
        pendingCodexDynamicToolCallRequests:
          pendingCodexDynamicToolCallRequests[sessionId] ?? [],
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
        tableCheckedRows: Object.fromEntries(
          Object.entries(tableCheckedRows[sessionId] ?? {}).map(
            ([key, set]) => [key, Array.from(set).sort((a, b) => a - b)]
          )
        ),
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
        pendingCodexCommandApprovalRequests:
          state.pendingCodexCommandApprovalRequests,
        pendingCodexPermissionRequests: state.pendingCodexPermissionRequests,
        pendingOpencodePermissionRequests:
          state.pendingOpencodePermissionRequests,
        pendingCodexUserInputRequests: state.pendingCodexUserInputRequests,
        pendingCodexMcpElicitationRequests:
          state.pendingCodexMcpElicitationRequests,
        pendingCodexDynamicToolCallRequests:
          state.pendingCodexDynamicToolCallRequests,
        deniedMessageContext: state.deniedMessageContext,
        isReviewing: state.isReviewing,
        // Only persist waitingForInput when clearing it (user approval action).
        // Setting it to true is handled by useStreamingEvents' chat:done handler
        // which persists directly via invoke(). Persisting true here risks
        // cross-client overwrites: native client's pauseSession sets true in its
        // Zustand, then this debounced save writes it to disk after web cleared it.
        waitingForInput: state.waitingForInput
          ? undefined
          : state.waitingForInput,
        planFilePath: state.planFilePath,
        pendingPlanMessageId: state.pendingPlanMessageId,
        enabledMcpServers: state.enabledMcpServers,
        selectedExecutionMode: state.selectedExecutionMode,
        tableCheckedRows: state.tableCheckedRows,
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
    let loadingUnlockTimer: ReturnType<typeof setTimeout> | null = null

    if (!activeSessionId || !sessionsData) {
      return () => {
        if (loadingUnlockTimer != null) clearTimeout(loadingUnlockTimer)
      }
    }

    const session = sessionsData.sessions.find(s => s.id === activeSessionId)
    if (!session) {
      return () => {
        if (loadingUnlockTimer != null) clearTimeout(loadingUnlockTimer)
      }
    }

    // Always resync authoritative status fields from backend refetches.
    // Other session UI state is loaded once below to avoid overwriting local edits,
    // but waiting/reviewing must track remote web/mobile completion immediately.
    const statusCurrentState = useChatStore.getState()
    const statusUpdates: Partial<typeof statusCurrentState> = {}
    const effectiveWaiting =
      sessionCanBeWaiting(session) && (session.waiting_for_input ?? false)
    const statusCurrentWaiting =
      statusCurrentState.waitingForInputSessionIds[activeSessionId] ?? false
    if (statusCurrentWaiting !== effectiveWaiting) {
      statusUpdates.waitingForInputSessionIds = {
        ...statusCurrentState.waitingForInputSessionIds,
        [activeSessionId]: effectiveWaiting,
      }
    }

    const effectiveReviewing = session.is_reviewing ?? false
    const statusCurrentReviewing =
      statusCurrentState.reviewingSessions[activeSessionId] ?? false
    if (statusCurrentReviewing !== effectiveReviewing) {
      statusUpdates.reviewingSessions = {
        ...statusCurrentState.reviewingSessions,
        [activeSessionId]: effectiveReviewing,
      }
    }

    if (
      session.review_results &&
      statusCurrentState.reviewResults[activeSessionId] !==
        session.review_results
    ) {
      statusUpdates.reviewResults = {
        ...statusCurrentState.reviewResults,
        [activeSessionId]: session.review_results,
      }
      statusUpdates.reviewSidebarVisible = true
    }

    if (Object.keys(statusUpdates).length > 0) {
      beginSessionStateHydration()
      try {
        useChatStore.setState(statusUpdates)
      } finally {
        endSessionStateHydration()
      }
    }

    // Only load from disk when switching to a new session.
    // Re-loading on every sessionsData refetch would overwrite in-memory
    // Zustand state with stale on-disk data (due to 500ms debounced saves),
    // causing answered questions / fixed findings to flicker.
    if (loadedSessionRef.current !== activeSessionId) {
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

      if (
        session.pending_codex_command_approval_requests &&
        session.pending_codex_command_approval_requests.length > 0
      ) {
        updates.pendingCodexCommandApprovalRequests = {
          ...currentState.pendingCodexCommandApprovalRequests,
          [activeSessionId]: session.pending_codex_command_approval_requests,
        }
      }

      if (
        session.pending_codex_permission_requests &&
        session.pending_codex_permission_requests.length > 0
      ) {
        updates.pendingCodexPermissionRequests = {
          ...currentState.pendingCodexPermissionRequests,
          [activeSessionId]: session.pending_codex_permission_requests,
        }
      }

      if (
        session.pending_opencode_permission_requests &&
        session.pending_opencode_permission_requests.length > 0
      ) {
        updates.pendingOpencodePermissionRequests = {
          ...currentState.pendingOpencodePermissionRequests,
          [activeSessionId]: session.pending_opencode_permission_requests,
        }
      }

      if (
        session.pending_codex_user_input_requests &&
        session.pending_codex_user_input_requests.length > 0
      ) {
        updates.pendingCodexUserInputRequests = {
          ...currentState.pendingCodexUserInputRequests,
          [activeSessionId]: session.pending_codex_user_input_requests,
        }
      }

      if (
        session.pending_codex_mcp_elicitation_requests &&
        session.pending_codex_mcp_elicitation_requests.length > 0
      ) {
        updates.pendingCodexMcpElicitationRequests = {
          ...currentState.pendingCodexMcpElicitationRequests,
          [activeSessionId]: session.pending_codex_mcp_elicitation_requests,
        }
      }

      if (
        session.pending_codex_dynamic_tool_call_requests &&
        session.pending_codex_dynamic_tool_call_requests.length > 0
      ) {
        updates.pendingCodexDynamicToolCallRequests = {
          ...currentState.pendingCodexDynamicToolCallRequests,
          [activeSessionId]: session.pending_codex_dynamic_tool_call_requests,
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
      const waitingForInput =
        sessionCanBeWaiting(session) && (session.waiting_for_input ?? false)
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

      // Load per-table checklist state (tableKey -> Set of checked row indices)
      if (
        session.table_checked_rows &&
        Object.keys(session.table_checked_rows).length > 0
      ) {
        const hydrated: Record<string, Set<number>> = {}
        for (const [tableKey, rows] of Object.entries(
          session.table_checked_rows
        )) {
          hydrated[tableKey] = new Set(rows)
        }
        updates.tableCheckedRows = {
          ...currentState.tableCheckedRows,
          [activeSessionId]: hydrated,
        }
      }

      // Hydrate the initial queue after startup/reconnect. Live queue:updated
      // events remain authoritative once this session has a local queue entry;
      // this guard prevents a later stale query result from overwriting them.
      if (!(activeSessionId in currentState.messageQueues)) {
        updates.messageQueues = {
          ...currentState.messageQueues,
          [activeSessionId]: session.queued_messages ?? [],
        }
      }

      // Apply all updates at once
      if (Object.keys(updates).length > 0) {
        useChatStore.setState(updates)
      }

      // Store initial state as last saved to avoid immediate re-save
      lastSavedStateRef.current = getCurrentSessionState(activeSessionId)

      // Allow saves after a short delay — clear on unmount / re-run so a
      // superseded load cannot unlock isLoadingRef after a newer session started.
      loadingUnlockTimer = setTimeout(() => {
        isLoadingRef.current = false
        loadingUnlockTimer = null
      }, 100)

      logger.debug('Session state loaded', { sessionId: activeSessionId })
    }

    return () => {
      if (loadingUnlockTimer != null) {
        clearTimeout(loadingUnlockTimer)
        loadingUnlockTimer = null
        // Don't leave the load-guard stuck if this effect re-ran (e.g. sessionsData
        // refetch) before the timer fired; a subsequent full load sets it again.
        isLoadingRef.current = false
      }
    }
  }, [activeSessionId, sessionsData, getCurrentSessionState])
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
    let prevFixedReviewFindings =
      useChatStore.getState().fixedReviewFindings[sessionId]
    let prevPendingDenials =
      useChatStore.getState().pendingPermissionDenials[sessionId]
    let prevPendingCodexCommandApprovalRequests =
      useChatStore.getState().pendingCodexCommandApprovalRequests[sessionId]
    let prevPendingCodexPermissionRequests =
      useChatStore.getState().pendingCodexPermissionRequests[sessionId]
    let prevPendingOpencodePermissionRequests =
      useChatStore.getState().pendingOpencodePermissionRequests[sessionId]
    let prevPendingCodexUserInputRequests =
      useChatStore.getState().pendingCodexUserInputRequests[sessionId]
    let prevPendingCodexMcpElicitations =
      useChatStore.getState().pendingCodexMcpElicitationRequests[sessionId]
    let prevPendingCodexDynamicToolCalls =
      useChatStore.getState().pendingCodexDynamicToolCallRequests[sessionId]
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
    let prevTableCheckedRows =
      useChatStore.getState().tableCheckedRows[sessionId]

    const unsubscribe = useChatStore.subscribe(state => {
      if (isLoadingRef.current) return

      const currentAnswered = state.answeredQuestions[sessionId]
      const currentSubmitted = state.submittedAnswers[sessionId]
      const currentFixed = state.fixedFindings[sessionId]
      const currentFixedReview = state.fixedReviewFindings[sessionId]
      const currentDenials = state.pendingPermissionDenials[sessionId]
      const currentCodexCommandApprovalRequests =
        state.pendingCodexCommandApprovalRequests[sessionId]
      const currentCodexPermissionRequests =
        state.pendingCodexPermissionRequests[sessionId]
      const currentOpencodePermissionRequests =
        state.pendingOpencodePermissionRequests[sessionId]
      const currentCodexUserInputRequests =
        state.pendingCodexUserInputRequests[sessionId]
      const currentCodexMcpElicitations =
        state.pendingCodexMcpElicitationRequests[sessionId]
      const currentCodexDynamicToolCalls =
        state.pendingCodexDynamicToolCallRequests[sessionId]
      const currentDeniedCtx = state.deniedMessageContext[sessionId]
      const currentReviewing = state.reviewingSessions[sessionId]
      const currentWaiting = state.waitingForInputSessionIds[sessionId]
      const currentPlanFilePath = state.planFilePaths[sessionId]
      const currentPendingPlanMessageId = state.pendingPlanMessageIds[sessionId]
      const currentEnabledMcpServers = state.enabledMcpServers[sessionId]
      const currentExecutionMode = state.executionModes[sessionId]
      const currentTableCheckedRows = state.tableCheckedRows[sessionId]

      const hasChanges =
        currentAnswered !== prevAnsweredQuestions ||
        currentSubmitted !== prevSubmittedAnswers ||
        currentFixed !== prevFixedFindings ||
        currentFixedReview !== prevFixedReviewFindings ||
        currentDenials !== prevPendingDenials ||
        currentCodexCommandApprovalRequests !==
          prevPendingCodexCommandApprovalRequests ||
        currentCodexPermissionRequests !== prevPendingCodexPermissionRequests ||
        currentOpencodePermissionRequests !==
          prevPendingOpencodePermissionRequests ||
        currentCodexUserInputRequests !== prevPendingCodexUserInputRequests ||
        currentCodexMcpElicitations !== prevPendingCodexMcpElicitations ||
        currentCodexDynamicToolCalls !== prevPendingCodexDynamicToolCalls ||
        currentDeniedCtx !== prevDeniedContext ||
        currentReviewing !== prevReviewing ||
        currentWaiting !== prevWaiting ||
        currentPlanFilePath !== prevPlanFilePath ||
        currentPendingPlanMessageId !== prevPendingPlanMessageId ||
        currentEnabledMcpServers !== prevEnabledMcpServers ||
        currentExecutionMode !== prevExecutionMode ||
        currentTableCheckedRows !== prevTableCheckedRows

      if (hasChanges) {
        prevAnsweredQuestions = currentAnswered
        prevSubmittedAnswers = currentSubmitted
        prevFixedFindings = currentFixed
        prevFixedReviewFindings = currentFixedReview
        prevPendingDenials = currentDenials
        prevPendingCodexCommandApprovalRequests =
          currentCodexCommandApprovalRequests
        prevPendingCodexPermissionRequests = currentCodexPermissionRequests
        prevPendingOpencodePermissionRequests =
          currentOpencodePermissionRequests
        prevPendingCodexUserInputRequests = currentCodexUserInputRequests
        prevPendingCodexMcpElicitations = currentCodexMcpElicitations
        prevPendingCodexDynamicToolCalls = currentCodexDynamicToolCalls
        prevDeniedContext = currentDeniedCtx
        prevReviewing = currentReviewing
        prevWaiting = currentWaiting
        prevPlanFilePath = currentPlanFilePath
        prevPendingPlanMessageId = currentPendingPlanMessageId
        prevEnabledMcpServers = currentEnabledMcpServers
        prevExecutionMode = currentExecutionMode
        prevTableCheckedRows = currentTableCheckedRows

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
