import { useEffect, useRef, useCallback, useState } from 'react'
import { useUIState, useSaveUIState } from '@/services/ui-state'
import { useProjects } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import {
  isPanelTerminal,
  useTerminalStore,
  type TerminalInstance,
} from '@/store/terminal-store'
import { useBrowserStore } from '@/store/browser-store'
import { browserBackend } from '@/hooks/useBrowserPane'
import { isLocalBackend } from '@/lib/environment'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { BrowserTab } from '@/types/browser'
import type {
  PendingImage,
  PendingTextFile,
  ReadTextResponse,
} from '@/types/chat'
import type {
  PendingImageDraft,
  PendingTextFileDraft,
  UIState,
} from '@/types/ui-state'

/** Serialize ready (non-loading) pending images for UI-state persistence. */
function serializePendingImages(
  pendingImages: Record<string, PendingImage[]>
): Record<string, PendingImageDraft[]> {
  const out: Record<string, PendingImageDraft[]> = {}
  for (const [sessionId, images] of Object.entries(pendingImages)) {
    const ready = images
      .filter(img => !img.loading && !!img.path)
      .map(({ id, path, filename }) => ({ id, path, filename }))
    if (ready.length > 0) {
      out[sessionId] = ready
    }
  }
  return out
}

/**
 * Serialize pending text-file attachments without embedding full content,
 * so large pastes do not bloat the UI-state JSON.
 */
