import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  invoke,
  useWsConnectionStatus,
  useWsAuthError,
  preloadInitialData,
  type InitialData,
} from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import { projectsQueryKeys } from '@/services/projects'
import { chatQueryKeys } from '@/services/chat'
import type { WorktreeSessions } from '@/types/chat'
import { initializeCommandSystem } from './lib/commands'
import { logger } from './lib/logger'
import { toast } from 'sonner'
import { cleanupOldFiles } from './lib/recovery'
import './App.css'
import MainWindow from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import ErrorBoundary from './components/ErrorBoundary'
import { useClaudeCliStatus, useClaudeCliAuth } from './services/claude-cli'
import { useCodexCliStatus, useCodexCliAuth } from './services/codex-cli'
import { useGhCliStatus, useGhCliAuth } from './services/gh-cli'
import { useOpencodeCliStatus, useOpencodeCliAuth } from './services/opencode-cli'
import { useUIStore } from './store/ui-store'
import type { AppPreferences } from './types/preferences'
import { useChatStore } from './store/chat-store'
import { useFontSettings } from './hooks/use-font-settings'
import { useZoom } from './hooks/use-zoom'
import { useImmediateSessionStateSave } from './hooks/useImmediateSessionStateSave'
import { useCliVersionCheck } from './hooks/useCliVersionCheck'
import { useQueueProcessor } from './hooks/useQueueProcessor'
import { useAutoArchiveOnMerge } from './hooks/useAutoArchiveOnMerge'
import useStreamingEvents from './components/chat/hooks/useStreamingEvents'
import { preloadAllSounds } from './lib/sounds'

/** Loading screen shown while preloading initial data (browser mode only). */
function WebLoadingScreen() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    </div>
  )
}

