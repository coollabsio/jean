import { useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { generateId } from '@/lib/uuid'
import {
  beginSessionStateHydration,
  endSessionStateHydration,
} from '@/lib/session-state-hydration'
import type {
  AllSessionsResponse,
  ArchivedSessionEntry,
  ChatMessage,
  ChatHistory,
  Session,
  WorktreeSessions,
  Question,
  QuestionAnswer,
  ThinkingLevel,
  ExecutionMode,
  LabelData,
  QueuedMessage,
} from '@/types/chat'
import { isTauri, projectsQueryKeys } from '@/services/projects'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { ReviewResponse, Worktree } from '@/types/projects'

// Query keys for chat
export const chatQueryKeys = {
  all: ['chat'] as const,
  // Legacy: worktree-based history
  history: (worktreeId: string) =>
    [...chatQueryKeys.all, 'history', worktreeId] as const,
  // New: session-based queries
  sessions: (worktreeId: string) =>
    [...chatQueryKeys.all, 'sessions', worktreeId] as const,
  session: (sessionId: string) =>
    [...chatQueryKeys.all, 'session', sessionId] as const,
}

// ============================================================================
// Chat Queries
// ============================================================================

/**
 * Hook to get chat history for a worktree
 */
export function useChatHistory(
  worktreeId: string | null,
  worktreePath: string | null
) {
  return useQuery({
    queryKey: chatQueryKeys.history(worktreeId ?? ''),
    queryFn: async (): Promise<ChatHistory> => {
      if (!isTauri() || !worktreeId || !worktreePath) {
        return { worktree_id: '', messages: [] }
      }

      try {
        logger.debug('Loading chat history', { worktreeId })
        const history = await invoke<ChatHistory>('get_chat_history', {
          worktreeId,
          worktreePath,
        })
        logger.info('Chat history loaded', { count: history.messages.length })
        return history
      } catch (error) {
        logger.error('Failed to load chat history', { error, worktreeId })
        return { worktree_id: worktreeId, messages: [] }
      }
    },
    enabled: !!worktreeId && !!worktreePath,
    staleTime: 0, // Always refetch after mutations
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

// ============================================================================
// Session Queries (new multi-tab support)
// ============================================================================

/**
 * Hook to get all sessions for a worktree (for tab bar display)
 */
export function useSessions(
  worktreeId: string | null,
  worktreePath: string | null,
  options?: { includeMessageCounts?: boolean }
) {
  const includeMessageCounts = options?.includeMessageCounts ?? false

  return useQuery({
    queryKey: includeMessageCounts
      ? [...chatQueryKeys.sessions(worktreeId ?? ''), 'with-counts']
      : chatQueryKeys.sessions(worktreeId ?? ''),
    queryFn: async (): Promise<WorktreeSessions> => {
      if (!isTauri() || !worktreeId || !worktreePath) {
        return {
          worktree_id: '',
          sessions: [],
          active_session_id: null,
          version: 2,
        }
      }

      try {
        logger.debug('Loading sessions', { worktreeId, includeMessageCounts })
        const sessions = await invoke<WorktreeSessions>('get_sessions', {
          worktreeId,
          worktreePath,
          includeMessageCounts,
        })
        logger.info('Sessions loaded', { count: sessions.sessions.length })
        return sessions
      } catch (error) {
        logger.error('Failed to load sessions', { error, worktreeId })
        return {
          worktree_id: worktreeId,
          sessions: [],
          active_session_id: null,
          version: 2,
        }
      }
    },
    enabled: !!worktreeId && !!worktreePath,
    staleTime: 1000 * 60 * 5, // 5 minutes - enables instant tab bar rendering from cache
    gcTime: 1000 * 60 * 5,
    refetchOnMount: true, // Respects staleTime; status changes pushed via streaming/cache:invalidate events
  })
}

/**
 * Prefetch sessions for a worktree (for startup loading).
 * This populates the query cache so indicators show immediately.
 * Also restores reviewingSessions and waitingForInputSessionIds state.
 */
export async function prefetchSessions(
  queryClient: ReturnType<typeof useQueryClient>,
  worktreeId: string,
  worktreePath: string
): Promise<void> {
  if (!isTauri()) return

  try {
    const sessions = await invoke<WorktreeSessions>('get_sessions', {
      worktreeId,
      worktreePath,
    })
    queryClient.setQueryData(chatQueryKeys.sessions(worktreeId), sessions)

    // Restore reviewingSessions, waitingForInputSessionIds, sessionLabels, reviewResults,
    // fixedFindings, and selected execution modes.
    const reviewingUpdates: Record<string, boolean> = {}
    const waitingUpdates: Record<string, boolean> = {}
    const executionModeUpdates: Record<string, ExecutionMode> = {}
    const labelUpdates: Record<string, LabelData> = {}
    const reviewResultsUpdates: Record<string, ReviewResponse> = {}
    const fixedFindingsUpdates: Record<string, Set<string>> = {}
    for (const session of sessions.sessions) {
      if (session.is_reviewing) {
        reviewingUpdates[session.id] = true
      }
      // Only restore waiting state if the session's last run is actually active,
      // OR if it's a completed plan-mode run (Codex/Opencode plan mode intentionally
      // sets waiting_for_input after the run completes)
      const canBeWaiting =
        !session.last_run_status ||
        session.last_run_status === 'running' ||
        session.last_run_status === 'resumable' ||
        (session.last_run_status === 'completed' &&
          session.waiting_for_input_type === 'plan')
      if (session.waiting_for_input && canBeWaiting) {
        waitingUpdates[session.id] = true
      }
      if (session.selected_execution_mode) {
        executionModeUpdates[session.id] = session.selected_execution_mode
      }
      if (session.label) {
        labelUpdates[session.id] = session.label
      }
      if (session.review_results) {
        reviewResultsUpdates[session.id] = session.review_results
      }
      if (session.fixed_findings && session.fixed_findings.length > 0) {
        fixedFindingsUpdates[session.id] = new Set(session.fixed_findings)
      }
    }

    // Register all sessions in sessionWorktreeMap for immediate persistence
    // This ensures useImmediateSessionStateSave can find the worktreeId for any session
    const sessionMappings: Record<string, string> = {}
    for (const session of sessions.sessions) {
      sessionMappings[session.id] = worktreeId
    }

    const currentState = useChatStore.getState()
    const storeUpdates: Partial<ReturnType<typeof useChatStore.getState>> = {}

    // Always register session mappings and worktree path
    if (Object.keys(sessionMappings).length > 0) {
      storeUpdates.sessionWorktreeMap = {
        ...currentState.sessionWorktreeMap,
        ...sessionMappings,
      }
      storeUpdates.worktreePaths = {
        ...currentState.worktreePaths,
        [worktreeId]: worktreePath,
      }
    }

    if (Object.keys(reviewingUpdates).length > 0) {
      storeUpdates.reviewingSessions = {
        ...currentState.reviewingSessions,
        ...reviewingUpdates,
      }
    }
    if (Object.keys(waitingUpdates).length > 0) {
      storeUpdates.waitingForInputSessionIds = {
        ...currentState.waitingForInputSessionIds,
        ...waitingUpdates,
      }
    }
    if (Object.keys(executionModeUpdates).length > 0) {
      storeUpdates.executionModes = {
        ...currentState.executionModes,
        ...executionModeUpdates,
      }
    }
    if (Object.keys(labelUpdates).length > 0) {
      storeUpdates.sessionLabels = {
        ...currentState.sessionLabels,
        ...labelUpdates,
      }
    }
    if (Object.keys(reviewResultsUpdates).length > 0) {
      storeUpdates.reviewResults = {
        ...currentState.reviewResults,
        ...reviewResultsUpdates,
      }
    }
    if (Object.keys(fixedFindingsUpdates).length > 0) {
      storeUpdates.fixedReviewFindings = {
        ...currentState.fixedReviewFindings,
        ...fixedFindingsUpdates,
      }
    }
    if (Object.keys(storeUpdates).length > 0) {
      beginSessionStateHydration()
      try {
        useChatStore.setState(storeUpdates)
      } finally {
        endSessionStateHydration()
      }
    }

    logger.debug('Prefetched sessions', {
      worktreeId,
      count: sessions.sessions.length,
    })
  } catch (error) {
    logger.warn('Failed to prefetch sessions', { error, worktreeId })
  }
}

/**
 * Hook to get all sessions across all worktrees and projects
 * Used by Load Context modal to show sessions from anywhere
 */
export function useAllSessions(enabled = true) {
  return useQuery({
    queryKey: ['all-sessions'],
    queryFn: async (): Promise<AllSessionsResponse> => {
      try {
        logger.debug('Loading all sessions')
        const response = await invoke<AllSessionsResponse>('list_all_sessions')
        logger.info('All sessions loaded', {
          entryCount: response.entries.length,
        })
        return response
      } catch (error) {
        logger.error('Failed to load all sessions', { error })
        return { entries: [] }
      }
    },
    enabled,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 5,
  })
}

/**
 * Hook to get a single session with full message history
 */
export function useSession(
  sessionId: string | null,
  worktreeId: string | null,
  worktreePath: string | null
) {
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: chatQueryKeys.session(sessionId ?? ''),
    queryFn: async (): Promise<Session | null> => {
      if (!isTauri() || !sessionId || !worktreeId || !worktreePath) {
        return null
      }

      try {
        logger.debug('[useSession] fetching from disk', { sessionId })
        const session = await invoke<Session>('get_session', {
          worktreeId,
          worktreePath,
          sessionId,
        })
        logger.info('[useSession] loaded', {
          sessionId,
          messageCount: session.messages.length,
          backend: session.backend,
        })

        // Preserve optimistic messages from sendMessage.onMutate that the
        // backend hasn't persisted yet (race: refetchOnMount fires before
        // the send_chat_message invoke writes the user message to disk).
        const cached = queryClient.getQueryData<Session>(
          chatQueryKeys.session(sessionId)
        )
        if (cached && cached.messages.length > session.messages.length) {
          logger.warn(
            '[useSession] preserving cached messages over fresh fetch',
            {
              sessionId,
              cachedCount: cached.messages.length,
              diskCount: session.messages.length,
            }
          )
          return { ...session, messages: cached.messages }
        }

        return session
      } catch (error) {
        logger.warn('[useSession] FAILED to load session', { error, sessionId })
        return null
      }
    },
    enabled: !!sessionId && !!worktreeId && !!worktreePath,
    staleTime: 1000 * 60 * 5, // 5 minutes - enables instant session switching from cache
    gcTime: 1000 * 60 * 5,
    // Respects staleTime; cross-client sync handled by cache:invalidate broadcast
    // from Rust after send_chat_message completes (JSONL fully written).
    refetchOnMount: true,
  })
}

// ============================================================================
// Session Mutations
// ============================================================================

/**
 * Hook to create a new session tab
 */
export function useCreateSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      name,
    }: {
      worktreeId: string
      worktreePath: string
      name?: string
    }): Promise<Session> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating session', { worktreeId, name })
      const session = await invoke<Session>('create_session', {
        worktreeId,
        worktreePath,
        name,
      })
      logger.info('Session created', { sessionId: session.id })
      return session
    },
    onSuccess: (newSession, { worktreeId }) => {
      // Pre-populate individual session cache to prevent loading flash for empty sessions
      queryClient.setQueryData(chatQueryKeys.session(newSession.id), newSession)
      // Optimistically update sessions list cache with new session at end (matches backend order)
      queryClient.setQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId),
        old => (old ? { ...old, sessions: [...old.sessions, newSession] } : old)
      )
      // Then invalidate for consistency
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to create session', { error })
      toast.error('Failed to create session', { description: message })
    },
  })
}

