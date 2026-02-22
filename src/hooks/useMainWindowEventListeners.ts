import { useEffect, useRef } from 'react'
import { listen, invoke } from '@/lib/transport'
import { isNativeApp, isServerMode, isUpdaterDisabled } from '@/lib/environment'
import { notify } from '@/lib/notifications'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { projectsQueryKeys } from '@/services/projects'
import { chatQueryKeys } from '@/services/chat'
import { disposeTerminal } from '@/lib/terminal-instances'
import { toast } from 'sonner'
import { useCommandContext } from './use-command-context'
import { usePreferences } from '@/services/preferences'
import { logger } from '@/lib/logger'
import {
  eventToShortcutString,
  DEFAULT_KEYBINDINGS,
  type KeybindingAction,
  type KeybindingsMap,
} from '@/types/keybindings'

/**
 * Main window event listeners - handles global keyboard shortcuts and other app-level events
 *
 * This hook provides a centralized place for all global event listeners, keeping
 * the MainWindow component clean while maintaining good separation of concerns.
 */
// Execute a keybinding action
function executeKeybindingAction(
  action: KeybindingAction,
  commandContext: ReturnType<typeof useCommandContext>,
  queryClient: QueryClient
) {
  // Canvas-only actions: blocked when the session chat modal is open
  const CANVAS_ONLY_ACTIONS = new Set<KeybindingAction>([
    'new_worktree',
    'open_plan',
    'open_recap',
    'restore_last_archived',
    'focus_canvas_search',
  ])
  if (
    CANVAS_ONLY_ACTIONS.has(action) &&
    useUIStore.getState().sessionChatModalOpen
  ) {
    return
  }

  switch (action) {
    case 'focus_chat_input':
      logger.debug('Keybinding: focus_chat_input')
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
      break
    case 'toggle_left_sidebar': {
      logger.debug('Keybinding: toggle_left_sidebar')
      const { leftSidebarVisible, setLeftSidebarVisible } =
        useUIStore.getState()
      setLeftSidebarVisible(!leftSidebarVisible)
      break
    }
    case 'open_preferences':
      logger.debug('Keybinding: open_preferences')
      commandContext.openPreferences()
      break
    case 'open_commit_modal':
      logger.debug('Keybinding: open_commit_modal')
      commandContext.openCommitModal()
      break
    case 'open_pull_request':
      logger.debug('Keybinding: open_pull_request')
      commandContext.openPullRequest()
      break
    case 'open_git_diff':
      logger.debug('Keybinding: open_git_diff')
      window.dispatchEvent(new CustomEvent('open-git-diff'))
      break
    case 'execute_run': {
      logger.debug('Keybinding: execute_run')
      if (!isServerMode()) break

      const chatStore = useChatStore.getState()
      const uiStore = useUIStore.getState()
      const sessionModalOpen = uiStore.sessionChatModalOpen

      // Resolve target worktree: modal > active worktree > selected worktree (dashboard)
      const targetWorktreeId =
        sessionModalOpen && uiStore.sessionChatModalWorktreeId
          ? uiStore.sessionChatModalWorktreeId
          : (chatStore.activeWorktreeId ??
            useProjectsStore.getState().selectedWorktreeId)

      const targetWorktreePath = targetWorktreeId
        ? (chatStore.activeWorktreePath ??
          chatStore.worktreePaths[targetWorktreeId])
        : null

      if (!targetWorktreeId || !targetWorktreePath) {
        notify('Open a worktree to run', undefined, { type: 'error' })
        break
      }

      // Fetch run script - use fetchQuery to handle uncached dashboard worktrees
      ;(async () => {
        let runScript = queryClient.getQueryData<string | null>([
          'run-script',
          targetWorktreePath,
        ])

        if (runScript === undefined) {
          try {
            runScript = await queryClient.fetchQuery<string | null>({
              queryKey: ['run-script', targetWorktreePath],
              queryFn: () =>
                invoke<string | null>('get_run_script', {
                  worktreePath: targetWorktreePath,
                }),
            })
          } catch {
            runScript = null
          }
        }

        if (!runScript) {
          const projectId = useProjectsStore.getState().selectedProjectId
          toast.error('No run script configured in jean.json', {
            action: projectId
              ? {
                  label: 'Configure',
                  onClick: () =>
                    useProjectsStore
                      .getState()
                      .openProjectSettings(projectId, 'jean-json'),
                }
              : undefined,
          })
          return
        }

        // Start run (works on canvas, modal, or main view)
        useTerminalStore.getState().startRun(targetWorktreeId, runScript)

        // If modal is open, also open the terminal drawer
        if (sessionModalOpen) {
          useTerminalStore
            .getState()
            .setModalTerminalOpen(targetWorktreeId, true)
        }
      })()
      break
    }
    case 'open_in_modal':
      logger.debug('Keybinding: open_in_modal')
      useUIStore.getState().setOpenInModalOpen(true)
      break
    case 'open_magic_modal': {
      logger.debug('Keybinding: open_magic_modal')
      const chatStore = useChatStore.getState()
      const uiStore = useUIStore.getState()
      const {
        activeWorktreeId,
        activeSessionIds,
        sendingSessionIds,
        activeWorktreePath,
      } = chatStore

      // Block only when there's no worktree context at all (e.g., project dashboard with nothing selected)
      const selectedWorktreeId = useProjectsStore.getState().selectedWorktreeId
      const worktreeIdToCheck = selectedWorktreeId ?? activeWorktreeId

      if (!worktreeIdToCheck && !activeWorktreePath) {
        notify('Select a worktree to use magic commands', undefined, {
          type: 'error',
        })
        break
      }

      const activeSessionId = activeWorktreeId
        ? activeSessionIds[activeWorktreeId]
        : null
      const isSending = activeSessionId
        ? (sendingSessionIds[activeSessionId] ?? false)
        : false
      if (!isSending) {
        uiStore.setMagicModalOpen(true)
      }
      break
    }
    case 'new_session':
      logger.debug('Keybinding: new_session')
      window.dispatchEvent(new CustomEvent('create-new-session'))
      break
    case 'next_session':
      logger.debug('Keybinding: next_session')
      window.dispatchEvent(
        new CustomEvent('switch-session', { detail: { direction: 'next' } })
      )
      break
    case 'previous_session':
      logger.debug('Keybinding: previous_session')
      window.dispatchEvent(
        new CustomEvent('switch-session', { detail: { direction: 'previous' } })
      )
      break
    case 'close_session_or_worktree': {
      // If terminal is focused, close the active terminal tab instead
      if (document.activeElement?.closest('.xterm')) {
        const chatStore = useChatStore.getState()
        const wId = chatStore.activeWorktreeId
        if (wId) {
          const termStore = useTerminalStore.getState()
          const activeTerminalId = termStore.activeTerminalIds[wId]
          if (activeTerminalId) {
            invoke('stop_terminal', { terminalId: activeTerminalId }).catch(
              () => {
                /* noop */
              }
            )
            disposeTerminal(activeTerminalId)
            termStore.removeTerminal(wId, activeTerminalId)
            const remaining = termStore.terminals[wId] ?? []
            if (remaining.length === 0) {
              termStore.setTerminalPanelOpen(wId, false)
            }
            break
          }
        }
      }
      // Default: close session/worktree
      logger.debug('Keybinding: close_session_or_worktree')
      window.dispatchEvent(new CustomEvent('close-session-or-worktree'))
      break
    }
    case 'new_worktree':
      logger.debug('Keybinding: new_worktree')
      window.dispatchEvent(new CustomEvent('create-new-worktree'))
      break
    case 'cycle_execution_mode': {
      logger.debug('Keybinding: cycle_execution_mode')
      window.dispatchEvent(new CustomEvent('cycle-execution-mode'))
      break
    }
    case 'approve_plan': {
      logger.debug('Keybinding: approve_plan')
      const planDialogOpen = useUIStore.getState().planDialogOpen
      if (planDialogOpen) break // Let PlanDialog handle it directly
      window.dispatchEvent(new CustomEvent('approve-plan'))
      window.dispatchEvent(new CustomEvent('answer-question'))
      break
    }
    case 'approve_plan_yolo': {
      logger.debug('Keybinding: approve_plan_yolo')
      const planDialogOpenYolo = useUIStore.getState().planDialogOpen
      if (planDialogOpenYolo) break // Let PlanDialog handle it directly
      window.dispatchEvent(new CustomEvent('approve-plan-yolo'))
      break
    }
    case 'open_plan':
      logger.debug('Keybinding: open_plan')
      window.dispatchEvent(new CustomEvent('open-plan'))
      break
    case 'open_recap':
      logger.debug('Keybinding: open_recap')
      window.dispatchEvent(new CustomEvent('open-recap'))
      break
    case 'restore_last_archived':
      logger.debug('Keybinding: restore_last_archived')
      window.dispatchEvent(new CustomEvent('restore-last-archived'))
      break
    case 'focus_canvas_search':
      logger.debug('Keybinding: focus_canvas_search')
      window.dispatchEvent(new CustomEvent('focus-canvas-search'))
      break
    case 'toggle_modal_terminal': {
      logger.debug('Keybinding: toggle_modal_terminal')
      // Only works when session modal is open
      const sessionModalOpen = useUIStore.getState().sessionChatModalOpen
      if (!sessionModalOpen) break
      const { activeWorktreeId } = useChatStore.getState()
      if (activeWorktreeId) {
        useTerminalStore.getState().toggleModalTerminal(activeWorktreeId)
      }
      break
    }
    case 'open_provider_dropdown':
      logger.debug('Keybinding: open_provider_dropdown')
      window.dispatchEvent(new CustomEvent('open-provider-dropdown'))
      break
    case 'open_model_dropdown':
      logger.debug('Keybinding: open_model_dropdown')
      window.dispatchEvent(new CustomEvent('open-model-dropdown'))
      break
    case 'open_thinking_dropdown':
      logger.debug('Keybinding: open_thinking_dropdown')
      window.dispatchEvent(new CustomEvent('open-thinking-dropdown'))
      break
    case 'cancel_prompt':
      logger.debug('Keybinding: cancel_prompt')
      window.dispatchEvent(new CustomEvent('cancel-prompt'))
      break
    case 'toggle_session_label': {
      logger.debug('Keybinding: toggle_session_label')
      // Only works when a session is active (modal open or in session view, not on dashboard canvas)
      const uiStoreForLabel = useUIStore.getState()
      const chatStoreForLabel = useChatStore.getState()
      if (
        !uiStoreForLabel.sessionChatModalOpen &&
        !chatStoreForLabel.activeWorktreePath
      )
        break
      window.dispatchEvent(new CustomEvent('toggle-session-label'))
      break
    }
  }
}

