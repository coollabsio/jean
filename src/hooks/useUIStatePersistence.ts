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
import { toRawLocalResourceId } from '@/lib/server-resource'
import type { BrowserTab } from '@/types/browser'
import type {
  PendingFile,
  PendingImage,
  PendingSkill,
  PendingTextFile,
  ReadTextResponse,
  SendMessageArgs,
} from '@/types/chat'
import type {
  PendingImageDraft,
  PendingTextFileDraft,
  UIState,
} from '@/types/ui-state'
import { registerUIStateRelaunchSaver } from '@/lib/ui-state-relaunch'

const getPinnedCanvasSettings = () =>
  Object.fromEntries(
    Object.entries(useProjectsStore.getState().projectCanvasSettings).flatMap(
      ([projectId, settings]) =>
        settings.pinnedLabels && settings.pinnedLabels.length > 0
          ? [[projectId, { pinned_labels: settings.pinnedLabels }] as const]
          : []
    )
  )

/** Serialize ready (non-loading) pending images for UI-state persistence. */
function serializePendingImages(
  pendingImages: Record<string, PendingImage[]>
): Record<string, PendingImageDraft[]> {
  const out: Record<string, PendingImageDraft[]> = {}
  for (const [sessionId, images] of Object.entries(pendingImages)) {
    const ready = images.flatMap(img =>
      !img.loading && img.path
        ? [{ id: img.id, path: img.path, filename: img.filename }]
        : []
    )
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
): T & { cancel: () => void; flush: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: Parameters<T> | null = null

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId !== null) clearTimeout(timeoutId)
    pendingArgs = args
    timeoutId = setTimeout(() => {
      timeoutId = null
      const argsToApply = pendingArgs
      pendingArgs = null
      if (argsToApply) fn(...(argsToApply as Parameters<T>))
    }, delay)
  }) as T & { cancel: () => void; flush: () => void }

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    pendingArgs = null
  }

  debounced.flush = () => {
    if (timeoutId === null || pendingArgs === null) return

    clearTimeout(timeoutId)
    timeoutId = null
    const argsToApply = pendingArgs
    pendingArgs = null
    fn(...(argsToApply as Parameters<T>))
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
  const { mutateAsync: saveUIState } = useSaveUIState()
  const [isInitialized, setIsInitialized] = useState(false)

  // Create stable debounced save function. The UI state snapshot is built
  // when the timer fires (or is flushed), not on every store change, so bursts
  // of store updates only serialize the state once.
  const debouncedSaveRef = useRef<ReturnType<
    typeof debounce<() => void>
  > | null>(null)

  // The last active session is part of the debounced UI-state snapshot. Flush
  // it when the native window is closing so a recent session switch is not
  // lost before the next 500ms timer fires.
  useEffect(() => {
    const flushPendingSave = () => {
      debouncedSaveRef.current?.flush()
    }

    window.addEventListener('beforeunload', flushPendingSave)
    window.addEventListener('pagehide', flushPendingSave)

    return () => {
      window.removeEventListener('beforeunload', flushPendingSave)
      window.removeEventListener('pagehide', flushPendingSave)
    }
  }, [])

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
      pendingFiles,
      pendingSkills,
      dismissedSetupScripts,
      reviewSidebarVisible,
      lastOpenedPerProject,
      autoResume,
      lastSentArgs,
    } = useChatStore.getState()
    // Persist only armed sessions that still have replayable send args.
    const autoResumeForPersist = Object.entries(autoResume).flatMap(
      ([sessionId, resumeAtMs]) => {
        const sendArgs = lastSentArgs[sessionId]
        return sendArgs
          ? [
              {
                session_id: sessionId,
                resume_at_ms: resumeAtMs,
                send_args: sendArgs,
              },
            ]
          : []
      }
    )
    const { selectedProjectId } = useProjectsStore.getState()
    const {
      sessionTerminalIds,
      sessionPrimarySurface,
      seenFailedWorkflowRunIds,
    } = useUIStore.getState()
    const { terminals, activeTerminalIds } = useTerminalStore.getState()
    const shouldPersistTerminalRuntime = !isLocalBackend()
    const terminalInstancesForPersist = shouldPersistTerminalRuntime
      ? Object.fromEntries(
          Object.entries(terminals).flatMap(([worktreeId, list]) => {
            if (list.length === 0) return []
            return [
              [
                worktreeId,
                list.map(terminal => ({
                  id: terminal.id,
                  command: terminal.command,
                  command_args: terminal.commandArgs ?? null,
                  label: terminal.label,
                  kind: terminal.kind ?? 'panel',
                  session_id: terminal.sessionId,
                })),
              ] as const,
            ]
          })
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
      active_session_ids: activeSessionIds,
      input_drafts: inputDrafts,
      pending_images: serializePendingImages(pendingImages),
      pending_text_files: serializePendingTextFiles(pendingTextFiles),
      pending_files: Object.fromEntries(
        Object.entries(pendingFiles).map(([sessionId, files]) => [
          sessionId,
          files.map(file => ({
            id: file.id,
            relative_path: file.relativePath,
            source_root_path: file.sourceRootPath,
            source_project_id: file.sourceProjectId,
            source_project_name: file.sourceProjectName,
            extension: file.extension,
            is_directory: file.isDirectory,
          })),
        ])
      ),
      pending_skills: pendingSkills,
      dismissed_setup_scripts: Object.keys(dismissedSetupScripts),
      // Review sidebar visibility
      review_sidebar_visible: reviewSidebarVisible,
      // Modal terminal drawer state
      // Terminal runtime state (web access only; native app restart must not auto-spawn old shells)
      terminal_instances: terminalInstancesForPersist,
      terminal_active_ids: shouldPersistTerminalRuntime
        ? activeTerminalIds
        : {},
      session_terminal_ids: shouldPersistTerminalRuntime
        ? sessionTerminalIds
        : {},
      session_primary_surface: shouldPersistTerminalRuntime
        ? sessionPrimarySurface
        : {},
      // Browser pane state (per-worktree tabs + 3-surface visibility)
      browser_tabs: browserTabsForPersist,
      browser_active_tab_ids: browserState.activeTabIds,
      project_canvas_settings: getPinnedCanvasSettings(),
      // Pinned recent sessions change only through set_recent_session_pinned.
      // Last opened worktree+session per project (convert camelCase → snake_case keys)
      last_opened_per_project: Object.fromEntries(
        Object.entries(lastOpenedPerProject).map(([projectId, entry]) => [
          projectId,
          { worktree_id: entry.worktreeId, session_id: entry.sessionId },
        ])
      ),
      seen_failed_workflow_run_ids: seenFailedWorkflowRunIds,
      auto_resume: autoResumeForPersist,
      version: 1, // Reset for first release
    }
  }, [])

  // Initialize debounced save function
  useEffect(() => {
    debouncedSaveRef.current = debounce(() => {
      logger.debug('Saving UI state (debounced)')
      void saveUIState(getCurrentUIState())
    }, 500)

    return () => {
      debouncedSaveRef.current?.flush()
      debouncedSaveRef.current?.cancel()
    }
  }, [getCurrentUIState, saveUIState])

  useEffect(() => {
    registerUIStateRelaunchSaver(async () => {
      debouncedSaveRef.current?.cancel()
      await saveUIState(getCurrentUIState())
    })

    return () => registerUIStateRelaunchSaver(null)
  }, [getCurrentUIState, saveUIState])

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

    // Restore file browser size (must be at least 150px to be valid)
    if (uiState.file_browser_size != null && uiState.file_browser_size >= 150) {
      logger.debug('Restoring file browser size', {
        size: uiState.file_browser_size,
      })
      useUIStore.getState().setFileBrowserSize(uiState.file_browser_size)
    }

    // Restore file browser visibility
    if (uiState.file_browser_visible !== undefined) {
      logger.debug('Restoring file browser visibility', {
        visible: uiState.file_browser_visible,
      })
      useUIStore.getState().setFileBrowserVisible(uiState.file_browser_visible)
    }

    if (uiState.zen_mode !== undefined) {
      useUIStore.getState().setZenMode(uiState.zen_mode)
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
        setActiveSession(
          toRawLocalResourceId(worktreeId),
          toRawLocalResourceId(sessionId),
          { markOpened: false }
        )
      }
    }

    const inputDrafts = uiState.input_drafts ?? {}
    if (Object.keys(inputDrafts).length > 0) {
      logger.debug('Restoring input drafts', {
        count: Object.keys(inputDrafts).length,
      })
      useChatStore.setState({ inputDrafts })
    }

    const dismissedSetupScripts = Object.fromEntries(
      (uiState.dismissed_setup_scripts ?? []).map(worktreeId => [
        worktreeId,
        true,
      ])
    )

    const restoredFiles: Record<string, PendingFile[]> = {}
    for (const [sessionId, files] of Object.entries(
      uiState.pending_files ?? {}
    )) {
      const valid = files.flatMap(file =>
        file.id && file.relative_path
          ? [
              {
                id: file.id,
                relativePath: file.relative_path,
                sourceRootPath: file.source_root_path,
                sourceProjectId: file.source_project_id,
                sourceProjectName: file.source_project_name,
                extension: file.extension,
                isDirectory: file.is_directory,
              },
            ]
          : []
      )
      if (valid.length > 0) restoredFiles[sessionId] = valid
    }
    const restoredSkills: Record<string, PendingSkill[]> = {}
    for (const [sessionId, skills] of Object.entries(
      uiState.pending_skills ?? {}
    )) {
      const valid = skills.filter(skill => skill.id && skill.name && skill.path)
      if (valid.length > 0) restoredSkills[sessionId] = valid
    }
    useChatStore.setState({
      pendingFiles: restoredFiles,
      pendingSkills: restoredSkills,
    })
    if (Object.keys(dismissedSetupScripts).length > 0) {
      useChatStore.setState({ dismissedSetupScripts })
    }

    // Restore unsent image attachments (files already on disk)
    const pendingImagesDraft = uiState.pending_images ?? {}
    if (Object.keys(pendingImagesDraft).length > 0) {
      const restoredImages: Record<string, PendingImage[]> = {}
      for (const [sessionId, images] of Object.entries(pendingImagesDraft)) {
        const valid = images.flatMap(img =>
          img.id && img.path && img.filename
            ? [{ id: img.id, path: img.path, filename: img.filename }]
            : []
        )
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
        // Independent per-file disk reads; Zustand functional updates are safe
        // when completions interleave.
        void Promise.all(
          needsContentHydration.map(async item => {
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
          })
        )
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
        terminalVisibleByWorktree: Object.fromEntries(
          Object.keys(persistedPanelOpen).map(worktreeId => [
            worktreeId,
            uiState.terminal_visible ?? false,
          ])
        ),
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
          terminalVisibleByWorktree: {},
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
        // Independent terminal dispose; order does not matter
        await Promise.all(
          staleInstanceIds.map(id => disposeTerminal(id).catch(() => undefined))
        )
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
        const liveList = list.flatMap(terminal =>
          liveTerminalIds.has(terminal.id)
            ? [
                {
                  id: terminal.id,
                  worktreeId,
                  command: terminal.command ?? null,
                  commandArgs: terminal.command_args ?? null,
                  label: terminal.label,
                  kind: terminal.kind ?? 'panel',
                  sessionId: terminal.session_id ?? undefined,
                },
              ]
            : []
        ) satisfies TerminalInstance[]

        if (liveList.length === 0) {
          restoredModalOpen[worktreeId] = false
          continue
        }

        restoredTerminals[worktreeId] = liveList
        const livePanelIds = liveList.flatMap(t =>
          isPanelTerminal(t) ? [t.id] : []
        )
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
        terminalVisibleByWorktree: Object.fromEntries(
          Object.keys(restoredPanelOpen).map(worktreeId => [
            worktreeId,
            uiState.terminal_visible ?? false,
          ])
        ),
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

    useProjectsStore
      .getState()
      .setPinnedRecentSessionIds(uiState.pinned_recent_session_ids ?? [])

    const seenFailedWorkflowRunIds = uiState.seen_failed_workflow_run_ids ?? []
    if (seenFailedWorkflowRunIds.length > 0) {
      logger.debug('Restoring seen failed workflow run IDs', {
        count: seenFailedWorkflowRunIds.length,
      })
      useUIStore
        .getState()
        .setSeenFailedWorkflowRunIds(seenFailedWorkflowRunIds)
    }

    // Restore armed auto-continue sessions (sessionId → reset epoch ms) plus
    // their replayable send args. The watcher (useAutoResume) fires them.
    const persistedAutoResume = uiState.auto_resume ?? []
    if (persistedAutoResume.length > 0) {
      const autoResume: Record<string, number | null> = {}
      const lastSentArgs: Record<string, SendMessageArgs> = {}
      for (const entry of persistedAutoResume) {
        if (!entry?.session_id || !entry.send_args) continue
        autoResume[entry.session_id] = entry.resume_at_ms ?? null
        lastSentArgs[entry.session_id] = entry.send_args
      }
      if (Object.keys(autoResume).length > 0) {
        logger.debug('Restoring armed auto-continue sessions', {
          count: Object.keys(autoResume).length,
        })
        useChatStore.setState(state => ({
          autoResume: { ...state.autoResume, ...autoResume },
          lastSentArgs: { ...state.lastSentArgs, ...lastSentArgs },
        }))
      }
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
          {
            worktreeId: toRawLocalResourceId(entry.worktree_id),
            sessionId: toRawLocalResourceId(entry.session_id),
          },
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

  // Pinned recent sessions are shared across native and web clients. Apply
  // them again whenever another client's change refetches the UI state.
  useEffect(() => {
    if (!isInitialized || !uiState) return
    useProjectsStore
      .getState()
      .setPinnedRecentSessionIds(uiState.pinned_recent_session_ids ?? [])
  }, [isInitialized, uiState])

  // Step 2: Subscribe to store changes and save (debounced)
  useEffect(() => {
    // Don't start saving until we've initialized from persisted state
    if (!isInitialized) return

    // Track previous values to detect actual changes
    let prevSelectedProjectId = useProjectsStore.getState().selectedProjectId
    let prevPinnedCanvasSettings = JSON.stringify(getPinnedCanvasSettings())
    let prevSessionTerminalIds = useUIStore.getState().sessionTerminalIds
    let prevSessionPrimarySurface = useUIStore.getState().sessionPrimarySurface
    let prevSeenFailedWorkflowRunIds =
      useUIStore.getState().seenFailedWorkflowRunIds
    let prevWorktreeId = useChatStore.getState().activeWorktreeId
    let prevWorktreePath = useChatStore.getState().activeWorktreePath
    let prevLastActiveWorktreeId = useChatStore.getState().lastActiveWorktreeId
    let prevActiveSessionIds = useChatStore.getState().activeSessionIds
    let prevInputDrafts = useChatStore.getState().inputDrafts
    let prevPendingImages = useChatStore.getState().pendingImages
    let prevPendingTextFiles = useChatStore.getState().pendingTextFiles
    let prevPendingFiles = useChatStore.getState().pendingFiles
    let prevPendingSkills = useChatStore.getState().pendingSkills
    let prevDismissedSetupScripts =
      useChatStore.getState().dismissedSetupScripts
    let prevReviewSidebarVisible = useChatStore.getState().reviewSidebarVisible
    let prevLastOpenedPerProject = useChatStore.getState().lastOpenedPerProject
    let prevAutoResume = useChatStore.getState().autoResume
    let prevTerminalInstances = useTerminalStore.getState().terminals
    let prevTerminalActiveIds = useTerminalStore.getState().activeTerminalIds
    let prevBrowserTabs = useBrowserStore.getState().tabs
    let prevBrowserActiveTabIds = useBrowserStore.getState().activeTabIds

    // Subscribe to projects-store changes (expanded projects, folders, and selected project)
    const unsubProjects = useProjectsStore.subscribe(state => {
      // Check if expandedProjectIds, expandedFolderIds, or selectedProjectId changed
      const selectedProjectChanged =
        state.selectedProjectId !== prevSelectedProjectId
      const nextPinnedCanvasSettings = JSON.stringify(getPinnedCanvasSettings())
      const pinnedCanvasSettingsChanged =
        nextPinnedCanvasSettings !== prevPinnedCanvasSettings

      if (selectedProjectChanged || pinnedCanvasSettingsChanged) {
        prevSelectedProjectId = state.selectedProjectId
        prevPinnedCanvasSettings = nextPinnedCanvasSettings
        debouncedSaveRef.current?.()
      }
    })

    // Subscribe to ui-store changes (sidebar size/visibility and session terminal mapping)
    const unsubUI = useUIStore.subscribe(state => {
      const sessionTerminalIdsChanged =
        state.sessionTerminalIds !== prevSessionTerminalIds
      const sessionPrimarySurfaceChanged =
        state.sessionPrimarySurface !== prevSessionPrimarySurface
      const seenFailedWorkflowRunIdsChanged =
        state.seenFailedWorkflowRunIds !== prevSeenFailedWorkflowRunIds

      if (
        sessionTerminalIdsChanged ||
        sessionPrimarySurfaceChanged ||
        seenFailedWorkflowRunIdsChanged
      ) {
        prevSessionTerminalIds = state.sessionTerminalIds
        prevSessionPrimarySurface = state.sessionPrimarySurface
        prevSeenFailedWorkflowRunIds = state.seenFailedWorkflowRunIds
        debouncedSaveRef.current?.()
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
      const pendingFilesChanged = state.pendingFiles !== prevPendingFiles
      const pendingSkillsChanged = state.pendingSkills !== prevPendingSkills
      const dismissedSetupScriptsChanged =
        state.dismissedSetupScripts !== prevDismissedSetupScripts
      const reviewSidebarChanged =
        state.reviewSidebarVisible !== prevReviewSidebarVisible
      const lastOpenedChanged =
        state.lastOpenedPerProject !== prevLastOpenedPerProject
      const autoResumeChanged = state.autoResume !== prevAutoResume

      if (
        worktreeChanged ||
        sessionsChanged ||
        inputDraftsChanged ||
        pendingImagesChanged ||
        pendingTextFilesChanged ||
        pendingFilesChanged ||
        pendingSkillsChanged ||
        dismissedSetupScriptsChanged ||
        reviewSidebarChanged ||
        lastOpenedChanged ||
        autoResumeChanged
      ) {
        prevWorktreeId = state.activeWorktreeId
        prevWorktreePath = state.activeWorktreePath
        prevLastActiveWorktreeId = state.lastActiveWorktreeId
        prevActiveSessionIds = state.activeSessionIds
        prevInputDrafts = state.inputDrafts
        prevPendingImages = state.pendingImages
        prevPendingTextFiles = state.pendingTextFiles
        prevPendingFiles = state.pendingFiles
        prevPendingSkills = state.pendingSkills
        prevDismissedSetupScripts = state.dismissedSetupScripts
        prevReviewSidebarVisible = state.reviewSidebarVisible
        prevLastOpenedPerProject = state.lastOpenedPerProject
        prevAutoResume = state.autoResume
        debouncedSaveRef.current?.()
      }
    })

    // Subscribe to terminal-store changes (terminal tabs + modal drawer state)
    const unsubTerminal = useTerminalStore.subscribe(state => {
      const terminalsChanged = state.terminals !== prevTerminalInstances
      const activeIdsChanged = state.activeTerminalIds !== prevTerminalActiveIds
      if (terminalsChanged || activeIdsChanged) {
        prevTerminalInstances = state.terminals
        prevTerminalActiveIds = state.activeTerminalIds
        debouncedSaveRef.current?.()
      }
    })

    // Subscribe to backend-owned browser tab state. Pane layout is client-local.
    const unsubBrowser = useBrowserStore.subscribe(state => {
      const tabsChanged = state.tabs !== prevBrowserTabs
      const activeChanged = state.activeTabIds !== prevBrowserActiveTabIds

      if (tabsChanged || activeChanged) {
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
        debouncedSaveRef.current?.()
      }
    })

    logger.debug('UI state persistence subscriptions active')

    return () => {
      unsubProjects()
      unsubUI()
      unsubChat()
      unsubTerminal()
      unsubBrowser()
      debouncedSaveRef.current?.flush()
      debouncedSaveRef.current?.cancel()
      logger.debug('UI state persistence subscriptions cleaned up')
    }
  }, [isInitialized])

  return { isInitialized }
}