/**
 * Hook to rename a session tab
 */
export function useRenameSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      newName,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      newName: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Renaming session', { sessionId, newName })
      await invoke('rename_session', {
        worktreeId,
        worktreePath,
        sessionId,
        newName,
      })
      logger.info('Session renamed')
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to rename session', { error })
      toast.error('Failed to rename session', { description: message })
    },
  })
}

/**
 * Hook to update session-specific UI state
 * Persists answered questions, fixed findings, permission denials, etc. to the session file
 */
export function useUpdateSessionState() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      answeredQuestions,
      submittedAnswers,
      fixedFindings,
      pendingPermissionDenials,
      deniedMessageContext,
      isReviewing,
      waitingForInput,
      waitingForInputType,
      planFilePath,
      pendingPlanMessageId,
      enabledMcpServers,
      selectedExecutionMode,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      answeredQuestions?: string[]
      submittedAnswers?: Record<string, unknown>
      fixedFindings?: string[]
      pendingPermissionDenials?: {
        tool_name: string
        tool_use_id: string
        tool_input: unknown
      }[]
      deniedMessageContext?: {
        message: string
        model: string
        thinking_level: string
      } | null
      isReviewing?: boolean
      waitingForInput?: boolean
      waitingForInputType?: 'question' | 'plan' | null
      planFilePath?: string | null
      pendingPlanMessageId?: string | null
      enabledMcpServers?: string[] | null
      selectedExecutionMode?: ExecutionMode | null
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      await invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        answeredQuestions,
        submittedAnswers,
        fixedFindings,
        pendingPermissionDenials,
        deniedMessageContext,
        isReviewing,
        waitingForInput,
        waitingForInputType,
        planFilePath,
        pendingPlanMessageId,
        enabledMcpServers,
        selectedExecutionMode,
      })
      logger.debug('Session state updated')
    },
    onSuccess: (_, { worktreeId, sessionId }) => {
      // Invalidate session queries to reflect updated state
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
    },
    onError: error => {
      logger.error('Failed to update session state', { error })
      // Don't toast - this is a background operation
    },
  })
}

