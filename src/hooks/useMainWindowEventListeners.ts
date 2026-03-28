import { useEffect, useRef } from 'react'
import { listen, invoke } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import { notify } from '@/lib/notifications'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { projectsQueryKeys } from '@/services/projects'
import { chatQueryKeys } from '@/services/chat'
import type { QueuedMessage } from '@/types/chat'
import { disposeTerminal, startHeadless } from '@/lib/terminal-instances'
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

export function getTerminalShortcutWorktreeId(): string | null {
  const activeElement = document.activeElement
  const terminalFocused =
    activeElement instanceof HTMLElement && !!activeElement.closest('.xterm')

  if (!terminalFocused) return null

  const uiState = useUIStore.getState()
  const chatState = useChatStore.getState()
  const terminalState = useTerminalStore.getState()

  const worktreeId = uiState.sessionChatModalOpen
    ? (uiState.sessionChatModalWorktreeId ?? chatState.activeWorktreeId)
    : chatState.activeWorktreeId

  if (!worktreeId) return null

  const terminalOpen =
    terminalState.terminalPanelOpen[worktreeId] ||
    terminalState.modalTerminalOpen[worktreeId]

  return terminalOpen ? worktreeId : null
}

export function addTerminalTabForShortcut(): boolean {
  const worktreeId = getTerminalShortcutWorktreeId()
  if (!worktreeId) return false

  useTerminalStore.getState().addTerminal(worktreeId)
  return true
}

export function closeActiveTerminalTabForShortcut(): boolean {
  const worktreeId = getTerminalShortcutWorktreeId()
  if (!worktreeId) return false

  const terminalStore = useTerminalStore.getState()
  const activeTerminalId = terminalStore.activeTerminalIds[worktreeId]

  if (!activeTerminalId) return true

  invoke('stop_terminal', { terminalId: activeTerminalId }).catch(() => {
    /* noop */
  })
  disposeTerminal(activeTerminalId)
  terminalStore.removeTerminal(worktreeId, activeTerminalId)

  const remaining = useTerminalStore.getState().terminals[worktreeId] ?? []
  if (remaining.length === 0) {
    terminalStore.setTerminalPanelOpen(worktreeId, false)
    terminalStore.setTerminalVisible(false)
    terminalStore.setModalTerminalOpen(worktreeId, false)
  }

  return true
}