export function useMainWindowEventListeners() {
  const commandContext = useCommandContext()
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()

  // Keep keybindings in a ref so the event handler always has the latest
  const keybindingsRef = useRef<KeybindingsMap>(DEFAULT_KEYBINDINGS)

  // Update ref when preferences change
  useEffect(() => {
    keybindingsRef.current = preferences?.keybindings ?? DEFAULT_KEYBINDINGS
  }, [preferences?.keybindings])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Convert the keyboard event to our shortcut string format
      const shortcut = eventToShortcutString(e)
      if (!shortcut) return

      // Skip single-key shortcuts (no modifier) when focus is in input/textarea
      const hasModifier = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
      if (!hasModifier) {
        const tag = document.activeElement?.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          (document.activeElement as HTMLElement)?.isContentEditable
        ) {
          return
        }
      }

      // Cancel prompt should work even when modals are open
      if (shortcut === keybindingsRef.current.cancel_prompt) {
        logger.debug('Cancel prompt shortcut matched', { shortcut })
        e.preventDefault()
        e.stopPropagation()
        executeKeybindingAction('cancel_prompt', commandContext, queryClient)
        return
      }

      // Skip when a blocking modal/dialog is open - let it handle its own shortcuts
      const uiState = useUIStore.getState()
      if (
        uiState.loadContextModalOpen ||
        uiState.magicModalOpen ||
        uiState.openInModalOpen ||
        uiState.newWorktreeModalOpen ||
        uiState.commandPaletteOpen ||
        uiState.preferencesOpen ||
        uiState.releaseNotesModalOpen ||
        uiState.updatePrModalOpen
      )
        return
      if (useProjectsStore.getState().projectSettingsDialogOpen) return

      // CMD/Ctrl+1–9: switch to session tab by index (hardcoded, like browser tabs)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const digit = parseInt(e.key, 10)
        if (digit >= 1 && digit <= 9) {
          e.preventDefault()
          e.stopPropagation()
          window.dispatchEvent(
            new CustomEvent('switch-session', { detail: { index: digit - 1 } })
          )
          return
        }
      }

      // Look up matching action in keybindings
      const keybindings = keybindingsRef.current
      for (const [action, binding] of Object.entries(keybindings)) {
        if (binding === shortcut) {
          e.preventDefault()
          e.stopPropagation()
          executeKeybindingAction(
            action as KeybindingAction,
            commandContext,
            queryClient
          )
          return
        }
      }
    }

    // Set up native menu event listeners
    const setupMenuListeners = async () => {
      logger.debug('Setting up menu event listeners')
      const unlisteners = await Promise.all([
        listen('menu-about', async () => {
          logger.debug('About menu event received')
          if (!isNativeApp()) return
          const { getVersion } = await import('@tauri-apps/api/app')
          const { message } = await import('@tauri-apps/plugin-dialog')
          // Show simple about dialog with dynamic version
          const appVersion = await getVersion()
          await message(
            `Jean\n\nVersion: ${appVersion}\n\nBuilt with Tauri v2 + React + TypeScript`,
            { title: 'About Jean', kind: 'info' }
          )
        }),

        listen('menu-check-updates', async () => {
          logger.debug('Check for updates menu event received')
          if (!isNativeApp()) return
          if (isUpdaterDisabled()) {
            commandContext.showToast(
              'Updates are disabled for this build',
              'success'
            )
            return
          }
          try {
            const { check } = await import('@tauri-apps/plugin-updater')
            const update = await check()
            if (update) {
              // Pass update object to App.tsx for installation handling
              window.dispatchEvent(
                new CustomEvent('update-available', { detail: update })
              )
              // Show the update modal (same as auto-check on startup)
              useUIStore.getState().setUpdateModalVersion(update.version)
            } else {
              commandContext.showToast(
                'You are running the latest version',
                'success'
              )
            }
          } catch (error) {
            logger.error('Update check failed:', { error: String(error) })
            commandContext.showToast('Failed to check for updates', 'error')
          }
        }),

        listen('menu-preferences', () => {
          logger.debug('Preferences menu event received')
          commandContext.openPreferences()
        }),

        listen('menu-toggle-left-sidebar', () => {
          logger.debug('Toggle left sidebar menu event received')
          const { leftSidebarVisible, setLeftSidebarVisible } =
            useUIStore.getState()
          setLeftSidebarVisible(!leftSidebarVisible)
        }),

        listen('menu-toggle-right-sidebar', () => {
          logger.debug('Toggle right sidebar menu event received')
          const { selectedWorktreeId } = useProjectsStore.getState()
          if (selectedWorktreeId) {
            const { rightSidebarVisible, setRightSidebarVisible } =
              useUIStore.getState()
            setRightSidebarVisible(!rightSidebarVisible)
          }
        }),

        // Branch naming events (automatic branch renaming based on first message)
        listen<{ worktree_id: string; old_branch: string; new_branch: string }>(
          'branch-renamed',
          event => {
            logger.info('Branch renamed', {
              worktreeId: event.payload.worktree_id,
              oldBranch: event.payload.old_branch,
              newBranch: event.payload.new_branch,
            })
            // Invalidate worktrees queries to refresh the worktree name in the UI
            queryClient.invalidateQueries({
              queryKey: projectsQueryKeys.all,
            })
          }
        ),

        listen<{ worktree_id: string; error: string; stage: string }>(
          'branch-naming-failed',
          event => {
            logger.warn('Branch naming failed', {
              worktreeId: event.payload.worktree_id,
              error: event.payload.error,
              stage: event.payload.stage,
            })
            // Silent failure - don't show toast to avoid interrupting workflow
          }
        ),

        // Session naming events (automatic session renaming based on first message)
        listen<{
          session_id: string
          worktree_id: string
          old_name: string
          new_name: string
        }>('session-renamed', event => {
          logger.info('Session renamed', {
            sessionId: event.payload.session_id,
            worktreeId: event.payload.worktree_id,
            oldName: event.payload.old_name,
            newName: event.payload.new_name,
          })
          // Invalidate sessions query to refresh the session name in the UI
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(event.payload.worktree_id),
          })
        }),

        listen<{
          session_id: string
          worktree_id: string
          error: string
          stage: string
        }>('session-naming-failed', event => {
          logger.warn('Session naming failed', {
            sessionId: event.payload.session_id,
            worktreeId: event.payload.worktree_id,
            error: event.payload.error,
            stage: event.payload.stage,
          })
          // Silent failure - don't show toast to avoid interrupting workflow
        }),

        // Real-time cache sync between native + web clients
        listen<{ keys: string[] }>('cache:invalidate', event => {
          const { keys } = event.payload
          for (const key of keys) {
            switch (key) {
              case 'sessions':
                queryClient.invalidateQueries({
                  queryKey: chatQueryKeys.all,
                })
                break
              case 'projects':
                queryClient.invalidateQueries({
                  queryKey: projectsQueryKeys.all,
                })
                break
              case 'preferences':
                queryClient.invalidateQueries({
                  queryKey: ['preferences'],
                })
                break
              case 'ui-state':
                queryClient.invalidateQueries({
                  queryKey: ['ui-state'],
                })
                break
              case 'contexts':
                queryClient.invalidateQueries({
                  queryKey: ['contexts'],
                })
                // Also invalidate saved contexts list
                queryClient.invalidateQueries({
                  queryKey: ['saved-contexts'],
                })
                break
            }
          }
        }),
      ])

      logger.debug(
        `Menu listeners set up successfully: ${unlisteners.length} listeners`
      )
      return unlisteners
    }

    // Use capture phase to handle keybindings before dialogs/modals can intercept
    document.addEventListener('keydown', handleKeyDown, { capture: true })

    let cleaned = false
    let menuUnlisteners: (() => void)[] = []
    setupMenuListeners()
      .then(unlisteners => {
        if (cleaned) {
          // Effect was already cleaned up while awaiting — tear down immediately
          unlisteners.forEach(fn => fn())
          return
        }
        menuUnlisteners = unlisteners
        logger.debug('Menu listeners initialized successfully')
      })
      .catch(error => {
        logger.error('Failed to setup menu listeners:', error)
      })

    return () => {
      cleaned = true
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      menuUnlisteners.forEach(unlisten => {
        if (unlisten && typeof unlisten === 'function') {
          unlisten()
        }
      })
    }
  }, [commandContext, queryClient])

  // Quit confirmation for system-level close events (Alt+F4, taskbar close).
  // The X button handles its own confirmation via window-close command,
  // but system close events still go through onCloseRequested.
  useEffect(() => {
    // Skip in development mode - only block quit in production
    if (import.meta.env.DEV) return
    if (!isServerMode()) return

    let unlisten: (() => void) | null = null

    const setup = async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      getCurrentWindow()
        .onCloseRequested(async event => {
          try {
            const hasRunning = await Promise.race([
              invoke<boolean>('has_running_sessions'),
              new Promise<boolean>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 2000)
              ),
            ])
            if (hasRunning) {
              event.preventDefault()
              window.dispatchEvent(
                new CustomEvent('quit-confirmation-requested')
              )
            }
          } catch (error) {
            logger.error('Failed to check running sessions', { error })
            // Allow quit if we can't check (fail open)
          }
        })
        .then(fn => {
          unlisten = fn
        })
        .catch(error => {
          logger.error('Failed to setup close listener', { error })
        })
    }

    setup()

    return () => {
      unlisten?.()
    }
  }, [])
}