/**
 * Hook to close/delete a session tab
 * Returns the new active session ID (if any)
 */
export function useCloseSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
    }): Promise<string | null> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Closing session', { sessionId })
      const newActiveId = await invoke<string | null>('close_session', {
        worktreeId,
        worktreePath,
        sessionId,
      })
      logger.info('Session closed', { newActiveId })
      return newActiveId
    },
    onSuccess: (newActiveId, { worktreeId, sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      // Remove the closed session from cache
      queryClient.removeQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })

      // Clear all session-scoped state
      useChatStore.getState().clearSessionState(sessionId)

      // Switch to the new active session so the UI doesn't show a blank screen
      if (newActiveId) {
        useChatStore.getState().setActiveSession(worktreeId, newActiveId)
      }
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to close session', { error })
      toast.error('Failed to close session', { description: message })
    },
  })
}

/**
 * Hook to archive a session tab (hide from UI but keep messages)
 * Returns the new active session ID (if any)
 */
export function useArchiveSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
    }): Promise<string | null> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Archiving session', { sessionId })
      const newActiveId = await invoke<string | null>('archive_session', {
        worktreeId,
        worktreePath,
        sessionId,
      })
      logger.info('Session archived', { newActiveId })
      return newActiveId
    },
    onSuccess: (newActiveId, { worktreeId, sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      // Invalidate archived sessions query so it shows up immediately
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      // Clear all session-scoped state
      useChatStore.getState().clearSessionState(sessionId)

      // Switch to the new active session so the UI doesn't show a blank screen
      if (newActiveId) {
        useChatStore.getState().setActiveSession(worktreeId, newActiveId)
      }
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to archive session', { error })
      toast.error('Failed to archive session', { description: message })
    },
  })
}

/**
 * Hook to unarchive a session (restore it to the session list)
 */
export function useUnarchiveSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
    }): Promise<Session> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Unarchiving session', { sessionId })
      const session = await invoke<Session>('unarchive_session', {
        worktreeId,
        worktreePath,
        sessionId,
      })
      logger.info('Session unarchived', { sessionId })
      return session
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      toast.success('Session restored')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to unarchive session', { error })
      toast.error('Failed to restore session', { description: message })
    },
  })
}

/** Response from restore_session_with_base */
interface RestoreSessionWithBaseResponse {
  session: Session
  worktree: Worktree
}

/**
 * Hook to restore a session, recreating the base session if needed
 *
 * This handles the case where a session belongs to a closed base session.
 * It will recreate the base session and migrate all sessions to it.
 */
