import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  connectTransport,
  ingestBootstrapEvents,
  invoke,
  useWsConnectionStatus,
  useWsAuthError,
  preloadInitialData,
  setAppDataDir,
  hasPreloadedData,
  listen,
  onEstablishedWsDisconnect,
  usesWebSocketBackend,
  type InitialData,
} from '@/lib/transport'
import {
  isLocalBackend,
  isNativeApp,
  setNativeOpenAllowed,
} from '@/lib/environment'
import { useNativeWindowCloseGuard } from '@/hooks/useNativeWindowCloseGuard'
import { QuitConfirmationDialog } from '@/components/layout/QuitConfirmationDialog'
import { setServerPlatform } from '@/lib/platform'
import { projectsQueryKeys } from '@/services/projects'
import { chatQueryKeys } from '@/services/chat'
import { mergeWorktreesPreservingOptimistic } from '@/lib/worktree-list-cache'
import type { Session, WorktreeSessions } from '@/types/chat'
import type { Worktree } from '@/types/projects'
import { initializeCommandSystem } from './lib/commands'
import { logger } from './lib/logger'
import { toast } from 'sonner'
import { cleanupOldFiles } from './lib/recovery'
import './App.css'
import MainWindow from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import ErrorBoundary from './components/ErrorBoundary'
import { useClaudeCliStatus, useClaudeCliAuth } from './services/claude-cli'
import {
  useCodexCliStatus,
  useCodexCliAuth,
  useCodexUsageUpdateListener,
} from './services/codex-cli'
import { useGhCliStatus, useGhCliAuth } from './services/gh-cli'
import {
  useOpencodeCliStatus,
  useOpencodeCliAuth,
} from './services/opencode-cli'
import { useUIStore } from './store/ui-store'
import {
  resolveInstallPendingAction,
  shouldOfferUpdateCheck,
} from './lib/app-update'
import type { AppPreferences } from './types/preferences'
import { useChatStore } from './store/chat-store'
import { useProjectsStore } from './store/projects-store'
import { useFontSettings } from './hooks/use-font-settings'
import { usePreventFileDropNavigation } from './hooks/usePreventFileDropNavigation'
import { useLinuxFileDrop } from './hooks/useLinuxFileDrop'
import { useZoom } from './hooks/use-zoom'
import { useImmediateSessionStateSave } from './hooks/useImmediateSessionStateSave'
import { useCliVersionCheck } from './hooks/useCliVersionCheck'
import { useServerUpdateCheck } from './hooks/useServerUpdateCheck'
import { useQueueProcessor } from './hooks/useQueueProcessor'
import { useBackgroundInvestigation } from './hooks/useBackgroundInvestigation'
import { useAutoArchiveOnMerge } from './hooks/useAutoArchiveOnMerge'
import { useMagicPromptAutoDefaults } from './hooks/useMagicPromptAutoDefaults'
import { usePreferences } from './services/preferences'
import useStreamingEvents from './components/chat/hooks/useStreamingEvents'
import { hydrateRunningSnapshot } from './lib/hydrate-running-snapshot'
import { preloadAllSounds } from './lib/sounds'
import {
  beginSessionStateHydration,
  endSessionStateHydration,
} from './lib/session-state-hydration'
import { scheduleIdleWork } from './lib/idle'
import { isWindows } from './lib/platform'
import { checkWebClientVersion } from './lib/web-client-version'
import {
  collectExecutionModes,
  collectWorktreePaths,
} from './lib/initial-data-cache'
import { useExternalLinkInterceptor } from './hooks/useExternalLinkInterceptor'
import { WebAccessAuthScreen } from './components/web/WebAccessAuthScreen'
import { peekWebReloadState, saveWebReloadState } from './lib/web-reload-state'
import {
  clearConnectionSwitch,
  getActiveRemoteConnection,
  isConnectionSwitchPending,
} from './lib/remote-connections'
import { RemoteConnectionRecovery } from './components/remote/RemoteConnectionRecovery'
import { getStartupOnboardingAction } from './lib/startup-onboarding'

interface AutoFixStoppedEvent {
  projectId: string
  projectName: string
  backend: string
  error: string
}