/** Small fixed badge showing WebSocket connection status (browser mode only). */
function WsStatusBadge() {
  const connected = useWsConnectionStatus()
  const authError = useWsAuthError()

  if (authError) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
        <div className="mx-4 max-w-md rounded-lg border border-destructive/50 bg-background p-6 shadow-lg">
          <div className="flex items-center gap-2 text-destructive">
            <svg
              className="size-5 shrink-0"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <h2 className="text-sm font-semibold">Connection Failed</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{authError}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed bottom-2 right-2 z-50 flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium shadow-sm ring-1 ring-border/50 backdrop-blur-sm">
      <span
        className={`inline-block size-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
      />
      <span className="text-muted-foreground">
        {connected ? 'Connected' : 'Reconnecting\u2026'}
      </span>
    </div>
  )
}

function App() {
  // Track preloading state for web view
  const [isPreloading, setIsPreloading] = useState(!isNativeApp())
  const queryClient = useQueryClient()

  // Holds the update object so the title bar indicator can trigger install later
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingUpdateRef = useRef<any>(null)

  const installAppUpdate = useCallback(
    async (update: {
      version: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      downloadAndInstall: (cb: (event: any) => void) => Promise<void>
    }) => {
      let totalBytes = 0
      let downloadedBytes = 0
      const toastId = toast.loading(`Downloading update ${update.version}...`)

      // Clear the pending indicator since we're installing now
      useUIStore.getState().setPendingUpdateVersion(null)
      pendingUpdateRef.current = null

      try {
        await update.downloadAndInstall(event => {
          switch (event.event) {
            case 'Started':
              totalBytes = event.data.contentLength ?? 0
              logger.info(`Downloading ${totalBytes} bytes`)
              break
            case 'Progress':
              downloadedBytes += event.data.chunkLength
              if (totalBytes > 0) {
                const percent = Math.round((downloadedBytes / totalBytes) * 100)
                toast.loading(`Downloading update... ${percent}%`, {
                  id: toastId,
                })
              }
              break
            case 'Finished':
              logger.info('Download complete, installing...')
              toast.loading('Installing update...', { id: toastId })
              break
          }
        })

        toast.success(`Update ${update.version} installed!`, {
          id: toastId,
          duration: Infinity,
          action: {
            label: 'Restart',
            onClick: async () => {
              const { relaunch } = await import('@tauri-apps/plugin-process')
              await relaunch()
            },
          },
        })
      } catch (updateError) {
        const errorStr = String(updateError)
        logger.error(`Update installation failed: ${errorStr}`)
        if (errorStr.includes('invalid updater binary format')) {
          toast.error(
            `Auto-update not supported for this installation type. Please update manually.`,
            { id: toastId, duration: 8000 }
          )
        } else {
          toast.error(`Update failed: ${errorStr}`, {
            id: toastId,
            duration: 8000,
          })
        }
      }
    },
    []
  )

  // Preload initial data via HTTP for web view (faster than waiting for WebSocket)
  useEffect(() => {
    if (isNativeApp()) return

    const seedCache = (data: InitialData) => {
      // Seed projects into TanStack Query cache
      if (data.projects) {
        queryClient.setQueryData(projectsQueryKeys.list(), data.projects)
      }
      // Seed worktrees for each project
      if (data.worktreesByProject) {
        for (const [projectId, worktrees] of Object.entries(
          data.worktreesByProject
        )) {
          queryClient.setQueryData(
            projectsQueryKeys.worktrees(projectId),
            worktrees
          )
        }
      }
      // Seed sessions for each worktree (WorktreeSessions struct)
      // Also restore Zustand state for reviewing/waiting status
      if (data.sessionsByWorktree) {
        const reviewingUpdates: Record<string, boolean> = {}
        const waitingUpdates: Record<string, boolean> = {}
        const sessionMappings: Record<string, string> = {}
        const worktreePaths: Record<string, string> = {}

        for (const [worktreeId, sessionsData] of Object.entries(
          data.sessionsByWorktree
        )) {
          queryClient.setQueryData(
            chatQueryKeys.sessions(worktreeId),
            sessionsData
          )

          // Extract session state for Zustand store
          const wts = sessionsData as WorktreeSessions
          for (const session of wts.sessions) {
            sessionMappings[session.id] = worktreeId
            if (session.is_reviewing) {
              reviewingUpdates[session.id] = true
            }
            if (session.waiting_for_input) {
              waitingUpdates[session.id] = true
            }
          }
        }

        // Get worktree paths from worktreesByProject
        if (data.worktreesByProject) {
          for (const worktrees of Object.values(data.worktreesByProject)) {
            for (const wt of worktrees as { id: string; path: string }[]) {
              if (wt.id && wt.path) {
                worktreePaths[wt.id] = wt.path
              }
            }
          }
        }

        // Update Zustand store with session state
        const currentState = useChatStore.getState()
        const storeUpdates: Partial<ReturnType<typeof useChatStore.getState>> =
          {}

        if (Object.keys(sessionMappings).length > 0) {
          storeUpdates.sessionWorktreeMap = {
            ...currentState.sessionWorktreeMap,
            ...sessionMappings,
          }
        }
        if (Object.keys(worktreePaths).length > 0) {
          storeUpdates.worktreePaths = {
            ...currentState.worktreePaths,
            ...worktreePaths,
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
        if (Object.keys(storeUpdates).length > 0) {
          useChatStore.setState(storeUpdates)
        }
      }
      // Seed active sessions (with full chat history/messages)
      if (data.activeSessions) {
        for (const [sessionId, session] of Object.entries(
          data.activeSessions
        )) {
          queryClient.setQueryData(chatQueryKeys.session(sessionId), session)
        }
      }
      // Note: Git status is included in worktree cached_* fields, no separate cache needed
      // Seed preferences into cache
      if (data.preferences) {
        queryClient.setQueryData(['preferences'], data.preferences)
      }
      // Seed UI state into cache
      if (data.uiState) {
        queryClient.setQueryData(['ui-state'], data.uiState)
      }
    }

    preloadInitialData()
      .then(data => {
        if (data) {
          logger.info('Preloaded initial data via HTTP', {
            projects: Array.isArray(data.projects) ? data.projects.length : 0,
          })
          seedCache(data)
        }
      })
      .catch(err => {
        logger.warn('Failed to preload initial data', { error: err })
      })
      .finally(() => {
        setIsPreloading(false)
      })
  }, [queryClient])

  // Apply font settings from preferences
  useFontSettings()

  // Apply zoom level from preferences + keyboard shortcuts
  useZoom()

  // Save reviewing/waiting state immediately (no debounce) to ensure persistence on reload
  useImmediateSessionStateSave()

  // Check for CLI updates on startup (shows toast notification if updates available)
  useCliVersionCheck()

  // Global streaming event listeners - must be at App level so they stay active
  // even when ChatWindow is unmounted (e.g., when viewing session board)
  useStreamingEvents({ queryClient })

  // Global queue processor - must be at App level so queued messages execute
  // even when the worktree is not focused (ChatWindow unmounted)
  useQueueProcessor()

  // Auto-archive worktrees when their PR is merged (if enabled in preferences)
  useAutoArchiveOnMerge()

  // When WebSocket connects (browser mode), invalidate queries that weren't preloaded
  // so they refetch with the now-available backend. Skip preloaded data.
  const wsConnected = useWsConnectionStatus()
  useEffect(() => {
    if (!isNativeApp() && wsConnected) {
      logger.info('WebSocket connected, invalidating dynamic queries')
      // Invalidate everything except what we preloaded
      queryClient.invalidateQueries({
        predicate: query => {
          const key = query.queryKey[0]
          // Skip invalidating preloaded data (projects, worktrees, sessions, chat, preferences, ui-state)
          return (
            key !== 'projects' &&
            key !== 'preferences' &&
            key !== 'ui-state' &&
            key !== 'chat'
          )
        },
      })
    }
  }, [wsConnected, queryClient])

  // Add native-app class to body for desktop-only CSS (cursor, user-select, etc.)
  useEffect(() => {
    if (isNativeApp()) {
      document.body.classList.add('native-app')
    }
  }, [])

  // Check CLI installation status
  const { data: claudeStatus, isLoading: isClaudeStatusLoading } =
    useClaudeCliStatus()
  const { data: codexStatus, isLoading: isCodexStatusLoading } =
    useCodexCliStatus()
  const { data: opencodeStatus, isLoading: isOpencodeStatusLoading } =
    useOpencodeCliStatus()
  const { data: ghStatus, isLoading: isGhStatusLoading } = useGhCliStatus()

  // Check CLI authentication status (only when installed)
  const { data: claudeAuth, isLoading: isClaudeAuthLoading } = useClaudeCliAuth(
    { enabled: !!claudeStatus?.installed }
  )
  const { data: codexAuth, isLoading: isCodexAuthLoading } = useCodexCliAuth({
    enabled: !!codexStatus?.installed,
  })
  const { data: opencodeAuth, isLoading: isOpencodeAuthLoading } =
    useOpencodeCliAuth({
      enabled: !!opencodeStatus?.installed,
    })
  const { data: ghAuth, isLoading: isGhAuthLoading } = useGhCliAuth({
    enabled: !!ghStatus?.installed,
  })

  // Show onboarding if GitHub CLI is not ready, or no AI backend is ready.
  // Only in native app - web view uses the desktop's CLIs via WebSocket
  useEffect(() => {
    if (!isNativeApp()) return

    const isLoading =
      isClaudeStatusLoading ||
      isCodexStatusLoading ||
      isOpencodeStatusLoading ||
      isGhStatusLoading ||
      (claudeStatus?.installed && isClaudeAuthLoading) ||
      (codexStatus?.installed && isCodexAuthLoading) ||
      (opencodeStatus?.installed && isOpencodeAuthLoading) ||
      (ghStatus?.installed && isGhAuthLoading)
    if (isLoading) return

    const ghReady = !!ghStatus?.installed && !!ghAuth?.authenticated
    const claudeReady = !!claudeStatus?.installed && !!claudeAuth?.authenticated
    const codexReady = !!codexStatus?.installed && !!codexAuth?.authenticated
    const opencodeReady =
      !!opencodeStatus?.installed && !!opencodeAuth?.authenticated
    const hasAiBackendReady = claudeReady || codexReady || opencodeReady

    if (useUIStore.getState().onboardingDismissed) return

    if (!ghReady || !hasAiBackendReady) {
      logger.info('CLI setup needed, showing onboarding', {
        claudeInstalled: claudeStatus?.installed,
        codexInstalled: codexStatus?.installed,
        opencodeInstalled: opencodeStatus?.installed,
        ghInstalled: ghStatus?.installed,
        claudeAuth: claudeAuth?.authenticated,
        codexAuth: codexAuth?.authenticated,
        opencodeAuth: opencodeAuth?.authenticated,
        ghAuth: ghAuth?.authenticated,
      })
      useUIStore.getState().setOnboardingOpen(true)
    } else {
      // CLIs already set up — show feature tour if not yet seen
      const prefs = queryClient.getQueryData<AppPreferences>(['preferences'])
      if (prefs && !prefs.has_seen_feature_tour) {
        useUIStore.getState().setFeatureTourOpen(true)
      }
    }
  }, [
    claudeStatus,
    codexStatus,
    opencodeStatus,
    ghStatus,
    claudeAuth,
    codexAuth,
    opencodeAuth,
    ghAuth,
    isClaudeStatusLoading,
    isCodexStatusLoading,
    isOpencodeStatusLoading,
    isGhStatusLoading,
    isClaudeAuthLoading,
    isCodexAuthLoading,
    isOpencodeAuthLoading,
    isGhAuthLoading,
    queryClient,
  ])

  // Show feature tour after CLI onboarding completes (first launch or manual trigger)
  useEffect(() => {
    let wasOpen = useUIStore.getState().onboardingOpen
    const unsub = useUIStore.subscribe(state => {
      const isOpen = state.onboardingOpen
      if (wasOpen && !isOpen) {
        const store = useUIStore.getState()
        // Don't show feature tour if user dismissed onboarding without completing setup
        if (store.onboardingDismissed) {
          store.setOnboardingManuallyTriggered(false)
        } else {
          const manuallyTriggered = store.onboardingManuallyTriggered
          const prefs = queryClient.getQueryData<AppPreferences>(['preferences'])
          if (manuallyTriggered || (prefs && !prefs.has_seen_feature_tour)) {
            store.setOnboardingManuallyTriggered(false)
            setTimeout(() => {
              useUIStore.getState().setFeatureTourOpen(true)
            }, 300)
          }
        }
      }
      wasOpen = isOpen
    })
    return unsub
  }, [queryClient])

  // Kill all terminals on page refresh/close (backup for Rust-side cleanup)
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Best-effort sync cleanup for refresh scenarios
      // Note: async operations may not complete, but Rust-side RunEvent::Exit
      // will handle proper cleanup on app quit
      invoke('kill_all_terminals').catch(() => {
        /* noop */
      })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    logger.info('🚀 Frontend application starting up')
    initializeCommandSystem()
    logger.debug('Command system initialized')

    // Preload notification sounds for instant playback
    preloadAllSounds()

    // Kill any orphaned terminals from previous session/reload
    // This ensures cleanup even if beforeunload didn't complete
    invoke<number>('kill_all_terminals')
      .then(killed => {
        if (killed > 0) {
          logger.info(
            `Cleaned up ${killed} orphaned terminal(s) from previous session`
          )
        }
      })
      .catch(error => {
        logger.warn('Failed to cleanup orphaned terminals', { error })
      })

    // Clean up old recovery files on startup
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // Check for and resume any detached Claude sessions that are still running
    interface ResumableSession {
      session_id: string
      worktree_id: string
      run_id: string
      user_message: string
      resumable: boolean
    }
    invoke<ResumableSession[]>('check_resumable_sessions')
      .then(resumable => {
        if (resumable.length > 0) {
          logger.info('Found resumable sessions', { count: resumable.length })
          // Resume each session
          for (const session of resumable) {
            logger.info('Resuming session', {
              session_id: session.session_id,
              worktree_id: session.worktree_id,
            })
            // Mark session as sending to show streaming UI
            useChatStore.getState().addSendingSession(session.session_id)
            // Resume the session (this will start tailing the output file)
            invoke('resume_session', {
              sessionId: session.session_id,
              worktreeId: session.worktree_id,
            }).catch(error => {
              logger.error('Failed to resume session', {
                session_id: session.session_id,
                error,
              })
              useChatStore.getState().removeSendingSession(session.session_id)
            })
          }
        }
      })
      .catch(error => {
        logger.error('Failed to check resumable sessions', { error })
      })

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })

    // Auto-updater logic - check for updates 5 seconds after app loads
    const checkForUpdates = async () => {
      if (!isNativeApp()) return
      // Don't re-show modal if user already dismissed an update
      if (useUIStore.getState().pendingUpdateVersion) return

      try {
        const { check } = await import('@tauri-apps/plugin-updater')

        const update = await check()
        if (update) {
          logger.info(`Update available: ${update.version}`)
          pendingUpdateRef.current = update
          useUIStore.getState().setUpdateModalVersion(update.version)
        }
      } catch (checkError) {
        logger.error(`Update check failed: ${String(checkError)}`)
        // Silent fail for update checks - don't bother user with network issues
      }
    }

    // Listen for install trigger from title bar indicator
    const handleInstallPending = () => {
      if (pendingUpdateRef.current) {
        installAppUpdate(pendingUpdateRef.current)
      }
    }
    window.addEventListener('install-pending-update', handleInstallPending)

    // Listen for update object from manual "Check for Updates" menu
    const handleUpdateAvailable = (e: Event) => {
      pendingUpdateRef.current = (e as CustomEvent).detail
    }
    window.addEventListener('update-available', handleUpdateAvailable)

    // Check for updates 5 seconds after app loads, then every 30 minutes
    const updateTimer = setTimeout(checkForUpdates, 5000)
    const updateInterval = setInterval(checkForUpdates, 30 * 60 * 1000)
    return () => {
      clearTimeout(updateTimer)
      clearInterval(updateInterval)
      window.removeEventListener('install-pending-update', handleInstallPending)
      window.removeEventListener('update-available', handleUpdateAvailable)
    }
  }, [installAppUpdate])

  // Show loading screen while preloading initial data (web view only)
  if (isPreloading) {
    return <WebLoadingScreen />
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MainWindow />
        {!isNativeApp() && <WsStatusBadge />}
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