export function useRestoreSessionWithBase() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      projectId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      projectId: string
    }): Promise<RestoreSessionWithBaseResponse> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Restoring session with base', { sessionId, projectId })
      const response = await invoke<RestoreSessionWithBaseResponse>(
        'restore_session_with_base',
        {
          worktreeId,
          worktreePath,
          sessionId,
          projectId,
        }
      )
      logger.info('Session restored with base', {
        sessionId,
        worktreeId: response.worktree.id,
      })
      return response
    },
    onSuccess: (response, { worktreeId }) => {
      // Invalidate queries for both old and new worktree IDs
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      if (response.worktree.id !== worktreeId) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(response.worktree.id),
        })
      }
      // Invalidate worktrees to show the restored base session
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(response.worktree.project_id),
      })
      toast.success('Session restored')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to restore session with base', { error })
      toast.error('Failed to restore session', { description: message })
    },
  })
}

/**
 * Hook to permanently delete an archived session
 */
export function useDeleteArchivedSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Deleting archived session', { sessionId })
      await invoke('delete_archived_session', {
        worktreeId,
        worktreePath,
        sessionId,
      })
      logger.info('Archived session deleted', { sessionId })
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      toast.success('Session permanently deleted')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to delete archived session', { error })
      toast.error('Failed to delete session', { description: message })
    },
  })
}

/**
 * Hook to list archived sessions for a worktree
 */
export function useArchivedSessions(
  worktreeId: string | null,
  worktreePath: string | null
) {
  return useQuery({
    queryKey: [...chatQueryKeys.sessions(worktreeId ?? ''), 'archived'],
    queryFn: async (): Promise<Session[]> => {
      if (!isTauri() || !worktreeId || !worktreePath) {
        return []
      }

      logger.debug('Listing archived sessions', { worktreeId })
      const sessions = await invoke<Session[]>('list_archived_sessions', {
        worktreeId,
        worktreePath,
      })
      logger.debug('Got archived sessions', { count: sessions.length })
      return sessions
    },
    enabled: !!worktreeId && !!worktreePath,
    staleTime: 1000 * 60, // 1 minute
  })
}

/**
 * Hook to list all archived sessions across all active worktrees
 */
export function useAllArchivedSessions() {
  return useQuery({
    queryKey: ['all-archived-sessions'],
    queryFn: async (): Promise<ArchivedSessionEntry[]> => {
      if (!isTauri()) {
        return []
      }

      logger.debug('Listing all archived sessions')
      const sessions = await invoke<ArchivedSessionEntry[]>(
        'list_all_archived_sessions'
      )
      logger.debug('Got all archived sessions', { count: sessions.length })
      return sessions
    },
    staleTime: 1000 * 60, // 1 minute
  })
}

/**
 * Hook to handle the CMD+W keybinding for closing session or worktree.
 *
 * Listens for 'close-session-or-worktree' custom event and either:
 * - Removes the current session (archive or delete based on removal_behavior preference)
 * - When closing the last session, navigates to canvas instead of deleting the worktree
 */
export function useCloseSessionOrWorktreeKeybinding(
  onConfirmRequired?: (
    branchName?: string,
    mode?: 'worktree' | 'session'
  ) => void
) {
  const archiveSession = useArchiveSession()
  const closeSession = useCloseSession()
  const queryClient = useQueryClient()

  const executeClose = useCallback(() => {
    const { activeWorktreeId, activeWorktreePath, getActiveSession } =
      useChatStore.getState()

    if (!activeWorktreeId || !activeWorktreePath) {
      logger.warn('Cannot archive session: no active worktree')
      return
    }

    const activeSessionId = getActiveSession(activeWorktreeId)

    if (!activeSessionId) {
      logger.warn('Cannot archive session: no active session')
      return
    }

    // Get sessions for this worktree from cache
    const sessionsData = queryClient.getQueryData<WorktreeSessions>(
      chatQueryKeys.sessions(activeWorktreeId)
    )

    if (!sessionsData) {
      logger.warn('Cannot archive session: no sessions data in cache')
      return
    }

    // Filter to non-archived sessions
    const activeSessions = sessionsData.sessions.filter(s => !s.archived_at)
    const sessionCount = activeSessions.length

    // Read removal behavior preference from cache
    const preferences = queryClient.getQueryData<AppPreferences>(
      preferencesQueryKeys.preferences()
    )
    const shouldDelete = preferences?.removal_behavior === 'delete'

    // Close the current session (archive or delete)
    if (shouldDelete) {
      logger.debug('Deleting session', {
        sessionId: activeSessionId,
        sessionCount,
      })
      closeSession.mutate({
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        sessionId: activeSessionId,
      })
    } else {
      logger.debug('Archiving session', {
        sessionId: activeSessionId,
        sessionCount,
      })
      archiveSession.mutate({
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        sessionId: activeSessionId,
      })
    }

    // Last session: navigate to project view instead of deleting the worktree
    if (sessionCount <= 1) {
      logger.debug('Last session closed, navigating to project view', {
        worktreeId: activeWorktreeId,
      })
      useChatStore.getState().clearActiveWorktree()
    }
  }, [archiveSession, closeSession, queryClient])

  useEffect(() => {
    const handleCloseSessionOrWorktree = () => {
      // Skip when session modal is open — SessionChatModal handles CMD+W in that case
      if (useUIStore.getState().sessionChatModalOpen) return

      // Check if confirmation is required
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      if (preferences?.confirm_session_close !== false && onConfirmRequired) {
        // Find branch name and session count for the dialog
        const { activeWorktreeId } = useChatStore.getState()
        if (activeWorktreeId) {
          const worktreeQueries = queryClient
            .getQueryCache()
            .findAll({ queryKey: [...projectsQueryKeys.all, 'worktrees'] })
          for (const query of worktreeQueries) {
            const worktrees = query.state.data as Worktree[] | undefined
            const found = worktrees?.find(w => w.id === activeWorktreeId)
            if (found) {
              onConfirmRequired(found.branch, 'session')
              return
            }
          }
        }
        onConfirmRequired()
        return
      }

      executeClose()
    }

    window.addEventListener(
      'close-session-or-worktree',
      handleCloseSessionOrWorktree
    )
    return () =>
      window.removeEventListener(
        'close-session-or-worktree',
        handleCloseSessionOrWorktree
      )
  }, [queryClient, onConfirmRequired, executeClose])

  return { executeClose }
}