function WebLoadingScreen({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background">
      <p
        role="status"
        className="whitespace-nowrap text-[16px] leading-[26px] text-muted-foreground"
        style={{
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        {label}
      </p>
    </div>
  )
}

/** Full-screen auth error overlay for web access mode. */
function WsAuthErrorOverlay() {
  const authError = useWsAuthError()
  const remote = getActiveRemoteConnection()

  if (!authError) return null

  if (remote) {
    return <RemoteConnectionRecovery connection={remote} error={authError} />
  }

  const handleTokenSubmit = (token: string) => {
    localStorage.setItem('jean-http-token', token)
    window.location.reload()
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/90">
      <WebAccessAuthScreen
        authError={authError}
        onTokenSubmit={handleTokenSubmit}
      />
    </div>
  )
}

function App() {
  const webBackend = usesWebSocketBackend()
  const wsAuthError = useWsAuthError()
  // Track preloading state for web view
  const [isPreloading, setIsPreloading] = useState(webBackend)
  const [platformVersion, setPlatformVersion] = useState(0)
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const onboardingOpen = useUIStore(state => state.onboardingOpen)
  const featureTourOpen = useUIStore(state => state.featureTourOpen)
  const jeanMcpIntroOpen = useUIStore(state => state.jeanMcpIntroOpen)
  const hasStartedTransportRef = useRef(false)

  // Keep quit working during preloading and server-switch overlays (MainWindow
  // may be unmounted). Production-only; uses destroy() so Windows cannot
  // silently ignore close while an async handler is registered.
  useNativeWindowCloseGuard()

  const captureWebReloadState = useCallback(() => {
    const { sessionChatModalOpen, sessionChatModalWorktreeId } =
      useUIStore.getState()
    if (!sessionChatModalOpen || !sessionChatModalWorktreeId) return

    const { selectedProjectId } = useProjectsStore.getState()
    const { activeSessionIds, worktreePaths } = useChatStore.getState()
    const activeSessionId = activeSessionIds[sessionChatModalWorktreeId]
    const modalWorktreePath = worktreePaths[sessionChatModalWorktreeId]
    if (!selectedProjectId || !activeSessionId || !modalWorktreePath) return

    saveWebReloadState({
      projectId: selectedProjectId,
      modalWorktreeId: sessionChatModalWorktreeId,
      modalWorktreePath,
      activeSessionId,
    })
  }, [])

  // Prevent a stray file drop from navigating the webview to file:// (which
  // would lock the whole window). Always-on catch-all for views without their
  // own drop handler.
  usePreventFileDropNavigation()

  // Linux: route OS file drops (intercepted in Rust) to a terminal or the chat.
  useLinuxFileDrop()

  // Holds the update object so the title bar indicator can trigger install later
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingUpdateRef = useRef<any>(null)

  useEffect(() => {
    invoke<'mac' | 'windows' | 'linux'>('get_server_platform')
      .then(platform => {
        setServerPlatform(platform)
        setPlatformVersion(version => version + 1)
      })
      .catch(error => {
        logger.warn('Failed to load server platform', { error })
      })
  }, [webBackend])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<AutoFixStoppedEvent>('auto-fix:stopped', event => {
      const { projectName, backend, error } = event.payload
      toast.error(`Mr. Robot stopped for ${projectName}`, {
        description: `${backend}: ${error}`,
        duration: Infinity,
        closeButton: true,
      })
    }).then(fn => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [])

  const relaunchApp = useCallback(async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  }, [])

  const installAppUpdate = useCallback(
    async (update: {
      version: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      downloadAndInstall: (cb: (event: any) => void) => Promise<void>
    }) => {
      const ui = useUIStore.getState()

      // Already installed this session — only relaunch is needed (#507).
      if (ui.updateReadyVersion) {
        await relaunchApp()
        return
      }
      if (ui.isUpdateInstalling) {
        return
      }

      let totalBytes = 0
      let downloadedBytes = 0
      const toastId = toast.loading(`Downloading update ${update.version}...`)

      // Mark in-progress so auto-check cannot re-open the modal mid-download.
      // Keep pendingUpdateRef + version badge until success so retries work and
      // the title bar still shows progress (#507).
      ui.setIsUpdateInstalling(true)
      ui.setPendingUpdateVersion(update.version)
      ui.setUpdateModalVersion(null)

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

        // Package is on disk; app must relaunch. Clear the download handle and
        // record ready state so further UI actions relaunch instead of re-downloading.
        pendingUpdateRef.current = null
        const store = useUIStore.getState()
        store.setIsUpdateInstalling(false)
        store.setUpdateReadyVersion(update.version)
        store.setUpdateModalVersion(null)
        store.setPendingUpdateVersion(null)

        toast.success(`Update ${update.version} installed!`, {
          id: toastId,
          duration: Infinity,
          action: {
            label: 'Restart',
            onClick: () => {
              void relaunchApp()
            },
          },
        })
      } catch (updateError) {
        const errorStr = String(updateError)
        logger.error(`Update installation failed: ${errorStr}`)
        const store = useUIStore.getState()
        store.setIsUpdateInstalling(false)
        // Restore title-bar badge so the user can retry without waiting for re-check
        store.setPendingUpdateVersion(update.version)
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
    [relaunchApp]
  )

  /** Native shell: run Tauri updater when a web client requests desktop install. */
  const runNativeDesktopUpdateInstall = useCallback(async () => {
    if (!isNativeApp()) return
    try {
      if (pendingUpdateRef.current) {
        await installAppUpdate(pendingUpdateRef.current)
        return
      }
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) {
        toast.success('You are running the latest version')
        useUIStore.getState().setPendingUpdateVersion(null)
        useUIStore.getState().setUpdateModalVersion(null)
        return
      }
      pendingUpdateRef.current = update
      await installAppUpdate(update)
    } catch (error) {
      logger.error('Host-requested desktop update failed', { error })
      toast.error(`Update failed: ${String(error)}`, { duration: 8000 })
    }
  }, [installAppUpdate])

  // Seed TanStack Query cache and Zustand state from bulk initial data.
  const seedCache = useCallback(
    (data: InitialData) => {
      const runningSnapshotMessages: {
        sessionId: string
        message: Session['messages'][number]
      }[] = []

      if (data.serverPlatform) {
        setServerPlatform(data.serverPlatform)
      }
      if (typeof data.nativeOpenAllowed === 'boolean') {
        setNativeOpenAllowed(data.nativeOpenAllowed)
      }
      // Force a re-render so non-reactive environment helpers (platform,
      // canOpenNativeApps) update UI after /api/init.
      if (data.serverPlatform || typeof data.nativeOpenAllowed === 'boolean') {
        setPlatformVersion(version => version + 1)
      }

      // Seed projects into TanStack Query cache
      if (data.projects) {
        queryClient.setQueryData(projectsQueryKeys.list(), data.projects)
      }
      // Seed worktrees for each project (preserve in-flight pending/deleting)
      if (data.worktreesByProject) {
        for (const [projectId, worktrees] of Object.entries(
          data.worktreesByProject
        )) {
          const previous = queryClient.getQueryData<Worktree[]>(
            projectsQueryKeys.worktrees(projectId)
          )
          queryClient.setQueryData(
            projectsQueryKeys.worktrees(projectId),
            mergeWorktreesPreservingOptimistic(
              worktrees as Worktree[],
              previous
            )
          )
        }
      }
      const worktreePaths = collectWorktreePaths(data.worktreesByProject)
      if (Object.keys(worktreePaths).length > 0) {
        const currentState = useChatStore.getState()
        useChatStore.setState({
          worktreePaths: {
            ...currentState.worktreePaths,
            ...worktreePaths,
          },
        })
      }
      const executionModeUpdates = collectExecutionModes({
        sessionsByWorktree: data.sessionsByWorktree,
        activeSessions: data.activeSessions,
      })
      if (Object.keys(executionModeUpdates).length > 0) {
        beginSessionStateHydration()
        try {
          useChatStore.setState(state => ({
            executionModes: {
              ...state.executionModes,
              ...executionModeUpdates,
            },
          }))
        } finally {
          endSessionStateHydration()
        }
      }

      // Seed sessions for each worktree (WorktreeSessions struct)
      // Also restore Zustand state for reviewing/waiting status
      if (data.sessionsByWorktree) {
        const reviewingUpdates: Record<string, boolean> = {}
        const waitingUpdates: Record<string, boolean> = {}
        const sessionMappings: Record<string, string> = {}

        for (const [worktreeId, sessionsData] of Object.entries(
          data.sessionsByWorktree
        )) {
          queryClient.setQueryData(
            chatQueryKeys.sessions(worktreeId),
            sessionsData
          )
          // Also seed the 'with-counts' variant used by ProjectCanvasView.
          // The /api/init endpoint fetches with include_message_counts=true,
          // so this data is valid for both keys.
          queryClient.setQueryData(
            [...chatQueryKeys.sessions(worktreeId), 'with-counts'],
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
        // Clear stale waiting/reviewing state for sessions actively running a turn.
        // The server persists these flags from the previous turn's completion;
        // if a new turn is in-flight they're stale and would show approve buttons.
        if (data.runningSessions?.length) {
          const runningSessionIds = new Set(data.runningSessions)
          for (const sessionId of data.runningSessions) {
            runningSessionIds.add(sessionId)
          }
          const filteredReviewingUpdates = Object.fromEntries(
            Object.entries(reviewingUpdates).filter(
              ([sessionId]) => !runningSessionIds.has(sessionId)
            )
          )
          const filteredWaitingUpdates = Object.fromEntries(
            Object.entries(waitingUpdates).filter(
              ([sessionId]) => !runningSessionIds.has(sessionId)
            )
          )
          storeUpdates.reviewingSessions = filteredReviewingUpdates
          storeUpdates.waitingForInputSessionIds = filteredWaitingUpdates
        } else {
          storeUpdates.reviewingSessions = reviewingUpdates
          storeUpdates.waitingForInputSessionIds = waitingUpdates
        }
        // Replace (not merge) reviewing/waiting state — server is source of truth.
        // Merging would keep stale entries from sessions that changed while disconnected.
        if (Object.keys(storeUpdates).length > 0) {
          beginSessionStateHydration()
          try {
            useChatStore.setState(storeUpdates)
          } finally {
            endSessionStateHydration()
          }
        }
      }
      // Seed active sessions (with full chat history/messages).
      // Use a function updater to avoid overwriting cache that already has
      // more messages from an event or query response racing the bootstrap.
      if (data.activeSessions) {
        const activeReviewingUpdates: Record<string, boolean> = {}
        const activeWaitingUpdates: Record<string, boolean> = {}

        for (const [sessionId, initSession] of Object.entries(
          data.activeSessions
        )) {
          const session = initSession as Session
          if (session.is_reviewing) {
            activeReviewingUpdates[sessionId] = true
          }
          if (session.waiting_for_input) {
            activeWaitingUpdates[sessionId] = true
          }

          queryClient.setQueryData<Session>(
            chatQueryKeys.session(sessionId),
            old => {
              if (!old) return session
              const init = session
              if (old.messages.length > init.messages.length) {
                logger.warn('[seedCache] preserving cached messages', {
                  sessionId,
                  cachedCount: old.messages.length,
                  initCount: init.messages.length,
                })
                return { ...init, messages: old.messages }
              }
              return init
            }
          )

          const seededSession = queryClient.getQueryData<Session>(
            chatQueryKeys.session(sessionId)
          )
          const lastMsg = seededSession?.messages.at(-1)
          if (
            lastMsg?.role === 'assistant' &&
            lastMsg.id.startsWith('running-')
          ) {
            runningSnapshotMessages.push({ sessionId, message: lastMsg })
          }
        }

        if (
          Object.keys(activeReviewingUpdates).length > 0 ||
          Object.keys(activeWaitingUpdates).length > 0
        ) {
          beginSessionStateHydration()
          try {
            useChatStore.setState(state => ({
              reviewingSessions:
                data.sessionsByWorktree === undefined
                  ? activeReviewingUpdates
                  : state.reviewingSessions,
              waitingForInputSessionIds:
                data.sessionsByWorktree === undefined
                  ? activeWaitingUpdates
                  : state.waitingForInputSessionIds,
            }))
          } finally {
            endSessionStateHydration()
          }
        }
      }
      // Replace sendingSessionIds with exactly the server's running sessions.
      // This clears sessions that finished while the page was closed and restores
      // sessions that are still running — server is source of truth.
      const runningSendingIds: Record<string, boolean> = {}
      const runningSendStartedAt: Record<string, number> = {}
      if (data.runningSessions?.length) {
        for (const sessionId of data.runningSessions) {
          runningSendingIds[sessionId] = true
          const startedAt = data.sessionsByWorktree
            ? Object.values(data.sessionsByWorktree)
                .flatMap(ws => (ws as WorktreeSessions).sessions)
                .find(session => session.id === sessionId)?.last_run_started_at
            : undefined
          if (startedAt) {
            runningSendStartedAt[sessionId] = startedAt * 1000
          }
        }
      }
      useChatStore.setState(state => {
        const current = state.sendingSessionIds
        const currentSendStartedAt = state.sendStartedAt
        // Check if anything actually changed to avoid unnecessary re-renders
        const currentKeys = Object.keys(current)
        const newKeys = Object.keys(runningSendingIds)
        const currentStartKeys = Object.keys(currentSendStartedAt).filter(
          key => runningSendingIds[key]
        )
        const newStartKeys = Object.keys(runningSendStartedAt)
        if (
          currentKeys.length === newKeys.length &&
          newKeys.every(k => current[k]) &&
          currentStartKeys.length === newStartKeys.length &&
          newStartKeys.every(
            k => currentSendStartedAt[k] === runningSendStartedAt[k]
          )
        ) {
          return state
        }
        return {
          sendingSessionIds: runningSendingIds,
          sendStartedAt: {
            ...Object.fromEntries(
              Object.entries(currentSendStartedAt).filter(
                ([sessionId]) => !runningSendingIds[sessionId]
              )
            ),
            ...runningSendStartedAt,
          },
        }
      })

      for (const { sessionId, message } of runningSnapshotMessages) {
        hydrateRunningSnapshot(sessionId, message, {
          allowWhileSending: true,
          dedupeReplayedOutput: true,
        })
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old =>
            old
              ? {
                  ...old,
                  messages: old.messages.filter(m => m.id !== message.id),
                }
              : old
        )
      }
      // Note: Git status is included in worktree cached_* fields, no separate cache needed
      // Seed preferences into cache
      if (data.preferences) {
        queryClient.setQueryData(['preferences'], data.preferences)
      }
      // Seed UI state into cache
      if (data.uiState) {
        queryClient.setQueryData(['ui-state'], data.uiState)
        const uiState = data.uiState as { active_project_id?: string | null }
        const activeProjectId =
          peekWebReloadState()?.projectId ?? uiState.active_project_id
        if (activeProjectId) {
          const { selectedProjectId, expandProject, selectProject } =
            useProjectsStore.getState()
          const { activeWorktreePath } = useChatStore.getState()
          const projects = Array.isArray(data.projects) ? data.projects : []
          const projectExists = projects.some(
            project =>
              typeof project === 'object' &&
              project !== null &&
              'id' in project &&
              project.id === activeProjectId &&
              (!('is_folder' in project) || !project.is_folder)
          )
          if (!selectedProjectId && !activeWorktreePath && projectExists) {
            logger.info('Restoring active project from initial UI state', {
              activeProjectId,
            })
            selectProject(activeProjectId)
            expandProject(activeProjectId)
          }
        }
      }
      // Cache app data dir for browser-mode file URL conversion
      if (data.appDataDir) {
        setAppDataDir(data.appDataDir)
      }
    },
    [queryClient]
  )

  // Preload initial data via HTTP for web view (faster than waiting for WebSocket)
  useEffect(() => {
    if (!webBackend) return

    const initialSelectedProjectId =
      peekWebReloadState()?.projectId ??
      useProjectsStore.getState().selectedProjectId
    preloadInitialData(initialSelectedProjectId)
      .then(data => {
        if (data) {
          logger.info('Preloaded initial data via HTTP', {
            projects: Array.isArray(data.projects) ? data.projects.length : 0,
          })
          checkWebClientVersion(data)
          seedCache(data)
          ingestBootstrapEvents(data.replayEvents ?? [])
        }
      })
      .catch(err => {
        logger.warn('Failed to preload initial data', { error: err })
      })
      .finally(() => {
        setIsPreloading(false)
      })
  }, [queryClient, seedCache, webBackend])

  // Global safety net for uncaught async errors / promise rejections.
  // Without this, a thrown invoke() (e.g. auth/network failure) can leave the
  // app in a half-broken state until the next ErrorBoundary catches it.
  useEffect(() => {
    const truncate = (s: string, n: number) =>
      s.length > n ? `${s.slice(0, n)}…` : s

    const isAlreadySurfacedAuthError = (msg: string): boolean => {
      const lower = msg.toLowerCase()
      return (
        lower.includes('not authenticated') ||
        lower.includes('unauthorized') ||
        lower.includes('connection failed')
      )
    }

    const isTransientTransportError = (msg: string): boolean => {
      return msg.includes('WebSocket disconnected')
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Unknown error'
      logger.error('Unhandled promise rejection', {
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
      })
      if (
        !isAlreadySurfacedAuthError(message) &&
        !isTransientTransportError(message)
      ) {
        toast.error(`Unexpected error: ${truncate(message, 200)}`)
      }
      event.preventDefault()
    }

    const handleError = (event: ErrorEvent) => {
      const message = event.error?.message ?? event.message ?? 'Unknown error'
      logger.error('Uncaught window error', {
        message,
        stack: event.error?.stack,
        filename: event.filename,
      })
      if (
        !isAlreadySurfacedAuthError(message) &&
        !isTransientTransportError(message)
      ) {
        toast.error(`Unexpected error: ${truncate(message, 200)}`)
      }
    }

    window.addEventListener('unhandledrejection', handleRejection)
    window.addEventListener('error', handleError)
    return () => {
      window.removeEventListener('unhandledrejection', handleRejection)
      window.removeEventListener('error', handleError)
    }
  }, [])

  // Ensure external anchors open in the OS/default browser instead of the current WebView.
  useExternalLinkInterceptor()

  // Apply font settings from preferences
  useFontSettings()

  // Apply zoom level from preferences + keyboard shortcuts
  useZoom()

  // Save reviewing/waiting state immediately (no debounce) to ensure persistence on reload
  useImmediateSessionStateSave()

  // Check for CLI updates on startup (shows toast notification if updates available)
  useCliVersionCheck()

  // Headless jean-server binary updates (Web Access only)
  useServerUpdateCheck()

  // Global streaming event listeners - must be at App level so they stay active
  // even when ChatWindow is unmounted (e.g., when viewing a different worktree)
  useStreamingEvents({ queryClient })

  // Keep Codex usage UI fresh when the app-server pushes account rate-limit updates.
  useCodexUsageUpdateListener()

  // Browser mode: only open WebSocket after preload + listener registration.
  // This lets us replay buffered server events before live events start arriving.
  useEffect(() => {
    if (!webBackend || isNativeApp()) return

    return onEstablishedWsDisconnect(() => {
      logger.info('WebSocket disconnected, reloading web app')
      captureWebReloadState()
      window.location.reload()
    })
  }, [captureWebReloadState, webBackend])

  useEffect(() => {
    if (!webBackend || isPreloading || hasStartedTransportRef.current) return
    hasStartedTransportRef.current = true
    connectTransport()
  }, [isPreloading, webBackend])

  // Global queue processor - must be at App level so queued messages execute
  // even when the worktree is not focused (ChatWindow unmounted)
  useQueueProcessor()

  // Headless background investigation - starts investigations on background
  // worktrees (CMD+Click) without opening the session modal
  useBackgroundInvestigation()

  // Auto-archive worktrees when their PR is merged (if enabled in preferences)
  useAutoArchiveOnMerge()

  // One-time: detect installed backends and set magic prompt defaults accordingly
  useMagicPromptAutoDefaults()

  // A fresh page bootstrap is faster and more reliable than repairing stale
  // in-memory state. The backend keeps long-running jobs and
  // terminals alive, so reloading behaves like reopening Jean without losing
  // backend work.
  const wsConnected = useWsConnectionStatus()
  useEffect(() => {
    if (!webBackend || !wsConnected) return

    // First connect: invalidate non-preloaded queries. If the HTTP preload
    // failed, invalidate everything so it fetches over the open WebSocket.
    if (hasPreloadedData()) {
      logger.info('WebSocket connected, invalidating dynamic queries')
      queryClient.invalidateQueries({
        predicate: query => {
          const key = query.queryKey[0]
          return (
            key !== 'projects' &&
            key !== 'preferences' &&
            key !== 'ui-state' &&
            key !== 'chat'
          )
        },
      })
    } else {
      logger.warn(
        'WebSocket connected without preloaded data, invalidating all queries'
      )
      queryClient.invalidateQueries()
    }
  }, [wsConnected, queryClient, webBackend])

  // Add native-app class to body for desktop-only CSS (cursor, user-select, etc.)
  useEffect(() => {
    if (isNativeApp()) {
      document.body.classList.add('native-app')
    }
  }, [])

  // Pause animations when window loses focus to save GPU
  useEffect(() => {
    const onBlur = () =>
      document.documentElement.classList.add('window-blurred')
    const onFocus = () =>
      document.documentElement.classList.remove('window-blurred')
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const [cliCheckReady, setCliCheckReady] = useState(false)
  useEffect(() => {
    if (!isNativeApp()) return
    return scheduleIdleWork(() => setCliCheckReady(true), 2000)
  }, [])

  // Check CLI installation status after the first paint.
  const { data: claudeStatus, isLoading: isClaudeStatusLoading } =
    useClaudeCliStatus({ enabled: cliCheckReady && isNativeApp() })
  const { data: codexStatus, isLoading: isCodexStatusLoading } =
    useCodexCliStatus({ enabled: cliCheckReady && isNativeApp() })
  const { data: opencodeStatus, isLoading: isOpencodeStatusLoading } =
    useOpencodeCliStatus({ enabled: cliCheckReady && isNativeApp() })
  const { data: ghStatus, isLoading: isGhStatusLoading } = useGhCliStatus({
    enabled: cliCheckReady && isNativeApp(),
  })

  // Check CLI authentication status (only when installed)
  const { data: claudeAuth, isLoading: isClaudeAuthLoading } = useClaudeCliAuth(
    { enabled: cliCheckReady && !!claudeStatus?.installed && isNativeApp() }
  )
  const { data: codexAuth, isLoading: isCodexAuthLoading } = useCodexCliAuth({
    enabled: cliCheckReady && !!codexStatus?.installed && isNativeApp(),
  })
  const { data: opencodeAuth, isLoading: isOpencodeAuthLoading } =
    useOpencodeCliAuth({
      enabled: cliCheckReady && !!opencodeStatus?.installed && isNativeApp(),
    })
  const { data: ghAuth, isLoading: isGhAuthLoading } = useGhCliAuth({
    enabled: cliCheckReady && !!ghStatus?.installed && isNativeApp(),
  })

  // Show onboarding if GitHub CLI is not ready, or no AI backend is ready.
  // Only in native app - web view uses the desktop's CLIs via WebSocket
  useEffect(() => {
    if (!isNativeApp()) return
    if (!cliCheckReady) return

    const onboarding = useUIStore.getState()
    const prefs = queryClient.getQueryData<AppPreferences>(['preferences'])
    const action = getStartupOnboardingAction({
      statuses: [claudeStatus, codexStatus, opencodeStatus, ghStatus],
      auth: [claudeAuth, codexAuth, opencodeAuth, ghAuth],
      onboardingOpen: onboarding.onboardingOpen,
      onboardingDismissed: onboarding.onboardingDismissed,
      onboardingManuallyTriggered: onboarding.onboardingManuallyTriggered,
      requiresWslChoice: !!(isWindows && prefs && !prefs.wsl_mode_chosen),
    })

    if (action === 'wait' || action === 'none') return

    if (action === 'ready') {
      if (prefs && !prefs.has_seen_feature_tour) {
        onboarding.setFeatureTourOpen(true)
      }
      return
    }

    if (action === 'close') {
      onboarding.setOnboardingOpen(false)
      if (prefs && !prefs.has_seen_feature_tour) {
        onboarding.setFeatureTourOpen(true)
      }
      return
    }

    if (isWindows && prefs && !prefs.wsl_mode_chosen) {
      logger.info('Windows WSL mode not chosen, showing onboarding')
      onboarding.setOnboardingOpen(true)
      return
    }

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
    onboarding.setOnboardingOpen(true)
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
    cliCheckReady,
    platformVersion,
    queryClient,
  ])

  // Show the one-time Jean MCP announcement only after setup is complete.
  // This must never compete with first-run onboarding or the feature tour.
  useEffect(() => {
    if (!isNativeApp()) return
    if (!cliCheckReady || !preferences) return
    if (preferences.has_seen_jean_mcp_intro) return
    if (onboardingOpen || featureTourOpen || jeanMcpIntroOpen) return

    if (!claudeStatus || !codexStatus || !opencodeStatus || !ghStatus) return

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

    // If setup is incomplete, onboarding owns the startup surface.
    if (!ghReady || !hasAiBackendReady) return

    // Existing first-run tour has priority; show MCP intro on a later tick/reload
    // after that preference has been marked seen.
    if (!preferences.has_seen_feature_tour) return

    useUIStore.getState().setJeanMcpIntroOpen(true)
  }, [
    preferences,
    onboardingOpen,
    featureTourOpen,
    jeanMcpIntroOpen,
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
    cliCheckReady,
  ])

  // Show feature tour after CLI onboarding completes (first launch or manual trigger)
  useEffect(() => {
    let wasOpen = useUIStore.getState().onboardingOpen
    const unsub = useUIStore.subscribe(state => {
      const isOpen = state.onboardingOpen
      const prevWasOpen = wasOpen
      wasOpen = isOpen // Update FIRST to prevent re-entrant loops from synchronous setState
      if (prevWasOpen && !isOpen) {
        const store = useUIStore.getState()
        // Don't show feature tour if user dismissed onboarding without completing setup
        if (store.onboardingDismissed) {
          store.setOnboardingManuallyTriggered(false)
        } else {
          const manuallyTriggered = store.onboardingManuallyTriggered
          const prefs = queryClient.getQueryData<AppPreferences>([
            'preferences',
          ])
          if (manuallyTriggered || (prefs && !prefs.has_seen_feature_tour)) {
            store.setOnboardingManuallyTriggered(false)
            setTimeout(() => {
              useUIStore.getState().setFeatureTourOpen(true)
            }, 300)
          }
        }
      }
    })
    return unsub
  }, [queryClient])

  // Kill all terminals on page refresh/close (backup for Rust-side cleanup)
  useEffect(() => {
    if (!isNativeApp() || webBackend) return

    const handleBeforeUnload = () => {
      if (isConnectionSwitchPending()) return
      // Best-effort sync cleanup for refresh scenarios
      // Note: async operations may not complete, but Rust-side RunEvent::Exit
      // will handle proper cleanup on app quit
      invoke('kill_all_terminals').catch(() => {
        /* noop */
      })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [webBackend])

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    logger.info('🚀 Frontend application starting up')
    initializeCommandSystem()
    logger.debug('Command system initialized')

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })

    // Auto-updater logic - check for updates 5 seconds after app loads
    // (native shell only; web clients use useServerUpdateCheck → host check)
    const checkForUpdates = async () => {
      if (!isNativeApp()) return
      const ui = useUIStore.getState()
      // Don't re-offer while deferred, downloading, or already installed (#507)
      if (
        !shouldOfferUpdateCheck({
          pendingUpdateVersion: ui.pendingUpdateVersion,
          updateReadyVersion: ui.updateReadyVersion,
          isUpdateInstalling: ui.isUpdateInstalling,
        })
      ) {
        return
      }

      try {
        const { check } = await import('@tauri-apps/plugin-updater')

        const update = await check()
        if (update) {
          // Re-check guards after the async network call — install may have started
          const after = useUIStore.getState()
          if (
            !shouldOfferUpdateCheck({
              pendingUpdateVersion: after.pendingUpdateVersion,
              updateReadyVersion: after.updateReadyVersion,
              isUpdateInstalling: after.isUpdateInstalling,
            })
          ) {
            try {
              await update.close?.()
            } catch {
              // Resource may already be released
            }
            return
          }

          logger.info(`Update available: ${update.version}`)
          pendingUpdateRef.current = update
          useUIStore.getState().setUpdateModalVersion(update.version)
        }
      } catch (checkError) {
        logger.error(`Update check failed: ${String(checkError)}`)
        // Silent fail for update checks - don't bother user with network issues
      }
    }

    // Listen for install trigger from title bar indicator / modal
    const handleInstallPending = () => {
      const ui = useUIStore.getState()
      const action = resolveInstallPendingAction({
        updateReadyVersion: ui.updateReadyVersion,
        isUpdateInstalling: ui.isUpdateInstalling,
        hasPendingUpdateObject: Boolean(pendingUpdateRef.current),
      })
      if (action === 'relaunch') {
        void relaunchApp()
        return
      }
      if (action === 'install' && pendingUpdateRef.current) {
        void installAppUpdate(pendingUpdateRef.current)
        return
      }
      // Already downloading — ignore duplicate install triggers (#507)
      if (ui.isUpdateInstalling) return

      // Web / remote: ask the host to install (desktop event or jean-server binary)
      const version =
        ui.pendingUpdateVersion || ui.updateModalVersion
      if (!version) {
        logger.warn(
          'install-pending-update fired with no version or update object'
        )
        return
      }
      void import('@/hooks/useServerUpdateCheck').then(({ applyServerUpdate }) =>
        applyServerUpdate(version)
      )
    }
    window.addEventListener('install-pending-update', handleInstallPending)

    // Listen for update object from manual "Check for Updates" menu
    const handleUpdateAvailable = (e: Event) => {
      pendingUpdateRef.current = (e as CustomEvent).detail
    }
    window.addEventListener('update-available', handleUpdateAvailable)

    interface ResumableSession {
      session_id: string
      worktree_id: string
      run_id: string
      user_message: string
      resumable: boolean
      execution_mode: string | null
      started_at: number
    }

    const cancelIdleStartupWork = scheduleIdleWork(() => {
      // Preload notification sounds after the shell is interactive.
      const prefs = queryClient.getQueryData<AppPreferences>(['preferences'])
      preloadAllSounds({
        webAccessSoundsEnabled: prefs?.web_access_sounds_enabled ?? true,
      })

      if (isNativeApp() && !webBackend && !isConnectionSwitchPending()) {
        // Kill any orphaned terminals from previous native app session/reload.
        // Web access clients must not kill server-owned terminals when their
        // browser tab reloads, sleeps, or is discarded.
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
      }

      // Clean up old recovery files on startup.
      cleanupOldFiles().catch(error => {
        logger.warn('Failed to cleanup old recovery files', { error })
      })

      // Check for and resume any detached sessions that are still running.
      invoke<ResumableSession[]>('check_resumable_sessions')
        .then(async resumable => {
          if (!hasPreloadedData()) {
            queryClient.invalidateQueries({ queryKey: chatQueryKeys.all })
          }

          const { sendingSessionIds, removeSendingSession } =
            useChatStore.getState()
          const resumableIds = new Set(resumable.map(r => r.session_id))
          // Web bootstrap already restored the registry's authoritative running
          // set. Recovery can omit a live run when its metadata snapshot is
          // temporarily unavailable, so only reconcile stale local state here.
          if (!webBackend) {
            for (const sessionId of Object.keys(sendingSessionIds)) {
              if (!resumableIds.has(sessionId)) {
                removeSendingSession(sessionId)
              }
            }
          }

          if (resumable.length === 0) return

          logger.info('Found resumable sessions', { count: resumable.length })

          for (const session of resumable) {
            logger.info('Resuming session', {
              session_id: session.session_id,
              worktree_id: session.worktree_id,
            })
            const store = useChatStore.getState()
            store.addSendingSession(
              session.session_id,
              session.started_at * 1000
            )

            let sessionSnapshot = queryClient.getQueryData<Session>(
              chatQueryKeys.session(session.session_id)
            )
            let worktreePath = store.getWorktreePath(session.worktree_id)
            if (!worktreePath) {
              try {
                const worktree = await invoke<{ path: string }>(
                  'get_worktree',
                  {
                    worktreeId: session.worktree_id,
                  }
                )
                if (worktree.path) {
                  worktreePath = worktree.path
                  store.registerWorktreePath(session.worktree_id, worktree.path)
                }
              } catch (error) {
                logger.warn(
                  'Failed to resolve worktree path for resumable run',
                  {
                    session_id: session.session_id,
                    worktree_id: session.worktree_id,
                    error,
                  }
                )
              }
            }
            if (worktreePath) {
              try {
                sessionSnapshot = await invoke<Session>('get_session', {
                  sessionId: session.session_id,
                  worktreeId: session.worktree_id,
                  worktreePath,
                })
                queryClient.setQueryData(
                  chatQueryKeys.session(session.session_id),
                  sessionSnapshot
                )
              } catch (error) {
                logger.warn(
                  'Failed to load session snapshot for resumable run',
                  {
                    session_id: session.session_id,
                    error,
                  }
                )
              }
            }

            const lastMsg = sessionSnapshot?.messages.at(-1)
            if (
              lastMsg?.role === 'assistant' &&
              lastMsg.id.startsWith('running-')
            ) {
              let snapshotContent = lastMsg.content
              if (!snapshotContent && lastMsg.content_blocks?.length) {
                const textParts: string[] = []
                for (const block of lastMsg.content_blocks) {
                  if (block.type === 'text') {
                    textParts.push(block.text)
                  }
                }
                snapshotContent = textParts.join('')
              }

              if (snapshotContent) {
                const existingContent =
                  store.streamingContents[session.session_id] ?? ''
                if (!existingContent.startsWith(snapshotContent)) {
                  store.setStreamingContent(
                    session.session_id,
                    snapshotContent + existingContent
                  )
                }
              }

              hydrateRunningSnapshot(session.session_id, lastMsg, {
                allowWhileSending: true,
                dedupeReplayedOutput: sessionSnapshot?.backend === 'claude',
              })

              queryClient.setQueryData<Session>(
                chatQueryKeys.session(session.session_id),
                old =>
                  old
                    ? {
                        ...old,
                        messages: old.messages.filter(m => m.id !== lastMsg.id),
                      }
                    : old
              )
            }

            if (session.execution_mode) {
              store.setExecutingMode(
                session.session_id,
                session.execution_mode as 'plan' | 'build' | 'yolo'
              )
            }
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
        })
        .catch(error => {
          logger.error('Failed to check resumable sessions', { error })
        })

      clearConnectionSwitch()
    }, 2500)

    // Check for updates 5 seconds after app loads, then every 30 minutes
    const updateTimer = setTimeout(checkForUpdates, 5000)
    const updateInterval = setInterval(checkForUpdates, 30 * 60 * 1000)
    return () => {
      cancelIdleStartupWork()
      clearTimeout(updateTimer)
      clearInterval(updateInterval)
      window.removeEventListener('install-pending-update', handleInstallPending)
      window.removeEventListener('update-available', handleUpdateAvailable)
    }
  }, [installAppUpdate, relaunchApp, webBackend])

  // Web clients request desktop install via apply_server_update → this event.
  // Only the *host* native shell should run Tauri's updater (not a remote client
  // that happens to receive the same event over the WebSocket).
  useEffect(() => {
    if (!isNativeApp()) return
    let unlisten: (() => void) | undefined
    listen<{ version?: string }>('host:install-desktop-update', () => {
      if (!isLocalBackend()) return
      void runNativeDesktopUpdateInstall()
    }).then(fn => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [runNativeDesktopUpdateInstall])

  // Show loading screen while preloading initial data (web view only).
  // QuitConfirmationDialog stays mounted so X/quit can still confirm or
  // destroy the native window while the overlay is up.
  if (isPreloading) {
    return (
      <>
        <WebLoadingScreen label="Loading Jean..." />
        {isNativeApp() && <QuitConfirmationDialog />}
      </>
    )
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MainWindow />
        {webBackend && !wsConnected && !wsAuthError && (
          <WebLoadingScreen label="Loading Jean..." />
        )}
        {webBackend && <WsAuthErrorOverlay />}
        {/* App-level dialog so quit confirmation wins over loading overlay
            even if MainWindow's copy is covered / not yet mounted. */}
        {isNativeApp() && <QuitConfirmationDialog />}
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