export function switchActiveTerminalTabByIndexForShortcut(
  index: number
): boolean {
  const worktreeId = getTerminalShortcutWorktreeId()
  if (!worktreeId) return false

  const terminalStore = useTerminalStore.getState()
  const terminals = terminalStore.terminals[worktreeId] ?? []
  const targetTerminal = terminals[index]

  if (targetTerminal) {
    terminalStore.setActiveTerminal(worktreeId, targetTerminal.id)
  }

  return true
}

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
    case 'open_git_diff':
      logger.debug('Keybinding: open_git_diff')
      window.dispatchEvent(new CustomEvent('open-git-diff'))
      break
    case 'execute_run': {
      logger.debug('Keybinding: execute_run')
      if (!isNativeApp()) break

      // Skip if git diff modal is open
      const uiStore = useUIStore.getState()
      if (uiStore.gitDiffModalOpen) break

      const chatStore = useChatStore.getState()
      const sessionModalOpen = uiStore.sessionChatModalOpen

      // Resolve target worktree: modal > active worktree > selected worktree (canvas/dashboard)
      const targetWorktreeId =
        sessionModalOpen && uiStore.sessionChatModalWorktreeId
          ? uiStore.sessionChatModalWorktreeId
          : (chatStore.activeWorktreeId ??
            useProjectsStore.getState().selectedWorktreeId)

      // Resolve path: chat store first, then fall back to worktrees query cache (canvas)
      let targetWorktreePath = targetWorktreeId
        ? (chatStore.activeWorktreePath ??
          chatStore.worktreePaths[targetWorktreeId])
        : null

      if (!targetWorktreePath && targetWorktreeId) {
        const projectId = useProjectsStore.getState().selectedProjectId
        if (projectId) {
          const worktrees = queryClient.getQueryData<
            { id: string; path: string }[]
          >(projectsQueryKeys.worktrees(projectId))
          targetWorktreePath =
            worktrees?.find(w => w.id === targetWorktreeId)?.path ?? null
        }
      }

      if (!targetWorktreeId || !targetWorktreePath) {
        notify('Open a worktree to run', undefined, { type: 'error' })
        break
      }

      // Fetch run scripts - use fetchQuery to handle uncached dashboard worktrees
      ;(async () => {
        let runScripts = queryClient.getQueryData<string[]>([
          'run-scripts',
          targetWorktreePath,
        ])

        if (runScripts === undefined) {
          try {
            runScripts = await queryClient.fetchQuery<string[]>({
              queryKey: ['run-scripts', targetWorktreePath],
              queryFn: () =>
                invoke<string[]>('get_run_scripts', {
                  worktreePath: targetWorktreePath,
                }),
            })
          } catch {
            runScripts = []
          }
        }

        const firstScript = runScripts?.[0]
        if (!firstScript) {
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

        // Start run
        const terminalId = useTerminalStore
          .getState()
          .startRun(targetWorktreeId, firstScript)

        if (sessionModalOpen) {
          // Modal view: open terminal drawer
          useTerminalStore
            .getState()
            .setModalTerminalOpen(targetWorktreeId, true)
        } else {
          // Canvas view: start PTY headlessly (no terminal UI mounted yet)
          startHeadless(terminalId, {
            worktreeId: targetWorktreeId,
            worktreePath: targetWorktreePath!,
            command: firstScript,
          })
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
      const { activeWorktreeId, activeWorktreePath } = chatStore

      // Block only when there's no worktree context at all (e.g., project dashboard with nothing selected)
      const selectedWorktreeId = useProjectsStore.getState().selectedWorktreeId
      const worktreeIdToCheck = selectedWorktreeId ?? activeWorktreeId

      if (!worktreeIdToCheck && !activeWorktreePath) {
        notify('Select a worktree to use magic commands', undefined, {
          type: 'error',
        })
        break
      }

      uiStore.setMagicModalOpen(true)
      break
    }
    case 'new_session': {
      // When terminal is focused, CMD+T should create a terminal tab.
      if (addTerminalTabForShortcut()) break
      logger.debug('Keybinding: new_session')
      window.dispatchEvent(new CustomEvent('create-new-session'))
      break
    }
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
      // When terminal is focused, CMD+W should close the active terminal tab.
      if (closeActiveTerminalTabForShortcut()) break
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
    case 'approve_plan_clear_context': {
      logger.debug('Keybinding: approve_plan_clear_context')
      const planDialogOpenClear = useUIStore.getState().planDialogOpen
      if (planDialogOpenClear) break // Let PlanDialog handle it directly
      window.dispatchEvent(new CustomEvent('approve-plan-clear-context'))
      break
    }
    case 'approve_plan_clear_context_build': {
      logger.debug('Keybinding: approve_plan_clear_context_build')
      const planDialogOpenClearBuild = useUIStore.getState().planDialogOpen
      if (planDialogOpenClearBuild) break // Let PlanDialog handle it directly
      window.dispatchEvent(new CustomEvent('approve-plan-clear-context-build'))
      break
    }
    case 'approve_plan_worktree_build': {
      logger.debug('Keybinding: approve_plan_worktree_build')
      const planDialogOpenWtBuild = useUIStore.getState().planDialogOpen
      if (planDialogOpenWtBuild) break
      window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))
      break
    }
    case 'approve_plan_worktree_yolo': {
      logger.debug('Keybinding: approve_plan_worktree_yolo')
      const planDialogOpenWtYolo = useUIStore.getState().planDialogOpen
      if (planDialogOpenWtYolo) break
      window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))
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
    case 'open_unread_sessions':
      logger.debug('Keybinding: open_unread_sessions')
      window.dispatchEvent(new CustomEvent('command:open-unread-sessions'))
      break
    case 'toggle_terminal': {
      logger.debug('Keybinding: toggle_terminal')
      const uiState = useUIStore.getState()
      if (uiState.sessionChatModalOpen) {
        // Modal view → sheet drawer
        const wid =
          uiState.sessionChatModalWorktreeId ??
          useChatStore.getState().activeWorktreeId
        if (wid) useTerminalStore.getState().toggleModalTerminal(wid)
      } else {
        // Standalone view → resizable panel
        const wid = useChatStore.getState().activeWorktreeId
        if (wid) useTerminalStore.getState().toggleTerminal(wid)
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
    case 'scroll_chat_up':
      window.dispatchEvent(
        new CustomEvent('scroll-chat', { detail: { direction: 'up' } })
      )
      break
    case 'scroll_chat_down':
      window.dispatchEvent(
        new CustomEvent('scroll-chat', { detail: { direction: 'down' } })
      )
      break
    case 'open_github_dashboard':
      useUIStore.getState().setGitHubDashboardOpen(true)
      break
    case 'open_quick_menu':
      window.dispatchEvent(new CustomEvent('toggle-quick-menu'))
      break
    case 'open_usage_dropdown':
      window.dispatchEvent(new CustomEvent('toggle-usage-menu'))
      break
    case 'toggle_session_label': {
      logger.debug('Keybinding: toggle_session_label')
      // Works when a session is active (modal open or in session view) or on project canvas
      const uiStoreForLabel = useUIStore.getState()
      const chatStoreForLabel = useChatStore.getState()
      const projectsStoreForLabel = useProjectsStore.getState()
      if (
        !uiStoreForLabel.sessionChatModalOpen &&
        !chatStoreForLabel.activeWorktreePath &&
        !projectsStoreForLabel.selectedProjectId
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
    keybindingsRef.current = {
      ...DEFAULT_KEYBINDINGS,
      ...(preferences?.keybindings ?? {}),
    }
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

      // When terminal is focused, remap shortcuts for terminal-specific actions
      // and block all others so they don't interfere with terminal usage.
      {
        const terminalShortcutWorktreeId = getTerminalShortcutWorktreeId()

        if (terminalShortcutWorktreeId) {
          const kb = keybindingsRef.current
          const digitMatch = e.code.match(/^Digit(\d)$/)
          const digit = digitMatch ? parseInt(digitMatch[1]!, 10) : NaN

          if (
            (e.metaKey || e.ctrlKey) &&
            !e.shiftKey &&
            !e.altKey &&
            digit >= 1 &&
            digit <= 9
          ) {
            e.preventDefault()
            e.stopPropagation()
            switchActiveTerminalTabByIndexForShortcut(digit - 1)
            return
          }

          if (shortcut === kb.new_session) {
            e.preventDefault()
            e.stopPropagation()
            addTerminalTabForShortcut()
            return
          }
          if (shortcut === kb.close_session_or_worktree) {
            e.preventDefault()
            e.stopPropagation()
            closeActiveTerminalTabForShortcut()
            return
          }
          if (
            shortcut === kb.toggle_terminal ||
            shortcut === kb.cancel_prompt
          ) {
            // Let these fall through to the normal keybinding handler below
          } else {
            // Block all other shortcuts
            return
          }
        }
      }

      // CMD/Ctrl+1–9: switch session tabs (when modal open), dashboard tabs, or worktree by index
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        // Use e.code (physical key) since e.key can vary with CMD held on macOS
        const digitMatch = e.code.match(/^Digit(\d)$/)
        const digit = digitMatch ? parseInt(digitMatch[1]!, 10) : NaN
        if (digit >= 1 && digit <= 9) {
          e.preventDefault()
          e.stopPropagation()
          if (useUIStore.getState().sessionChatModalOpen) {
            window.dispatchEvent(
              new CustomEvent('switch-session', {
                detail: { index: digit - 1 },
              })
            )
          } else if (
            useUIStore.getState().githubDashboardOpen &&
            digit >= 1 &&
            digit <= 4
          ) {
            const TAB_MAP = ['issues', 'prs', 'security', 'advisories']
            window.dispatchEvent(
              new CustomEvent('switch-dashboard-tab', {
                detail: { tab: TAB_MAP[digit - 1] },
              })
            )
          } else {
            window.dispatchEvent(
              new CustomEvent('open-worktree-by-index', {
                detail: { index: digit - 1 },
              })
            )
          }
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

        listen('menu-magic-menu', () => {
          logger.debug('Magic menu event received from native menu')
          executeKeybindingAction(
            'open_magic_modal',
            commandContext,
            queryClient
          )
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

        // Queue sync between native + web clients.
        // When another client enqueues/dequeues, update local Zustand state.
        listen<{ sessionId: string; queue: QueuedMessage[] }>(
          'queue:updated',
          event => {
            const { sessionId, queue } = event.payload
            const currentQueue =
              useChatStore.getState().messageQueues[sessionId] ?? []
            // Skip if the queue already matches (this client caused the event)
            if (
              currentQueue.length === queue.length &&
              currentQueue[0]?.id === queue[0]?.id
            )
              return
            useChatStore.setState(state => ({
              messageQueues: {
                ...state.messageQueues,
                [sessionId]: queue,
              },
            }))
          }
        ),

        // Real-time cache sync between native + web clients.
        // Debounce: collect keys over a 250ms window, then flush once.
        // This coalesces rapid-fire events (e.g. bulk mutations) into a
        // single invalidation wave instead of N separate ones.
        (async () => {
          const pendingKeys = new Set<string>()
          let flushTimer: ReturnType<typeof setTimeout> | null = null

          const flushInvalidations = () => {
            flushTimer = null
            for (const key of pendingKeys) {
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
                  queryClient.invalidateQueries({
                    queryKey: ['saved-contexts'],
                  })
                  break
              }
            }
            pendingKeys.clear()
          }

          const unlisten = await listen<{ keys: string[] }>(
            'cache:invalidate',
            event => {
              for (const key of event.payload.keys) pendingKeys.add(key)
              if (flushTimer) clearTimeout(flushTimer)
              flushTimer = setTimeout(flushInvalidations, 250)
            }
          )

          // Return a cleanup function that clears the pending timer
          // and unregisters the event listener
          return () => {
            if (flushTimer) clearTimeout(flushTimer)
            unlisten()
          }
        })(),
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
    if (!isNativeApp()) return

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