function serializePendingTextFiles(
  pendingTextFiles: Record<string, PendingTextFile[]>
): Record<string, PendingTextFileDraft[]> {
  const out: Record<string, PendingTextFileDraft[]> = {}
  for (const [sessionId, textFiles] of Object.entries(pendingTextFiles)) {
    if (textFiles.length === 0) continue
    out[sessionId] = textFiles.map(({ id, path, filename, size }) => ({
      id,
      path,
      filename,
      size,
    }))
  }
  return out
}

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
  // NOTE: Durable session-specific state is stored in Session files. Unsent
  // input drafts (text + image/text-file attachments) remain lightweight UI
  // state so they survive full UI reloads.
  const getCurrentUIState = useCallback((): UIState => {
    const {
      activeWorktreeId,
      activeWorktreePath,
      lastActiveWorktreeId,
      activeSessionIds,
      inputDrafts,
      pendingImages,
      pendingTextFiles,
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
      githubDashboardFavoriteProjectIds,
    } = useProjectsStore.getState()
    const {
      leftSidebarSize,
      leftSidebarVisible,
      sessionTerminalIds,
      sessionPrimarySurface,
    } = useUIStore.getState()
    const {
      terminals,
      activeTerminalIds,
      terminalPanelOpen,
      terminalVisible,
      terminalHeight,
      modalTerminalOpen,
      modalTerminalDockMode,
      modalTerminalWidth,
      modalTerminalHeight,
    } = useTerminalStore.getState()
    const shouldPersistTerminalRuntime = !isLocalBackend()
    const terminalInstancesForPersist = shouldPersistTerminalRuntime
      ? Object.fromEntries(
          Object.entries(terminals)
            .map(([worktreeId, list]) => [
              worktreeId,
              list.map(terminal => ({
                id: terminal.id,
                command: terminal.command,
                command_args: terminal.commandArgs ?? null,
                label: terminal.label,
                kind: terminal.kind ?? 'panel',
              })),
            ])
            .filter(([, list]) => (list as unknown[]).length > 0)
        )
      : {}
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
      input_drafts: inputDrafts,
      pending_images: serializePendingImages(pendingImages),
      pending_text_files: serializePendingTextFiles(pendingTextFiles),
      // Review sidebar visibility
      review_sidebar_visible: reviewSidebarVisible,
      // Modal terminal drawer state
      modal_terminal_open: modalTerminalOpen,
      modal_terminal_dock_mode: modalTerminalDockMode,
      modal_terminal_width: modalTerminalWidth,
      modal_terminal_height: modalTerminalHeight,
      // Terminal runtime state (web access only; native app restart must not auto-spawn old shells)
      terminal_instances: terminalInstancesForPersist,
      terminal_active_ids: shouldPersistTerminalRuntime
        ? activeTerminalIds
        : {},
      terminal_panel_open: shouldPersistTerminalRuntime
        ? terminalPanelOpen
        : {},
      terminal_visible: shouldPersistTerminalRuntime ? terminalVisible : false,
      terminal_height: shouldPersistTerminalRuntime ? terminalHeight : 30,
      session_terminal_ids: shouldPersistTerminalRuntime
        ? sessionTerminalIds
        : {},
      session_primary_surface: shouldPersistTerminalRuntime
        ? sessionPrimarySurface
        : {},
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
            pinned_labels: settings.pinnedLabels,
            labels: settings.labels,
          },
        ])
      ),
      github_dashboard_favorite_project_ids: githubDashboardFavoriteProjectIds,
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

    const inputDrafts = uiState.input_drafts ?? {}
    if (Object.keys(inputDrafts).length > 0) {
      logger.debug('Restoring input drafts', {
        count: Object.keys(inputDrafts).length,
      })
      useChatStore.setState({ inputDrafts })
    }

    // Restore unsent image attachments (files already on disk)
    const pendingImagesDraft = uiState.pending_images ?? {}
    if (Object.keys(pendingImagesDraft).length > 0) {
      const restoredImages: Record<string, PendingImage[]> = {}
      for (const [sessionId, images] of Object.entries(pendingImagesDraft)) {
        const valid = images
          .filter(img => img.id && img.path && img.filename)
          .map(img => ({
            id: img.id,
            path: img.path,
            filename: img.filename,
          }))
        if (valid.length > 0) restoredImages[sessionId] = valid
      }
      if (Object.keys(restoredImages).length > 0) {
        logger.debug('Restoring pending images', {
          sessions: Object.keys(restoredImages).length,
        })
        useChatStore.setState({ pendingImages: restoredImages })
      }
    }

    // Restore unsent pasted-text attachments; re-read content from disk when
    // the persisted payload omitted it (normal path to keep UI state small).
    const pendingTextFilesDraft = uiState.pending_text_files ?? {}
    if (Object.keys(pendingTextFilesDraft).length > 0) {
      const restoredTextFiles: Record<string, PendingTextFile[]> = {}
      const needsContentHydration: {
        sessionId: string
        id: string
        path: string
      }[] = []

      for (const [sessionId, textFiles] of Object.entries(
        pendingTextFilesDraft
      )) {
        const valid: PendingTextFile[] = []
        for (const tf of textFiles) {
          if (!tf.id || !tf.path || !tf.filename) continue
          const content = tf.content ?? ''
          valid.push({
            id: tf.id,
            path: tf.path,
            filename: tf.filename,
            size: tf.size ?? 0,
            content,
          })
          if (!tf.content) {
            needsContentHydration.push({
              sessionId,
              id: tf.id,
              path: tf.path,
            })
          }
        }
        if (valid.length > 0) restoredTextFiles[sessionId] = valid
      }

      if (Object.keys(restoredTextFiles).length > 0) {
        logger.debug('Restoring pending text files', {
          sessions: Object.keys(restoredTextFiles).length,
          hydrate: needsContentHydration.length,
        })
        useChatStore.setState({ pendingTextFiles: restoredTextFiles })
      }

      if (needsContentHydration.length > 0) {
        void (async () => {
          for (const item of needsContentHydration) {
            try {
              const result = await invoke<ReadTextResponse>(
                'read_pasted_text',
                {
                  path: item.path,
                }
              )
              useChatStore
                .getState()
                .updatePendingTextFile(
                  item.sessionId,
                  item.id,
                  result.content,
                  result.size
                )
            } catch (error) {
              // File may have been cleaned up; drop the orphaned attachment.
              logger.warn('Failed to restore pasted text content; removing', {
                path: item.path,
                error: String(error),
              })
              useChatStore
                .getState()
                .removePendingTextFile(item.sessionId, item.id)
            }
          }
        })()
      }
    }

    // NOTE: Other session-specific state is loaded from Session files by the
    // useSessionStatePersistence hook.

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

    const restoreTerminalRuntimeState = async (shouldCancel: () => boolean) => {
      if (isLocalBackend() || shouldCancel()) return

      // PHASE 1: Always restore the *user-intent* UI flags for terminal
      // surfaces. These are independent of whether any PTYs survived the
      // previous session — the user expects "I had the panel open" to
      // persist across refresh even if every shell exited. This must run
      // before the early-return below so a refresh with zero persisted
      // terminal instances still restores panel position.
      const persistedPanelOpen = uiState.terminal_panel_open ?? {}
      const persistedModalOpen = uiState.modal_terminal_open ?? {}
      if (shouldCancel()) return
      useTerminalStore.setState(state => ({
        terminalPanelOpen: {
          ...state.terminalPanelOpen,
          ...persistedPanelOpen,
        },
        modalTerminalOpen: {
          ...state.modalTerminalOpen,
          ...persistedModalOpen,
        },
        terminalVisible: uiState.terminal_visible ?? state.terminalVisible,
        terminalHeight: uiState.terminal_height ?? state.terminalHeight,
      }))

      const persistedTerminals = uiState.terminal_instances ?? {}
      const persistedSessionTerminalIds = uiState.session_terminal_ids ?? {}
      const persistedSessionPrimarySurface =
        uiState.session_primary_surface ?? {}
      const hasPersistedTerminalState =
        Object.keys(persistedTerminals).length > 0 ||
        Object.keys(persistedSessionTerminalIds).length > 0
      if (!hasPersistedTerminalState) return

      // PHASE 2: Restore terminal instances + session mappings. This
      // requires the backend to confirm the PTYs are still alive; the
      // race-condition fix in TerminalView guarantees no phantom
      // `start_terminal` will fire while we wait for this query.
      let liveTerminalIds = new Set<string>()
      try {
        liveTerminalIds = new Set(
          await invoke<string[]>('get_active_terminals')
        )
        if (shouldCancel()) return
      } catch (error) {
        if (shouldCancel()) return
        logger.warn('Failed to query active terminals during UI hydrate', {
          error,
        })
        const fallbackTerminalIds = Object.values(persistedTerminals)
          .flat()
          .map(terminal => terminal.id)
        if (fallbackTerminalIds.length === 0 || shouldCancel()) return

        // If the liveness query fails transiently, keep persisted terminal
        // metadata in the store instead of presenting an empty terminal list.
        // TerminalView's auto-create effect runs after uiStateInitialized; an
        // empty list there would spawn a duplicate PTY while the original may
        // still be alive on the backend.
        liveTerminalIds = new Set(fallbackTerminalIds)
      }

      if (shouldCancel()) return

      if (liveTerminalIds.size === 0) {
        if (shouldCancel()) return
        logger.debug('No live terminals to restore after web refresh', {
          persistedTerminalCount: Object.values(persistedTerminals).reduce(
            (sum, list) => sum + list.length,
            0
          ),
          persistedSessionTerminalCount: Object.keys(
            persistedSessionTerminalIds
          ).length,
        })
        // Snapshot any xterm instances the frontend may have already created
        // before hydrate completed (e.g. a phantom shell from TerminalView's
        // auto-create mount effect) so we can dispose them below.
        if (shouldCancel()) return
        const staleInstanceIds: string[] = []
        for (const list of Object.values(
          useTerminalStore.getState().terminals
        )) {
          for (const t of list) staleInstanceIds.push(t.id)
        }
        if (shouldCancel()) return
        useTerminalStore.setState({
          terminals: {},
          activeTerminalIds: {},
          runningTerminals: new Set(),
          failedTerminals: new Set(),
          modalTerminalOpen: {},
          terminalPanelOpen: {},
          terminalVisible: false,
        })
        // Clear any persisted session-terminal mappings — those PTYs are dead.
        // Drop both `sessionTerminalIds[sessionId]` and `sessionPrimarySurface`
        // for affected sessions so the UI falls back to the chat surface.
        if (Object.keys(persistedSessionTerminalIds).length > 0) {
          const deadSessionIds = new Set(
            Object.keys(persistedSessionTerminalIds)
          )
          if (shouldCancel()) return
          useUIStore.setState(state => {
            const nextSessionTerminalIds: Record<string, string> = {}
            for (const [sid, tid] of Object.entries(state.sessionTerminalIds)) {
              if (!deadSessionIds.has(sid)) nextSessionTerminalIds[sid] = tid
            }
            const nextSessionPrimarySurface: Record<
              string,
              'chat' | 'terminal'
            > = {}
            for (const [sid, surface] of Object.entries(
              state.sessionPrimarySurface
            )) {
              if (!deadSessionIds.has(sid)) {
                nextSessionPrimarySurface[sid] = surface
              }
            }
            return {
              sessionTerminalIds: nextSessionTerminalIds,
              sessionPrimarySurface: nextSessionPrimarySurface,
            }
          })
        }
        // Dispose frontend xterm instances + drop their buffered input/output.
        // Dynamic import to avoid a circular dep with terminal-instances.ts.
        if (shouldCancel()) return
        const { disposeTerminal } = await import('@/lib/terminal-instances')
        if (shouldCancel()) return
        for (const id of staleInstanceIds) {
          if (shouldCancel()) return
          await disposeTerminal(id).catch(() => undefined)
        }
        return
      }

      if (shouldCancel()) return

      const restoredTerminals: Record<string, TerminalInstance[]> = {}
      const restoredActiveIds: Record<string, string> = {}
      const restoredPanelOpen: Record<string, boolean> = {}
      const restoredSessionTerminalIds: Record<string, string> = {}
      const restoredSessionPrimarySurface: Record<string, 'chat' | 'terminal'> =
        {}
      const restoredModalOpen = {
        ...useTerminalStore.getState().modalTerminalOpen,
      }

      for (const [worktreeId, list] of Object.entries(persistedTerminals)) {
        const liveList = list
          .filter(terminal => liveTerminalIds.has(terminal.id))
          .map(terminal => ({
            id: terminal.id,
            worktreeId,
            command: terminal.command ?? null,
            commandArgs: terminal.command_args ?? null,
            label: terminal.label,
            kind: terminal.kind ?? 'panel',
          })) satisfies TerminalInstance[]

        if (liveList.length === 0) {
          restoredModalOpen[worktreeId] = false
          continue
        }

        restoredTerminals[worktreeId] = liveList
        const livePanelIds = liveList.filter(isPanelTerminal).map(t => t.id)
        const persistedActiveId = uiState.terminal_active_ids?.[worktreeId]
        if (persistedActiveId && livePanelIds.includes(persistedActiveId)) {
          restoredActiveIds[worktreeId] = persistedActiveId
        } else if (livePanelIds[0]) {
          restoredActiveIds[worktreeId] = livePanelIds[0]
        }

        if (
          (uiState.terminal_panel_open?.[worktreeId] ?? false) &&
          livePanelIds.length > 0
        ) {
          restoredPanelOpen[worktreeId] = true
        }
      }

      const restoredTerminalIds = new Set(
        Object.values(restoredTerminals)
          .flat()
          .map(terminal => terminal.id)
      )
      for (const [sessionId, terminalId] of Object.entries(
        persistedSessionTerminalIds
      )) {
        if (!restoredTerminalIds.has(terminalId)) continue
        restoredSessionTerminalIds[sessionId] = terminalId
        const surface = persistedSessionPrimarySurface[sessionId]
        if (surface === 'terminal' || surface === 'chat') {
          restoredSessionPrimarySurface[sessionId] = surface
        } else {
          restoredSessionPrimarySurface[sessionId] = 'terminal'
        }
      }

      if (Object.keys(restoredTerminals).length === 0) {
        if (shouldCancel()) return
        useTerminalStore.setState({
          modalTerminalOpen: restoredModalOpen,
          terminalPanelOpen: {},
        })
        return
      }

      if (shouldCancel()) return

      logger.info('Restoring live terminal metadata after web refresh', {
        worktreeCount: Object.keys(restoredTerminals).length,
        terminalCount: restoredTerminalIds.size,
      })

      if (shouldCancel()) return
      useTerminalStore.setState(state => ({
        terminals: restoredTerminals,
        activeTerminalIds: restoredActiveIds,
        runningTerminals: new Set(restoredTerminalIds),
        terminalPanelOpen: restoredPanelOpen,
        terminalVisible: uiState.terminal_visible ?? state.terminalVisible,
        terminalHeight: uiState.terminal_height ?? state.terminalHeight,
        modalTerminalOpen: restoredModalOpen,
      }))

      if (Object.keys(restoredSessionTerminalIds).length > 0) {
        if (shouldCancel()) return
        useUIStore.setState(state => ({
          sessionTerminalIds: {
            ...state.sessionTerminalIds,
            ...restoredSessionTerminalIds,
          },
          sessionPrimarySurface: {
            ...state.sessionPrimarySurface,
            ...restoredSessionPrimarySurface,
          },
        }))
      }
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
              pinnedLabels: settings.pinned_labels,
              labels: settings.labels,
            },
          ])
        )
      )
    }

    const githubDashboardFavoriteProjectIds =
      uiState.github_dashboard_favorite_project_ids ?? []
    if (githubDashboardFavoriteProjectIds.length > 0) {
      logger.debug('Restoring GitHub dashboard favorite projects', {
        count: githubDashboardFavoriteProjectIds.length,
      })
      useProjectsStore
        .getState()
        .setGitHubDashboardFavoriteProjectIds(githubDashboardFavoriteProjectIds)
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

    let cancelled = false
    void restoreTerminalRuntimeState(() => cancelled).finally(() => {
      if (cancelled) return
      queueMicrotask(() => {
        if (cancelled) return
        setIsInitialized(true)
        useUIStore.getState().setUIStateInitialized(true)
      })
      logger.info('UI state initialization complete')
    })

    return () => {
      cancelled = true
    }
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
    let prevGitHubDashboardFavoriteProjectIds =
      useProjectsStore.getState().githubDashboardFavoriteProjectIds
    let prevLeftSidebarSize = useUIStore.getState().leftSidebarSize
    let prevLeftSidebarVisible = useUIStore.getState().leftSidebarVisible
    let prevSessionTerminalIds = useUIStore.getState().sessionTerminalIds
    let prevSessionPrimarySurface = useUIStore.getState().sessionPrimarySurface
    let prevWorktreeId = useChatStore.getState().activeWorktreeId
    let prevWorktreePath = useChatStore.getState().activeWorktreePath
    let prevLastActiveWorktreeId = useChatStore.getState().lastActiveWorktreeId
    let prevActiveSessionIds = useChatStore.getState().activeSessionIds
    let prevInputDrafts = useChatStore.getState().inputDrafts
    let prevPendingImages = useChatStore.getState().pendingImages
    let prevPendingTextFiles = useChatStore.getState().pendingTextFiles
    let prevReviewSidebarVisible = useChatStore.getState().reviewSidebarVisible
    let prevLastOpenedPerProject = useChatStore.getState().lastOpenedPerProject
    let prevTerminalInstances = useTerminalStore.getState().terminals
    let prevTerminalActiveIds = useTerminalStore.getState().activeTerminalIds
    let prevTerminalPanelOpen = useTerminalStore.getState().terminalPanelOpen
    let prevTerminalVisible = useTerminalStore.getState().terminalVisible
    let prevTerminalHeight = useTerminalStore.getState().terminalHeight
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
      const githubDashboardFavoritesChanged =
        state.githubDashboardFavoriteProjectIds !==
        prevGitHubDashboardFavoriteProjectIds

      if (
        projectIdsChanged ||
        folderIdsChanged ||
        selectedProjectChanged ||
        accessTimestampsChanged ||
        collapseOverridesChanged ||
        projectCanvasSettingsChanged ||
        githubDashboardFavoritesChanged
      ) {
        prevExpandedProjectIds = state.expandedProjectIds
        prevExpandedFolderIds = state.expandedFolderIds
        prevSelectedProjectId = state.selectedProjectId
        prevProjectAccessTimestamps = state.projectAccessTimestamps
        prevDashboardCollapseOverrides =
          state.dashboardWorktreeCollapseOverrides
        prevProjectCanvasSettings = state.projectCanvasSettings
        prevGitHubDashboardFavoriteProjectIds =
          state.githubDashboardFavoriteProjectIds
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to ui-store changes (sidebar size/visibility and session terminal mapping)
    const unsubUI = useUIStore.subscribe(state => {
      const sizeChanged = state.leftSidebarSize !== prevLeftSidebarSize
      const visibilityChanged =
        state.leftSidebarVisible !== prevLeftSidebarVisible
      const sessionTerminalIdsChanged =
        state.sessionTerminalIds !== prevSessionTerminalIds
      const sessionPrimarySurfaceChanged =
        state.sessionPrimarySurface !== prevSessionPrimarySurface

      if (
        sizeChanged ||
        visibilityChanged ||
        sessionTerminalIdsChanged ||
        sessionPrimarySurfaceChanged
      ) {
        prevLeftSidebarSize = state.leftSidebarSize
        prevLeftSidebarVisible = state.leftSidebarVisible
        prevSessionTerminalIds = state.sessionTerminalIds
        prevSessionPrimarySurface = state.sessionPrimarySurface
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to chat-store changes (active worktree, sessions, input drafts,
    // draft attachments, and worktree-scoped state). Other session-specific
    // state is handled by useSessionStatePersistence.
    const unsubChat = useChatStore.subscribe(state => {
      // Check if active worktree or active sessions changed
      const worktreeChanged =
        state.activeWorktreeId !== prevWorktreeId ||
        state.activeWorktreePath !== prevWorktreePath ||
        state.lastActiveWorktreeId !== prevLastActiveWorktreeId
      const sessionsChanged = state.activeSessionIds !== prevActiveSessionIds
      const inputDraftsChanged = state.inputDrafts !== prevInputDrafts
      const pendingImagesChanged = state.pendingImages !== prevPendingImages
      const pendingTextFilesChanged =
        state.pendingTextFiles !== prevPendingTextFiles
      const reviewSidebarChanged =
        state.reviewSidebarVisible !== prevReviewSidebarVisible
      const lastOpenedChanged =
        state.lastOpenedPerProject !== prevLastOpenedPerProject

      if (
        worktreeChanged ||
        sessionsChanged ||
        inputDraftsChanged ||
        pendingImagesChanged ||
        pendingTextFilesChanged ||
        reviewSidebarChanged ||
        lastOpenedChanged
      ) {
        prevWorktreeId = state.activeWorktreeId
        prevWorktreePath = state.activeWorktreePath
        prevLastActiveWorktreeId = state.lastActiveWorktreeId
        prevActiveSessionIds = state.activeSessionIds
        prevInputDrafts = state.inputDrafts
        prevPendingImages = state.pendingImages
        prevPendingTextFiles = state.pendingTextFiles
        prevReviewSidebarVisible = state.reviewSidebarVisible
        prevLastOpenedPerProject = state.lastOpenedPerProject
        const currentState = getCurrentUIState()
        debouncedSaveRef.current?.(currentState)
      }
    })

    // Subscribe to terminal-store changes (terminal tabs + modal drawer state)
    const unsubTerminal = useTerminalStore.subscribe(state => {
      const terminalsChanged = state.terminals !== prevTerminalInstances
      const activeIdsChanged = state.activeTerminalIds !== prevTerminalActiveIds
      const panelOpenChanged = state.terminalPanelOpen !== prevTerminalPanelOpen
      const terminalVisibleChanged =
        state.terminalVisible !== prevTerminalVisible
      const terminalHeightChanged = state.terminalHeight !== prevTerminalHeight
      const openChanged = state.modalTerminalOpen !== prevModalTerminalOpen
      const dockModeChanged =
        state.modalTerminalDockMode !== prevModalTerminalDockMode
      const widthChanged = state.modalTerminalWidth !== prevModalTerminalWidth
      const heightChanged =
        state.modalTerminalHeight !== prevModalTerminalHeight

      if (
        terminalsChanged ||
        activeIdsChanged ||
        panelOpenChanged ||
        terminalVisibleChanged ||
        terminalHeightChanged ||
        openChanged ||
        dockModeChanged ||
        widthChanged ||
        heightChanged
      ) {
        prevTerminalInstances = state.terminals
        prevTerminalActiveIds = state.activeTerminalIds
        prevTerminalPanelOpen = state.terminalPanelOpen
        prevTerminalVisible = state.terminalVisible
        prevTerminalHeight = state.terminalHeight
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
        if (tabsChanged && isLocalBackend()) {
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