/**
 * Hook to reorder session tabs
 */
export function useReorderSessions() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionIds,
    }: {
      worktreeId: string
      worktreePath: string
      sessionIds: string[]
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Reordering sessions', { sessionIds })
      await invoke('reorder_sessions', {
        worktreeId,
        worktreePath,
        sessionIds,
      })
      logger.info('Sessions reordered')
    },
    onMutate: async ({ worktreeId, sessionIds }) => {
      // Cancel outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      // Snapshot previous value
      const previousSessions = queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId)
      )

      // Optimistically update the cache with new order
      if (previousSessions) {
        const reorderedSessions = sessionIds
          .map((id, index) => {
            const session = previousSessions.sessions.find(s => s.id === id)
            return session ? { ...session, order: index } : null
          })
          .filter((s): s is Session => s !== null)

        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          {
            ...previousSessions,
            sessions: reorderedSessions,
          }
        )
      }

      return { previousSessions }
    },
    onError: (error, { worktreeId }, context) => {
      // Rollback on error
      if (context?.previousSessions) {
        queryClient.setQueryData(
          chatQueryKeys.sessions(worktreeId),
          context.previousSessions
        )
      }
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to reorder sessions', { error })
      toast.error('Failed to reorder sessions', { description: message })
    },
    onSettled: (_, __, { worktreeId }) => {
      // Refetch to ensure sync with backend
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
  })
}

/**
 * Hook to set the active session tab
 */
export function useSetActiveSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting active session', { sessionId })
      await invoke('set_active_session', {
        worktreeId,
        worktreePath,
        sessionId,
      })
      logger.info('Active session set')
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to set active session', { error })
      toast.error('Failed to set active session', { description: message })
    },
  })
}

// ============================================================================
// Chat Mutations
// ============================================================================

/**
 * Hook to send a message to Claude (session-based)
 */
