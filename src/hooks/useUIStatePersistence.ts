import { useEffect, useRef, useCallback, useState } from 'react'
import { useUIState, useSaveUIState } from '@/services/ui-state'
import { useProjects } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useBrowserStore } from '@/store/browser-store'
import { browserBackend } from '@/hooks/useBrowserPane'
import { isNativeApp } from '@/lib/environment'
import { logger } from '@/lib/logger'
import type { BrowserTab } from '@/types/browser'
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
      lastOpenedPerProject,
    } = useChatStore.getState()
    const {
      expandedProjectIds,
      expandedFolderIds,
      selectedProjectId,
      projectAccessTimestamps,
      dashboardWorktreeCollapseOverrides,
      projectCanvasSettings,
    } = useProjectsStore.getState()
    const { leftSidebarSize, leftSidebarVisible, gitDiffViewMode } =
      useUIStore.getState()
    const {
      modalTerminalOpen,
      modalTerminalDockMode,
      modalTerminalWidth,
      modalTerminalHeight,
    } = useTerminalStore.getState()
    const browserState = useBrowserStore.getState()
    const browserTabsForPersist = Object.fromEntries(
      Object.entries(browserState.tabs).map(([wid, list]) => [
        wid,
        list.map(t => ({ id: t.id, url: t.url, title: t.title || undefined })),
      ])
    )

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
      // Modal terminal drawer state
      modal_terminal_open: modalTerminalOpen,
      modal_terminal_dock_mode: modalTerminalDockMode,
      modal_terminal_width: modalTerminalWidth,
      modal_terminal_height: modalTerminalHeight,
      // Browser pane state (per-worktree tabs + 3-surface visibility)
      browser_tabs: browserTabsForPersist,
      browser_active_tab_ids: browserState.activeTabIds,
      browser_side_pane_open: browserState.sidePaneOpen,
      browser_side_pane_width: browserState.sidePaneWidth,
      browser_modal_open: browserState.modalOpen,
      browser_modal_dock_mode: browserState.modalDockMode,
      browser_modal_width: browserState.modalWidth,
      browser_modal_height: browserState.modalHeight,
      browser_bottom_panel_open: browserState.bottomPanelOpen,
      browser_bottom_panel_height: browserState.bottomPanelHeight,
      // Project access timestamps for recency sorting
      project_access_timestamps: projectAccessTimestamps,
      // Dashboard worktree collapse overrides
      dashboard_worktree_collapse_overrides: dashboardWorktreeCollapseOverrides,
      // Project canvas settings per project
      project_canvas_settings: Object.fromEntries(
        Object.entries(projectCanvasSettings).map(([projectId, settings]) => [
          projectId,
          {
            worktree_sort_mode: settings.worktreeSortMode,
          },
        ])
      ),
      // Last opened worktree+session per project (convert camelCase → snake_case keys)
      last_opened_per_project: Object.fromEntries(
        Object.entries(lastOpenedPerProject).map(([projectId, entry]) => [
          projectId,
          { worktree_id: entry.worktreeId, session_id: entry.sessionId },
        ])
      ),
      // Git diff modal view mode
      git_diff_view_mode: gitDiffViewMode,
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

    // Restore git diff view mode
    if (
      uiState.git_diff_view_mode === 'list' ||
      uiState.git_diff_view_mode === 'tree'
    ) {
      useUIStore.getState().setGitDiffViewMode(uiState.git_diff_view_mode)
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

    // Restore modal terminal drawer state
    const modalTerminalOpen = uiState.modal_terminal_open ?? {}
    if (Object.keys(modalTerminalOpen).length > 0) {
      logger.debug('Restoring modal terminal open state', {
        count: Object.keys(modalTerminalOpen).length,
      })
      useTerminalStore.setState({ modalTerminalOpen })
    }
    const modalTerminalDockMode =
      uiState.modal_terminal_dock_mode ??
      (uiState.modal_terminal_pinned ? 'right' : 'floating')
    if (modalTerminalDockMode) {
      logger.debug('Restoring modal terminal dock mode', {
        dockMode: modalTerminalDockMode,
      })
      useTerminalStore.setState({
        modalTerminalDockMode,
      })
    }
    if (uiState.modal_terminal_width != null) {
      logger.debug('Restoring modal terminal width', {
        width: uiState.modal_terminal_width,
      })
      useTerminalStore.setState({
        modalTerminalWidth: uiState.modal_terminal_width,
      })
    }
    if (uiState.modal_terminal_height != null) {
      logger.debug('Restoring modal terminal height', {
        height: uiState.modal_terminal_height,
      })
      useTerminalStore.setState({
        modalTerminalHeight: uiState.modal_terminal_height,
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

    const projectCanvasSettings = uiState.project_canvas_settings ?? {}
    if (Object.keys(projectCanvasSettings).length > 0) {
      logger.debug('Restoring project canvas settings', {
        count: Object.keys(projectCanvasSettings).length,
      })
      useProjectsStore.getState().setProjectCanvasSettings(
        Object.fromEntries(
          Object.entries(projectCanvasSettings).map(([projectId, settings]) => [
            projectId,
            {
              worktreeSortMode: settings.worktree_sort_mode,
            },
          ])
        )
      )
    }

    // Restore browser pane state (per-worktree tabs + 3-surface visibility)
    const persistedBrowserTabs = uiState.browser_tabs ?? {}
    const browserActiveTabIds = uiState.browser_active_tab_ids ?? {}
    if (Object.keys(persistedBrowserTabs).length > 0) {
      const hydratedTabs: Record<string, BrowserTab[]> = {}
      for (const [wid, list] of Object.entries(persistedBrowserTabs)) {
        hydratedTabs[wid] = list.map(t => ({
          id: t.id,
          worktreeId: wid,
          url: t.url,
          title: t.title ?? '',
          isLoading: false,
        }))
      }
      logger.debug('Restoring browser tabs', {
        worktreeCount: Object.keys(hydratedTabs).length,
      })
      useBrowserStore.getState().hydrateTabs(hydratedTabs, browserActiveTabIds)
    }
    // Browser surfaces are mutually exclusive per worktree (one webview, one
    // position). If persisted state has multiple flags true (legacy bug or
    // hand-edited file), keep only one with priority: modal > sidePane > bottom.
    const persistedSidePaneOpen = uiState.browser_side_pane_open ?? {}
    const persistedModalOpen = uiState.browser_modal_open ?? {}
    const persistedBottomOpen = uiState.browser_bottom_panel_open ?? {}
    const sanitizedSidePane: Record<string, boolean> = {}
    const sanitizedModal: Record<string, boolean> = {}
    const sanitizedBottom: Record<string, boolean> = {}
    const allWorktreeIds = new Set([
      ...Object.keys(persistedSidePaneOpen),
      ...Object.keys(persistedModalOpen),
      ...Object.keys(persistedBottomOpen),
    ])
    for (const wid of allWorktreeIds) {
      if (persistedModalOpen[wid]) {
        sanitizedModal[wid] = true
      } else if (persistedSidePaneOpen[wid]) {
        sanitizedSidePane[wid] = true
      } else if (persistedBottomOpen[wid]) {
        sanitizedBottom[wid] = true
      }
    }
    if (Object.keys(sanitizedSidePane).length > 0) {
      useBrowserStore.setState({ sidePaneOpen: sanitizedSidePane })
    }
    if (Object.keys(sanitizedModal).length > 0) {
      useBrowserStore.setState({ modalOpen: sanitizedModal })
    }
    if (Object.keys(sanitizedBottom).length > 0) {
      useBrowserStore.setState({ bottomPanelOpen: sanitizedBottom })
    }
    if (uiState.browser_side_pane_width != null) {
      useBrowserStore.setState({
        sidePaneWidth: uiState.browser_side_pane_width,
      })
    }
    if (uiState.browser_modal_dock_mode) {
      useBrowserStore.setState({
        modalDockMode: uiState.browser_modal_dock_mode,
      })
    }
    if (uiState.browser_modal_width != null) {
      useBrowserStore.setState({ modalWidth: uiState.browser_modal_width })
    }
    if (uiState.browser_modal_height != null) {
      useBrowserStore.setState({ modalHeight: uiState.browser_modal_height })
    }
    if (uiState.browser_bottom_panel_height != null) {
      useBrowserStore.setState({
        bottomPanelHeight: uiState.browser_bottom_panel_height,
      })
    }
    // Cross-pane mutual exclusion: browser surfaces and terminal modal are
    // mutually exclusive per worktree. If both restored as open for the same
    // worktree (legacy/hand-edited state), close every browser surface there
    // and let the terminal win — terminal is the more recently used surface
    // for most users and avoids reopening into a broken layout.
    {
      const terminalState = useTerminalStore.getState()
      const fixedSidePane = { ...sanitizedSidePane }
      const fixedModal = { ...sanitizedModal }
      const fixedBottom = { ...sanitizedBottom }
      let changed = false
      for (const wid of Object.keys(terminalState.modalTerminalOpen)) {
        if (!terminalState.modalTerminalOpen[wid]) continue
        if (fixedSidePane[wid]) {
          fixedSidePane[wid] = false
          changed = true
        }
        if (fixedModal[wid]) {
          fixedModal[wid] = false
          changed = true
        }
        if (fixedBottom[wid]) {
          fixedBottom[wid] = false
          changed = true
        }
      }
      if (changed) {
        logger.debug(
          'Resolving browser/terminal mutual exclusion on hydrate (closing browser)'
        )
        useBrowserStore.setState({
          sidePaneOpen: fixedSidePane,
          modalOpen: fixedModal,
          bottomPanelOpen: fixedBottom,
        })
      }
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
    let prevProjectCanvasSettings =
      useProjectsStore.getState().projectCanvasSettings
    let prevLeftSidebarSize = useUIStore.getState().leftSidebarSize
    let prevLeftSidebarVisible = useUIStore.getState().leftSidebarVisible
    let prevGitDiffViewMode = useUIStore.getState().gitDiffViewMode
    let prevWorktreeId = useChatStore.getState().activeWorktreeId
    let prevWorktreePath = useChatStore.getState().activeWorktreePath
    let prevLastActiveWorktreeId = useChatStore.getState().lastActiveWorktreeId
    let prevActiveSessionIds = useChatStore.getState().activeSessionIds
    let prevReviewSidebarVisible = useChatStore.getState().reviewSidebarVisible
    let prevLastOpenedPerProject = useChatStore.getState().lastOpenedPerProject
    let prevModalTerminalOpen = useTerminalStore.getState().modalTerminalOpen
    let prevModalTerminalDockMode =
      useTerminalStore.getState().modalTerminalDockMode
    let prevModalTerminalWidth = useTerminalStore.getState().modalTerminalWidth
    let prevModalTerminalHeight =
      useTerminalStore.getState().modalTerminalHeight
    let prevBrowserTabs = useBrowserStore.getState().tabs
    let prevBrowserActiveTabIds = useBrowserStore.getState().activeTabIds
    let prevBrowserSidePaneOpen = useBrowserStore.getState().sidePaneOpen
    let prevBrowserSidePaneWidth = useBrowserStore.getState().sidePaneWidth
    let prevBrowserModalOpen = useBrowserStore.getState().modalOpen
    let prevBrowserModalDockMode = useBrowserStore.getState().modalDockMode
    let prevBrowserModalWidth = useBrowserStore.getState().modalWidth
    let prevBrowserModalHeight = useBrowserStore.getState().modalHeight
    let prevBrowserBottomPanelOpen = useBrowserStore.getState().bottomPanelOpen
    let prevBrowserBottomPanelHeight =
      useBrowserStore.getState().bottomPanelHeight

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
      const projectCanvasSettingsChanged =
        state.projectCanvasSettings !== prevProjectCanvasSettings

      if (
        projectIdsChanged ||
        folderIdsChanged ||
        selectedProjectChanged ||
        accessTimestampsChanged ||
        collapseOverridesChanged ||
        projectCanvasSettingsChanged
      ) {
        prevExpandedProjectIds = state.expandedProjectIds
        prevExpandedFolderIds = state.expandedFolderIds
        prevSelectedProjectId = state.selectedProjectId
        prevProjectAccessTimestamps = state.projectAccessTimestamps
        prevDashboardCollapseOverrides =
          state.dashboardWorktreeCollapseOverrides
        prevProjectCanvasSettings = state.projectCanvasSettings
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to ui-store changes (sidebar size, visibility, and git diff view mode)
    const unsubUI = useUIStore.subscribe(state => {
      const sizeChanged = state.leftSidebarSize !== prevLeftSidebarSize
      const visibilityChanged =
        state.leftSidebarVisible !== prevLeftSidebarVisible
      const gitDiffViewModeChanged =
        state.gitDiffViewMode !== prevGitDiffViewMode

      if (sizeChanged || visibilityChanged || gitDiffViewModeChanged) {
        prevLeftSidebarSize = state.leftSidebarSize
        prevLeftSidebarVisible = state.leftSidebarVisible
        prevGitDiffViewMode = state.gitDiffViewMode
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
      const lastOpenedChanged =
        state.lastOpenedPerProject !== prevLastOpenedPerProject

      if (
        worktreeChanged ||
        sessionsChanged ||
        reviewSidebarChanged ||
        lastOpenedChanged
      ) {
        prevWorktreeId = state.activeWorktreeId
        prevWorktreePath = state.activeWorktreePath
        prevLastActiveWorktreeId = state.lastActiveWorktreeId
        prevActiveSessionIds = state.activeSessionIds
        prevReviewSidebarVisible = state.reviewSidebarVisible
        prevLastOpenedPerProject = state.lastOpenedPerProject
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to terminal-store changes (modal terminal drawer state)
    const unsubTerminal = useTerminalStore.subscribe(state => {
      const openChanged = state.modalTerminalOpen !== prevModalTerminalOpen
      const dockModeChanged =
        state.modalTerminalDockMode !== prevModalTerminalDockMode
      const widthChanged = state.modalTerminalWidth !== prevModalTerminalWidth
      const heightChanged =
        state.modalTerminalHeight !== prevModalTerminalHeight

      if (openChanged || dockModeChanged || widthChanged || heightChanged) {
        prevModalTerminalOpen = state.modalTerminalOpen
        prevModalTerminalDockMode = state.modalTerminalDockMode
        prevModalTerminalWidth = state.modalTerminalWidth
        prevModalTerminalHeight = state.modalTerminalHeight
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to browser-store changes (tabs, active tab, surfaces)
    const unsubBrowser = useBrowserStore.subscribe(state => {
      const tabsChanged = state.tabs !== prevBrowserTabs
      const activeChanged = state.activeTabIds !== prevBrowserActiveTabIds
      const sideOpenChanged = state.sidePaneOpen !== prevBrowserSidePaneOpen
      const sideWidthChanged = state.sidePaneWidth !== prevBrowserSidePaneWidth
      const modalOpenChanged = state.modalOpen !== prevBrowserModalOpen
      const modalDockChanged = state.modalDockMode !== prevBrowserModalDockMode
      const modalWidthChanged = state.modalWidth !== prevBrowserModalWidth
      const modalHeightChanged = state.modalHeight !== prevBrowserModalHeight
      const bottomOpenChanged =
        state.bottomPanelOpen !== prevBrowserBottomPanelOpen
      const bottomHeightChanged =
        state.bottomPanelHeight !== prevBrowserBottomPanelHeight

      if (
        tabsChanged ||
        activeChanged ||
        sideOpenChanged ||
        sideWidthChanged ||
        modalOpenChanged ||
        modalDockChanged ||
        modalWidthChanged ||
        modalHeightChanged ||
        bottomOpenChanged ||
        bottomHeightChanged
      ) {
        // Detect tab removals — close their backing webviews
        if (tabsChanged && isNativeApp()) {
          const prevIds = new Set<string>()
          for (const list of Object.values(prevBrowserTabs)) {
            for (const t of list) prevIds.add(t.id)
          }
          const nextIds = new Set<string>()
          for (const list of Object.values(state.tabs)) {
            for (const t of list) nextIds.add(t.id)
          }
          for (const id of prevIds) {
            if (!nextIds.has(id)) void browserBackend.close(id)
          }
        }
        prevBrowserTabs = state.tabs
        prevBrowserActiveTabIds = state.activeTabIds
        prevBrowserSidePaneOpen = state.sidePaneOpen
        prevBrowserSidePaneWidth = state.sidePaneWidth
        prevBrowserModalOpen = state.modalOpen
        prevBrowserModalDockMode = state.modalDockMode
        prevBrowserModalWidth = state.modalWidth
        prevBrowserModalHeight = state.modalHeight
        prevBrowserBottomPanelOpen = state.bottomPanelOpen
        prevBrowserBottomPanelHeight = state.bottomPanelHeight
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
      unsubBrowser()
      debouncedSaveRef.current?.cancel()
      logger.debug('UI state persistence subscriptions cleaned up')
    }
  }, [isInitialized, getCurrentUIState])

  return { isInitialized }
}
