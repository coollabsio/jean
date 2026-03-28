import { useEffect, useRef, useCallback, useState } from 'react'
import { useUIState, useSaveUIState } from '@/services/ui-state'
import { useProjects } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { logger } from '@/lib/logger'
import type { UIState } from '@/types/ui-state'

// Simple debounce implementation
function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      fn(...args)
      timeoutId = null
    }, delay)
  }) as T & { cancel: () => void }

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return debounced
}

/**
 * Hook that handles UI state persistence:
 * 1. Initializes Zustand stores from persisted state on app load
 * 2. Subscribes to store changes and debounce saves (500ms)
 * 3. Validates worktree still exists before restoring
 */
export function useUIStatePersistence() {
  const { data: uiState, isSuccess: uiStateLoaded } = useUIState()
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects()
  const { mutate: saveUIState } = useSaveUIState()
  const [isInitialized, setIsInitialized] = useState(false)

  // Create stable debounced save function
  const debouncedSaveRef = useRef<ReturnType<
    typeof debounce<(state: UIState) => void>
  > | null>(null)

  // Initialize debounced save function
  useEffect(() => {
    debouncedSaveRef.current = debounce((state: UIState) => {
      logger.debug('Saving UI state (debounced)')
      saveUIState(state)
    }, 500)

    return () => {
      debouncedSaveRef.current?.cancel()
    }
  }, [saveUIState])

  // Helper to get current UI state from stores
  // NOTE: Session-specific state (answered_questions, submitted_answers, fixed_findings,
  // pending_permission_denials, denied_message_context, reviewing_sessions) is now
  // stored in the Session files, not ui-state.json. See useSessionStatePersistence.
  const getCurrentUIState = useCallback((): UIState => {
    const {
      activeWorktreeId,
      activeWorktreePath,
      lastActiveWorktreeId,
      activeSessionIds,
      reviewSidebarVisible,
      pendingDigestSessionIds,
      lastOpenedPerProject,
    } = useChatStore.getState()
    const {
      expandedProjectIds,
      expandedFolderIds,
      selectedProjectId,
      projectAccessTimestamps,
      dashboardWorktreeCollapseOverrides,
    } = useProjectsStore.getState()
    const { leftSidebarSize, leftSidebarVisible } = useUIStore.getState()
    const { modalTerminalOpen, modalTerminalWidth } =
      useTerminalStore.getState()

    return {
      active_worktree_id: activeWorktreeId,
      active_worktree_path: activeWorktreePath,
      last_active_worktree_id: lastActiveWorktreeId,
      active_project_id: selectedProjectId,
      expanded_project_ids: Array.from(expandedProjectIds),
      expanded_folder_ids: Array.from(expandedFolderIds),
      left_sidebar_size: leftSidebarSize,
      left_sidebar_visible: leftSidebarVisible,
      active_session_ids: activeSessionIds,
      // Review sidebar visibility
      review_sidebar_visible: reviewSidebarVisible,
      // Convert pendingDigestSessionIds record to array of session IDs
      pending_digest_session_ids: Object.keys(pendingDigestSessionIds),
      // Modal terminal drawer state
      modal_terminal_open: modalTerminalOpen,
      modal_terminal_width: modalTerminalWidth,
      // Project access timestamps for recency sorting
      project_access_timestamps: projectAccessTimestamps,
      // Dashboard worktree collapse overrides
      dashboard_worktree_collapse_overrides: dashboardWorktreeCollapseOverrides,
      // Last opened worktree+session per project (convert camelCase → snake_case keys)
      last_opened_per_project: Object.fromEntries(
        Object.entries(lastOpenedPerProject).map(([projectId, entry]) => [
          projectId,
          { worktree_id: entry.worktreeId, session_id: entry.sessionId },
        ])
      ),
      version: 1, // Reset for first release
    }
  }, [])

  // Step 1: Initialize stores from persisted state (once, when projects are loaded)
  useEffect(() => {
    // Wait for both UI state and projects to load before initializing
    if (!uiStateLoaded || !uiState || isInitialized) return

    // Wait for projects to load (or confirm they're empty)
    // We need projects to validate the worktree and find its parent project
    const projectsStillLoading = projects.length === 0 && !projectsLoaded

    if (projectsStillLoading) {
      logger.debug('Waiting for projects to load before restoring UI state')
      return
    }

    logger.info('Initializing UI state from persisted state', { uiState })

    // Restore expanded projects (filter to only projects that still exist)
    // Defensive: ensure expanded_project_ids is an array (might be null/undefined from backend)
    const expandedProjectIds = uiState.expanded_project_ids ?? []
    if (expandedProjectIds.length > 0) {
      const validProjectIds = expandedProjectIds.filter(id =>
        projects.some(p => p.id === id)
      )

      if (validProjectIds.length > 0) {
        logger.debug('Restoring expanded projects', { validProjectIds })
        useProjectsStore.setState({
          expandedProjectIds: new Set(validProjectIds),
        })
      }

      if (validProjectIds.length < expandedProjectIds.length) {
        logger.debug('Some expanded project IDs no longer exist', {
          persisted: expandedProjectIds,
          valid: validProjectIds,
        })
      }
    }

    // Restore expanded folders (filter to only folders that still exist)
    const expandedFolderIds = uiState.expanded_folder_ids ?? []
    if (expandedFolderIds.length > 0) {
      const validFolderIds = expandedFolderIds.filter(id =>
        projects.some(p => p.id === id && p.is_folder)
      )

      if (validFolderIds.length > 0) {
        logger.debug('Restoring expanded folders', { validFolderIds })
        useProjectsStore.setState({
          expandedFolderIds: new Set(validFolderIds),
        })
      }
    }

    // Restore left sidebar size (must be at least 150px to be valid)
    if (uiState.left_sidebar_size != null && uiState.left_sidebar_size >= 150) {
      logger.debug('Restoring left sidebar size', {
        size: uiState.left_sidebar_size,
      })
      useUIStore.getState().setLeftSidebarSize(uiState.left_sidebar_size)
    }

    // Restore left sidebar visibility
    if (uiState.left_sidebar_visible !== undefined) {
      logger.debug('Restoring left sidebar visibility', {
        visible: uiState.left_sidebar_visible,
      })
      useUIStore.getState().setLeftSidebarVisible(uiState.left_sidebar_visible)
    }

    // Restore active project first (selectProject clears selectedWorktreeId)
    // This must happen BEFORE restoring the active worktree
    if (uiState.active_project_id) {
      const projectExists = projects.some(
        p => p.id === uiState.active_project_id
      )
      if (projectExists) {
        logger.debug('Restoring active project', {
          id: uiState.active_project_id,
        })
        const { selectProject } = useProjectsStore.getState()
        selectProject(uiState.active_project_id)
      } else {
        logger.debug('Active project no longer exists', {
          id: uiState.active_project_id,
        })
      }
    }

    // Restore active worktree (must happen AFTER selectProject which clears selectedWorktreeId)
    if (uiState.active_worktree_id && uiState.active_worktree_path) {
      logger.debug('Restoring active worktree', {
        id: uiState.active_worktree_id,
        path: uiState.active_worktree_path,
      })

      // Set the active worktree in both stores
      const { selectWorktree } = useProjectsStore.getState()
      const { setActiveWorktree } = useChatStore.getState()

      selectWorktree(uiState.active_worktree_id)
      setActiveWorktree(
        uiState.active_worktree_id,
        uiState.active_worktree_path
      )

      // Note: We don't validate if the path exists here because:
      // 1. It adds complexity and async operations
      // 2. The UI will naturally handle invalid worktrees (show error, empty state)
      // 3. The worktree list from the backend is the source of truth
    }

    // Restore last active worktree ID (for dashboard session selection)
    // This must happen AFTER setActiveWorktree which also sets it,
    // but covers the case where the user was on the dashboard (no active worktree)
    if (uiState.last_active_worktree_id) {
      useChatStore
        .getState()
        .setLastActiveWorktreeId(uiState.last_active_worktree_id)
    }

    // Restore active sessions per worktree
    // Defensive: ensure active_session_ids is an object (might be null/undefined from backend)
    const activeSessionIds = uiState.active_session_ids ?? {}
    if (Object.keys(activeSessionIds).length > 0) {
      logger.debug('Restoring active sessions', { activeSessionIds })
      const { setActiveSession } = useChatStore.getState()
      for (const [worktreeId, sessionId] of Object.entries(activeSessionIds)) {
        setActiveSession(worktreeId, sessionId, { markOpened: false })
      }
    }

    // NOTE: Session-specific state (answered_questions, submitted_answers, fixed_findings,
    // pending_permission_denials, denied_message_context, reviewing_sessions) is now
    // loaded from Session files by useSessionStatePersistence hook.

    // Restore review sidebar visibility
    if (uiState.review_sidebar_visible != null) {
      useChatStore.setState({
        reviewSidebarVisible: uiState.review_sidebar_visible,
      })
    }

    // Restore pending digest session IDs (convert array to record with true values)
    const pendingDigestSessionIds = uiState.pending_digest_session_ids ?? []
    if (pendingDigestSessionIds.length > 0) {
      logger.debug('Restoring pending digest session IDs', {
        count: pendingDigestSessionIds.length,
      })
      const converted = Object.fromEntries(
        pendingDigestSessionIds.map(id => [id, true])
      )
      useChatStore.setState({ pendingDigestSessionIds: converted })
    }

    // Restore modal terminal drawer state
    const modalTerminalOpen = uiState.modal_terminal_open ?? {}
    if (Object.keys(modalTerminalOpen).length > 0) {
      logger.debug('Restoring modal terminal open state', {
        count: Object.keys(modalTerminalOpen).length,
      })
      useTerminalStore.setState({ modalTerminalOpen })
    }
    if (uiState.modal_terminal_width != null) {
      logger.debug('Restoring modal terminal width', {
        width: uiState.modal_terminal_width,
      })
      useTerminalStore.setState({
        modalTerminalWidth: uiState.modal_terminal_width,
      })
    }

    // Restore project access timestamps
    const projectAccessTimestamps = uiState.project_access_timestamps ?? {}
    if (Object.keys(projectAccessTimestamps).length > 0) {
      logger.debug('Restoring project access timestamps', {
        count: Object.keys(projectAccessTimestamps).length,
      })
      useProjectsStore
        .getState()
        .setProjectAccessTimestamps(projectAccessTimestamps)
    }

    // Restore dashboard worktree collapse overrides
    const collapseOverrides =
      uiState.dashboard_worktree_collapse_overrides ?? {}
    if (Object.keys(collapseOverrides).length > 0) {
      logger.debug('Restoring dashboard worktree collapse overrides', {
        count: Object.keys(collapseOverrides).length,
      })
      useProjectsStore.setState({
        dashboardWorktreeCollapseOverrides: collapseOverrides,
      })
    }

    // Restore last opened worktree+session per project (convert snake_case → camelCase keys)
    const lastOpenedPerProject = uiState.last_opened_per_project ?? {}
    if (Object.keys(lastOpenedPerProject).length > 0) {
      logger.debug('Restoring last opened per project', {
        count: Object.keys(lastOpenedPerProject).length,
      })
      const converted = Object.fromEntries(
        Object.entries(lastOpenedPerProject).map(([projectId, entry]) => [
          projectId,
          { worktreeId: entry.worktree_id, sessionId: entry.session_id },
        ])
      )
      useChatStore.setState({ lastOpenedPerProject: converted })
    }

    queueMicrotask(() => {
      setIsInitialized(true)
      useUIStore.getState().setUIStateInitialized(true)
    })
    logger.info('UI state initialization complete')
  }, [uiStateLoaded, uiState, projects, projectsLoaded, isInitialized])

  // Step 2: Subscribe to store changes and save (debounced)
  useEffect(() => {
    // Don't start saving until we've initialized from persisted state
    if (!isInitialized) return

    // Track previous values to detect actual changes
    let prevExpandedProjectIds = useProjectsStore.getState().expandedProjectIds
    let prevExpandedFolderIds = useProjectsStore.getState().expandedFolderIds
    let prevSelectedProjectId = useProjectsStore.getState().selectedProjectId
    let prevProjectAccessTimestamps =
      useProjectsStore.getState().projectAccessTimestamps
    let prevDashboardCollapseOverrides =
      useProjectsStore.getState().dashboardWorktreeCollapseOverrides
    let prevLeftSidebarSize = useUIStore.getState().leftSidebarSize
    let prevLeftSidebarVisible = useUIStore.getState().leftSidebarVisible
    let prevWorktreeId = useChatStore.getState().activeWorktreeId
    let prevWorktreePath = useChatStore.getState().activeWorktreePath
    let prevLastActiveWorktreeId = useChatStore.getState().lastActiveWorktreeId
    let prevActiveSessionIds = useChatStore.getState().activeSessionIds
    let prevReviewSidebarVisible = useChatStore.getState().reviewSidebarVisible
    let prevPendingDigestSessionIds =
      useChatStore.getState().pendingDigestSessionIds
    let prevLastOpenedPerProject = useChatStore.getState().lastOpenedPerProject
    let prevModalTerminalOpen = useTerminalStore.getState().modalTerminalOpen
    let prevModalTerminalWidth = useTerminalStore.getState().modalTerminalWidth

    // Subscribe to projects-store changes (expanded projects, folders, and selected project)
    const unsubProjects = useProjectsStore.subscribe(state => {
      // Check if expandedProjectIds, expandedFolderIds, or selectedProjectId changed
      const projectIdsChanged =
        state.expandedProjectIds !== prevExpandedProjectIds
      const folderIdsChanged = state.expandedFolderIds !== prevExpandedFolderIds
      const selectedProjectChanged =
        state.selectedProjectId !== prevSelectedProjectId
      const accessTimestampsChanged =
        state.projectAccessTimestamps !== prevProjectAccessTimestamps
      const collapseOverridesChanged =
        state.dashboardWorktreeCollapseOverrides !==
        prevDashboardCollapseOverrides

      if (
        projectIdsChanged ||
        folderIdsChanged ||
        selectedProjectChanged ||
        accessTimestampsChanged ||
        collapseOverridesChanged
      ) {
        prevExpandedProjectIds = state.expandedProjectIds
        prevExpandedFolderIds = state.expandedFolderIds
        prevSelectedProjectId = state.selectedProjectId
        prevProjectAccessTimestamps = state.projectAccessTimestamps
        prevDashboardCollapseOverrides =
          state.dashboardWorktreeCollapseOverrides
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to ui-store changes (sidebar size and visibility)
    const unsubUI = useUIStore.subscribe(state => {
      const sizeChanged = state.leftSidebarSize !== prevLeftSidebarSize
      const visibilityChanged =
        state.leftSidebarVisible !== prevLeftSidebarVisible

      if (sizeChanged || visibilityChanged) {
        prevLeftSidebarSize = state.leftSidebarSize
        prevLeftSidebarVisible = state.leftSidebarVisible
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to chat-store changes (active worktree, sessions, and worktree-scoped state)
    // NOTE: Session-specific state is handled by useSessionStatePersistence
    const unsubChat = useChatStore.subscribe(state => {
      // Check if active worktree or active sessions changed
      const worktreeChanged =
        state.activeWorktreeId !== prevWorktreeId ||
        state.activeWorktreePath !== prevWorktreePath ||
        state.lastActiveWorktreeId !== prevLastActiveWorktreeId
      const sessionsChanged = state.activeSessionIds !== prevActiveSessionIds
      const reviewSidebarChanged =
        state.reviewSidebarVisible !== prevReviewSidebarVisible
      const pendingDigestChanged =
        state.pendingDigestSessionIds !== prevPendingDigestSessionIds
      const lastOpenedChanged =
        state.lastOpenedPerProject !== prevLastOpenedPerProject

      if (
        worktreeChanged ||
        sessionsChanged ||
        reviewSidebarChanged ||
        pendingDigestChanged ||
        lastOpenedChanged
      ) {
        prevWorktreeId = state.activeWorktreeId
        prevWorktreePath = state.activeWorktreePath
        prevLastActiveWorktreeId = state.lastActiveWorktreeId
        prevActiveSessionIds = state.activeSessionIds
        prevReviewSidebarVisible = state.reviewSidebarVisible
        prevPendingDigestSessionIds = state.pendingDigestSessionIds
        prevLastOpenedPerProject = state.lastOpenedPerProject
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to terminal-store changes (modal terminal drawer state)
    const unsubTerminal = useTerminalStore.subscribe(state => {
      const openChanged = state.modalTerminalOpen !== prevModalTerminalOpen
      const widthChanged = state.modalTerminalWidth !== prevModalTerminalWidth

      if (openChanged || widthChanged) {
        prevModalTerminalOpen = state.modalTerminalOpen
        prevModalTerminalWidth = state.modalTerminalWidth
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    logger.debug('UI state persistence subscriptions active')

    return () => {
      unsubProjects()
      unsubUI()
      unsubChat()
      unsubTerminal()
      debouncedSaveRef.current?.cancel()
      logger.debug('UI state persistence subscriptions cleaned up')
    }
  }, [isInitialized, getCurrentUIState])

  return { isInitialized }
}