export function useSendMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    // Disable automatic retries - user can manually retry if needed
    // This prevents re-sending after cancellation
    retry: false,
    mutationFn: async ({
      sessionId,
      worktreeId,
      worktreePath,
      message,
      model,
      executionMode,
      thinkingLevel,
      effortLevel,
      parallelExecutionPrompt,
      aiLanguage,
      allowedTools,
      mcpConfig,
      chromeEnabled,
      customProfileName,
      backend,
    }: {
      sessionId: string
      worktreeId: string
      worktreePath: string
      message: string
      model?: string
      executionMode?: ExecutionMode
      thinkingLevel?: ThinkingLevel
      effortLevel?: string
      parallelExecutionPrompt?: string
      aiLanguage?: string
      allowedTools?: string[]
      mcpConfig?: string
      chromeEnabled?: boolean
      customProfileName?: string
      backend?: string
    }): Promise<ChatMessage> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      console.log(
        `[SendMutation] mutationFn CALLED sessionId=${sessionId} worktreeId=${worktreeId}`
      )
      logger.debug('Sending chat message', {
        sessionId,
        worktreeId,
        model,
        executionMode,
        thinkingLevel,
        effortLevel,
        parallelExecutionPrompt,
        aiLanguage,
        allowedTools,
        mcpConfig: mcpConfig ? '(set)' : undefined,
        chromeEnabled,
      })
      const response = await invoke<ChatMessage>('send_chat_message', {
        sessionId,
        worktreeId,
        worktreePath,
        message,
        model,
        executionMode,
        thinkingLevel,
        effortLevel,
        parallelExecutionPrompt,
        aiLanguage,
        allowedTools,
        mcpConfig,
        chromeEnabled,
        customProfileName,
        backend,
      })
      logger.info('Chat message sent', { responseId: response.id })
      return response
    },
    onMutate: async ({
      sessionId,
      worktreeId,
      message,
      model,
      executionMode,
      thinkingLevel,
    }) => {
      console.log(`[SendMutation] onMutate sessionId=${sessionId}`)
      // Cancel in-flight queries to avoid overwriting optimistic update
      await queryClient.cancelQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })

      // Snapshot previous data for rollback
      const previous = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )

      // Optimistically add user message immediately (skip if last message is same content)
      const optimisticUserMessage: ChatMessage = {
        id: generateId(),
        session_id: sessionId,
        role: 'user' as const,
        content: message,
        timestamp: Math.floor(Date.now() / 1000),
        tool_calls: [],
        model,
        execution_mode: executionMode,
        thinking_level: thinkingLevel,
      }

      // Batch the optimistic user message AND sending state together so React
      // renders both in a single pass (no two-phase scroll: message then placeholder).
      useChatStore.getState().addSendingSession(sessionId)

      queryClient.setQueryData<Session>(
        chatQueryKeys.session(sessionId),
        old => {
          if (!old) {
            // Seed cache for new/unfetched sessions so the user message
            // appears immediately (e.g., automated prompts from workflow runs)
            const now = Math.floor(Date.now() / 1000)
            return {
              id: sessionId,
              name: '',
              order: 0,
              created_at: now,
              updated_at: now,
              messages: [optimisticUserMessage],
            }
          }

          const lastMessage = old.messages?.at(-1)
          const isDuplicate =
            lastMessage?.role === 'user' && lastMessage?.content === message

          // Skip adding duplicate consecutive user messages
          if (isDuplicate) {
            return old
          }

          return {
            ...old,
            messages: [...old.messages, optimisticUserMessage],
          }
        }
      )

      return { previous, worktreeId }
    },
    onSuccess: (response, { sessionId, worktreeId, executionMode }) => {
      console.log(
        `[SendMutation] onSuccess sessionId=${sessionId} cancelled=${response.cancelled}`,
        {
          currentSending: Object.keys(
            useChatStore.getState().sendingSessionIds
          ),
        }
      )
      // All cancelled responses are handled by the chat:cancelled event handler,
      // which already correctly restores the user message (undo path) or preserves
      // the partial assistant response (preserve path). Letting onSuccess proceed
      // for cancelled responses with content would corrupt history by replacing
      // a pre-existing assistant message from a previous turn.
      if (response.cancelled) {
        return
      }

      // For Codex plan mode: inject synthetic ExitPlanMode tool call into the response
      // so the plan approval UI renders (Codex has no native ExitPlanMode tool)
      const { selectedBackends } = useChatStore.getState()
      const isCodexPlan =
        selectedBackends[sessionId] === 'codex' &&
        executionMode === 'plan' &&
        !response.cancelled &&
        response.content.length > 0
      let finalResponse = response
      if (isCodexPlan) {
        const syntheticId = `codex-plan-${sessionId}-${Date.now()}`
        finalResponse = {
          ...response,
          tool_calls: [
            ...response.tool_calls,
            { id: syntheticId, name: 'ExitPlanMode', input: {} },
          ],
          content_blocks: [
            ...(response.content_blocks ?? []),
            { type: 'tool_use' as const, tool_call_id: syntheticId },
          ],
        }
      }

      // Replace the optimistic assistant message with the complete one from backend
      // This fixes a race condition where chat:done creates an optimistic message
      // with incomplete content_blocks (missing Edit/Read/Write tool blocks)
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(sessionId),
        old => {
          if (!old) return old

          // Find the last assistant message (the optimistic one from chat:done)
          // and replace it with the complete message from the backend
          let lastAssistantIdx = -1
          for (let i = old.messages.length - 1; i >= 0; i--) {
            if (old.messages[i]?.role === 'assistant') {
              lastAssistantIdx = i
              break
            }
          }

          if (lastAssistantIdx >= 0) {
            const newMessages = [...old.messages]
            newMessages[lastAssistantIdx] = finalResponse
            return { ...old, messages: newMessages }
          }

          // If no assistant message found, add the response
          return { ...old, messages: [...old.messages, finalResponse] }
        }
      )

      // Invalidate sessions list to update any metadata
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: (error, { sessionId, worktreeId }, context) => {
      // Check for cancellation - Tauri errors may not be Error instances
      // so we check both the stringified error and the message property
      const errorStr = String(error)
      // Tauri invoke errors are strings, not Error instances — extract from both
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : errorStr
      const isCancellation =
        errorStr.includes('cancelled') || errorMessage.includes('cancelled')

      console.log(
        `[SendMutation] onError sessionId=${sessionId} isCancellation=${isCancellation} error=${errorMessage}`,
        {
          currentSending: Object.keys(
            useChatStore.getState().sendingSessionIds
          ),
        }
      )

      if (isCancellation) {
        logger.debug('Message cancelled', { sessionId })
        // Don't rollback - the chat:cancelled event handler preserves the partial response
        return
      }

      // Clean up sending state so session doesn't stay stuck in active status
      const { removeSendingSession, clearExecutingMode, setError } =
        useChatStore.getState()
      removeSendingSession(sessionId)
      clearExecutingMode(sessionId)

      // Disconnect or timeout — the CLI likely ran fine, we just lost the
      // RPC response. Don't rollback (it destroys streamed content the user
      // already saw). Refetch authoritative state from backend disk.
      // Error strings match those thrown in src/lib/transport.ts WsTransport.
      const isDisconnect =
        errorStr.includes('WebSocket disconnected') ||
        errorMessage.includes('WebSocket disconnected')
      const isTimeout =
        errorStr.includes('timed out') || errorMessage.includes('timed out')

      if (isDisconnect || isTimeout) {
        logger.warn('Lost command response, refetching session', {
          sessionId,
          reason: isDisconnect ? 'disconnect' : 'timeout',
        })
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.session(sessionId),
        })
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(worktreeId),
        })
        toast.error(
          isDisconnect
            ? 'Connection lost — refreshing...'
            : 'Response timed out — refreshing...',
          {
            description: 'Your message was likely processed successfully.',
          }
        )
        return
      }

      // Check if CLI produced streaming content before the error.
      // If so, the CLI likely ran — don't destroy the conversation by
      // rolling back to pre-send state. Instead, refetch from disk (#209).
      const hasStreamedContent =
        !!useChatStore.getState().streamingContents[sessionId]
      if (hasStreamedContent) {
        logger.warn(
          'Error after CLI produced content, refetching instead of rollback',
          {
            sessionId,
            error: errorMessage,
          }
        )
        setError(sessionId, errorMessage || 'Unknown error occurred')
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.session(sessionId),
        })
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(worktreeId),
        })
        toast.error('An error occurred, but your conversation was preserved.', {
          description: errorMessage,
        })
        return
      }

      // Real errors with no streamed content — rollback to previous state
      setError(sessionId, errorMessage || 'Unknown error occurred')

      if (context?.previous) {
        queryClient.setQueryData(
          chatQueryKeys.session(sessionId),
          context.previous
        )
      }

      // Invalidate sessions to reflect current run status from backend
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      const message = errorMessage || 'Unknown error occurred'
      logger.error('Failed to send message', { error })
      toast.error('Failed to send message', { description: message })
    },
  })
}

/**
 * Hook to clear chat history for a session
 */
export function useClearSessionHistory() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Clearing session history', { sessionId })
      await invoke('clear_session_history', {
        worktreeId,
        worktreePath,
        sessionId,
      })
      logger.info('Session history cleared')
    },
    onSuccess: (_, { sessionId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      // Clear all session-scoped state
      useChatStore.getState().clearSessionState(sessionId)

      toast.success('Chat history cleared')
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to clear session history', { error })
      toast.error('Failed to clear chat history', { description: message })
    },
  })
}

/**
 * Hook to clear chat history for a worktree (legacy)
 * @deprecated Use useClearSessionHistory instead
 */
export function useClearChatHistory() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
    }: {
      worktreeId: string
      worktreePath: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Clearing chat history', { worktreeId })
      await invoke('clear_chat_history', { worktreeId, worktreePath })
      logger.info('Chat history cleared')
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.history(worktreeId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      toast.success('Chat history cleared')
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to clear chat history', { error })
      toast.error('Failed to clear chat history', { description: message })
    },
  })
}

/**
 * Hook to set the selected model for a session
 */
export function useSetSessionModel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      model,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      model: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting session model', { sessionId, model })
      await invoke('set_session_model', {
        worktreeId,
        worktreePath,
        sessionId,
        model,
      })
      logger.info('Session model saved')
    },
    onMutate: async ({ sessionId, model }) => {
      await queryClient.cancelQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
      const prev = queryClient.getQueryData(chatQueryKeys.session(sessionId))
      queryClient.setQueryData(
        chatQueryKeys.session(sessionId),
        (old: Record<string, unknown> | undefined) =>
          old ? { ...old, selected_model: model } : old
      )
      return { prev, sessionId }
    },
    onSuccess: (_, { sessionId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: (error, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(
          chatQueryKeys.session(context.sessionId),
          context.prev
        )
      }
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to save model selection', { error })
      toast.error('Failed to save model', { description: message })
    },
  })
}

/**
 * Hook to set the backend for a session
 */
export function useSetSessionBackend() {
  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      backend,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      backend: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting session backend', { sessionId, backend })
      await invoke('set_session_backend', {
        worktreeId,
        worktreePath,
        sessionId,
        backend,
      })
      logger.info('Session backend saved')
    },
    // No query invalidation here — callers chain setSessionModel after,
    // which handles invalidation (avoids race where refetch overwrites optimistic update)
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to save backend selection', { error })
      toast.error('Failed to save backend', { description: message })
    },
  })
}

/**
 * Hook to set the selected provider (custom CLI profile) for a session
 */
export function useSetSessionProvider() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      provider,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      provider: string | null
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting session provider', { sessionId, provider })
      await invoke('set_session_provider', {
        worktreeId,
        worktreePath,
        sessionId,
        provider,
      })
      logger.info('Session provider saved')
    },
    onSuccess: (_, { sessionId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to save provider selection', { error })
      toast.error('Failed to save provider', { description: message })
    },
  })
}

/**
 * Hook to set the selected thinking level for a session
 */
export function useSetSessionThinkingLevel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      sessionId,
      thinkingLevel,
    }: {
      worktreeId: string
      worktreePath: string
      sessionId: string
      thinkingLevel: ThinkingLevel
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting session thinking level', {
        sessionId,
        thinkingLevel,
      })
      await invoke('set_session_thinking_level', {
        worktreeId,
        worktreePath,
        sessionId,
        thinkingLevel,
      })
      logger.info('Session thinking level saved')
    },
    onSuccess: (_, { sessionId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to save thinking level selection', { error })
      toast.error('Failed to save thinking level', { description: message })
    },
  })
}

/**
 * Hook to set the selected model for a worktree (legacy)
 * @deprecated Use useSetSessionModel instead
 */
export function useSetWorktreeModel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      model,
    }: {
      worktreeId: string
      worktreePath: string
      model: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting worktree model', { worktreeId, model })
      await invoke('set_worktree_model', { worktreeId, worktreePath, model })
      logger.info('Worktree model saved')
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.history(worktreeId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to save model selection', { error })
      toast.error('Failed to save model', { description: message })
    },
  })
}

/**
 * Hook to set the selected thinking level for a worktree (legacy)
 * @deprecated Use useSetSessionThinkingLevel instead
 */
export function useSetWorktreeThinkingLevel() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      worktreePath,
      thinkingLevel,
    }: {
      worktreeId: string
      worktreePath: string
      thinkingLevel: ThinkingLevel
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting worktree thinking level', {
        worktreeId,
        thinkingLevel,
      })
      await invoke('set_worktree_thinking_level', {
        worktreeId,
        worktreePath,
        thinkingLevel,
      })
      logger.info('Worktree thinking level saved')
    },
    onSuccess: (_, { worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.history(worktreeId),
      })
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to save thinking level selection', { error })
      toast.error('Failed to save thinking level', { description: message })
    },
  })
}

// ============================================================================
// Chat Cancellation
// ============================================================================

/**
 * Cancel a running Claude chat request for a session
 * Returns true if a process was found and cancelled, false if no process was running
 */
export async function cancelChatMessage(
  sessionId: string,
  worktreeId: string
): Promise<boolean> {
  if (!isTauri()) {
    return false
  }

  try {
    logger.debug('Cancelling chat message', { sessionId, worktreeId })
    const cancelled = await invoke<boolean>('cancel_chat_message', {
      sessionId,
      worktreeId,
    })
    if (cancelled) {
      logger.info('Chat message cancelled', { sessionId })
    }
    return cancelled
  } catch (error) {
    logger.error('Failed to cancel chat message', { error, sessionId })
    return false
  }
}

/**
 * Save a cancelled message to disk
 * Called when a streaming response is cancelled mid-stream
 */
export async function saveCancelledMessage(
  worktreeId: string,
  worktreePath: string,
  sessionId: string,
  content: string,
  toolCalls: { id: string; name: string; input: unknown }[],
  contentBlocks: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; tool_call_id: string }
  )[]
): Promise<void> {
  if (!isTauri()) {
    return
  }

  try {
    logger.debug('Saving cancelled message', { sessionId })
    await invoke('save_cancelled_message', {
      worktreeId,
      worktreePath,
      sessionId,
      content,
      toolCalls,
      contentBlocks,
    })
    logger.info('Cancelled message saved', { sessionId })
  } catch (error) {
    logger.error('Failed to save cancelled message', { error, sessionId })
  }
}

// ============================================================================
// AskUserQuestion Utilities
// ============================================================================

/**
 * Format question answers into natural language for Claude
 *
 * Example output:
 * "For 'What aspect of Coolify would you like to focus on?', I selected:
 * - v5 development
 * - API improvements
 *
 * Additionally: I'm interested in the new plugin system"
 */
export function formatAnswersAsNaturalLanguage(
  questions: Question[],
  answers: QuestionAnswer[]
): string {
  const parts: string[] = []

  for (const answer of answers) {
    const question = questions[answer.questionIndex]
    if (!question) continue

    const selectedLabels = answer.selectedOptions
      .map(idx => question.options[idx]?.label)
      .filter(Boolean)

    if (selectedLabels.length > 0 || answer.customText) {
      let text = `For "${question.question}"`

      if (selectedLabels.length > 0) {
        text += `, I selected:\n${selectedLabels.map(l => `- ${l}`).join('\n')}`
      }

      if (answer.customText) {
        text +=
          selectedLabels.length > 0
            ? `\n\nAdditionally: ${answer.customText}`
            : `: ${answer.customText}`
      }

      parts.push(text)
    }
  }

  return parts.length > 0
    ? parts.join('\n\n')
    : 'No specific preferences selected.'
}

// ============================================================================
// Plan File Reading
// ============================================================================

/**
 * Read a plan file from disk
 * Used by the frontend to display plan file content in the approval UI
 */
export async function readPlanFile(path: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('Not in Tauri context')
  }

  return invoke<string>('read_plan_file', { path })
}

// ============================================================================
// Plan Approval
// ============================================================================

/**
 * Mark a message's plan as approved and persist to disk
 */
export async function markPlanApproved(
  worktreeId: string,
  worktreePath: string,
  sessionId: string,
  messageId: string
): Promise<void> {
  if (!isTauri()) {
    return
  }

  try {
    logger.debug('Marking plan approved', { messageId })
    await invoke('mark_plan_approved', {
      worktreeId,
      worktreePath,
      sessionId,
      messageId,
    })
    logger.info('Plan marked as approved', { messageId })
  } catch (error) {
    logger.error('Failed to mark plan approved', { error, messageId })
    throw error
  }
}

// ============================================================================
// Queue Persistence (cross-client sync)
// ============================================================================

/**
 * Persist an enqueued message to the backend for cross-client sync.
 * Fire-and-forget — Zustand is the optimistic source of truth.
 */
export function persistEnqueue(
  worktreeId: string,
  worktreePath: string,
  sessionId: string,
  message: QueuedMessage
): void {
  invoke('enqueue_message', {
    worktreeId,
    worktreePath,
    sessionId,
    message,
  }).catch(err => {
    logger.error('Failed to persist enqueue', { err, sessionId })
  })
}

/**
 * Atomically dequeue a message from the backend.
 * Returns the dequeued message or null if queue was empty (another client won the race).
 */
export async function persistDequeue(
  worktreeId: string,
  worktreePath: string,
  sessionId: string
): Promise<QueuedMessage | null> {
  return invoke<QueuedMessage | null>('dequeue_message', {
    worktreeId,
    worktreePath,
    sessionId,
  })
}

/**
 * Persist removal of a specific queued message.
 */
export function persistRemoveQueued(
  worktreeId: string,
  worktreePath: string,
  sessionId: string,
  messageId: string
): void {
  invoke('remove_queued_message', {
    worktreeId,
    worktreePath,
    sessionId,
    messageId,
  }).catch(err => {
    logger.error('Failed to persist remove queued', { err, sessionId })
  })
}

/**
 * Persist clearing the entire queue for a session.
 */
export function persistClearQueue(
  worktreeId: string,
  worktreePath: string,
  sessionId: string
): void {
  invoke('clear_message_queue', { worktreeId, worktreePath, sessionId }).catch(
    err => {
      logger.error('Failed to persist clear queue', { err, sessionId })
    }
  )
}
