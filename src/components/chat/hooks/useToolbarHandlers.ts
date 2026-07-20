import { useCallback, type RefObject } from 'react'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { chatQueryKeys } from '@/services/chat'
import { resolveDefaultModelForBackend } from '@/lib/session-defaults'
import type { ModelOption } from '@/lib/session-defaults'
import type { QueryClient } from '@tanstack/react-query'
import type {
  ThinkingLevel,
  EffortLevel,
  ExecutionMode,
  Session,
} from '@/types/chat'
import { normalizeExecutionModeForBackend } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { applySessionSettingToSession } from '@/components/chat/hooks/session-setting-sync'

interface UseToolbarHandlersParams {
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  activeSessionIdRef: RefObject<string | null | undefined>
  activeWorktreeIdRef: RefObject<string | null | undefined>
  activeWorktreePathRef: RefObject<string | null | undefined>
  enabledMcpServersRef: RefObject<string[]>
  selectedBackend: CliBackend
  installedBackends: CliBackend[]
  session: Session | null | undefined
  preferences:
    | {
        selected_model?: string
        selected_codex_model?: string
        selected_opencode_model?: string
        selected_cursor_model?: string
        selected_pi_model?: string
        selected_commandcode_model?: string
        selected_grok_model?: string
        selected_kimi_model?: string
        custom_cli_profiles?: { name: string }[]
        default_execution_mode?: ExecutionMode
      }
    | undefined
  piModelOptions?: ModelOption[]
  queryClient: QueryClient
  worktreeProjectId: string | undefined
  // Mutations (use any for compatibility with TanStack Query mutation types)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionModel: { mutate: (args: any, opts?: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionBackend: { mutate: (args: any, opts?: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionProvider: { mutate: (args: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionThinkingLevel: { mutate: (args: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionEffortLevel: { mutate: (args: any) => void }
  setExecutionMode: (sessionId: string, mode: ExecutionMode) => void
  setLoadContextModalOpen: (open: boolean) => void
}

/**
 * Groups all ChatToolbar callback handlers.
 * These persist session settings (model, backend, provider, thinking level, etc.)
 * to both Zustand store and Rust backend.
 */
export function useToolbarHandlers({
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  activeSessionIdRef,
  activeWorktreeIdRef,
  activeWorktreePathRef,
  enabledMcpServersRef,
  selectedBackend,
  installedBackends,
  session,
  preferences,
  piModelOptions,
  queryClient,
  worktreeProjectId,
  setSessionModel,
  setSessionBackend,
  setSessionProvider,
  setSessionThinkingLevel,
  setSessionEffortLevel,
  setExecutionMode,
  setLoadContextModalOpen,
}: UseToolbarHandlersParams) {
  const persistToolbarBackendAndModel = useCallback(
    (backend: CliBackend, model: string) => {
      const currentMode =
        (activeSessionId
          ? useChatStore.getState().executionModes[activeSessionId]
          : undefined) ??
        session?.selected_execution_mode ??
        preferences?.default_execution_mode ??
        'plan'
      const nextExecutionMode = normalizeExecutionModeForBackend(
        backend,
        currentMode
      )

      if (activeSessionId && activeWorktreeId && activeWorktreePath) {
        useChatStore.getState().setSelectedBackend(activeSessionId, backend)
        useChatStore.getState().setSelectedModel(activeSessionId, model)
        useChatStore
          .getState()
          .setExecutionMode(activeSessionId, nextExecutionMode)
        queryClient.setQueryData(
          chatQueryKeys.session(activeSessionId),
          (old: Session | null | undefined) =>
            old
              ? applySessionSettingToSession(
                  applySessionSettingToSession(
                    applySessionSettingToSession(old, 'backend', backend),
                    'model',
                    model
                  ),
                  'executionMode',
                  nextExecutionMode
                )
              : old
        )
        invoke('broadcast_session_setting', {
          sessionId: activeSessionId,
          key: 'backend',
          value: backend,
        }).catch(() => undefined)
        invoke('broadcast_session_setting', {
          sessionId: activeSessionId,
          key: 'model',
          value: model,
        }).catch(() => undefined)
        invoke('broadcast_session_setting', {
          sessionId: activeSessionId,
          key: 'executionMode',
          value: nextExecutionMode,
        }).catch(() => undefined)
        setSessionBackend.mutate(
          {
            sessionId: activeSessionId,
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            backend,
          },
          {
            onSuccess: () => {
              setSessionModel.mutate({
                sessionId: activeSessionId,
                worktreeId: activeWorktreeId,
                worktreePath: activeWorktreePath,
                model,
              })
              invoke('update_session_state', {
                worktreeId: activeWorktreeId,
                worktreePath: activeWorktreePath,
                sessionId: activeSessionId,
                selectedExecutionMode: nextExecutionMode,
              }).catch(() => undefined)
            },
          }
        )
      }
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      queryClient,
      preferences?.default_execution_mode,
      session?.selected_execution_mode,
      setSessionBackend,
      setSessionModel,
    ]
  )

  const handleToolbarModelChange = useCallback(
    (model: string) => {
      if (activeSessionId && activeWorktreeId && activeWorktreePath) {
        useChatStore.getState().setSelectedModel(activeSessionId, model)
        queryClient.setQueryData(
          chatQueryKeys.session(activeSessionId),
          (old: Session | null | undefined) =>
            old ? applySessionSettingToSession(old, 'model', model) : old
        )
        setSessionModel.mutate({
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          model,
        })
        invoke('broadcast_session_setting', {
          sessionId: activeSessionId,
          key: 'model',
          value: model,
        }).catch(() => undefined)
      }
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      queryClient,
      setSessionModel,
    ]
  )

  const handleToolbarBackendChange = useCallback(
    (backend: CliBackend) => {
      const model = resolveDefaultModelForBackend(
        backend,
        preferences,
        backend === 'pi' ? piModelOptions : undefined
      )

      persistToolbarBackendAndModel(backend, model)
    },
    [
      persistToolbarBackendAndModel,
      preferences?.selected_codex_model,
      preferences?.selected_cursor_model,
      preferences?.selected_commandcode_model,
      preferences?.selected_grok_model,
      preferences?.selected_kimi_model,
      preferences?.selected_model,
      preferences?.selected_opencode_model,
      preferences?.selected_pi_model,
      piModelOptions,
    ]
  )

  const handleToolbarBackendModelChange = useCallback(
    (backend: CliBackend, model: string) => {
      persistToolbarBackendAndModel(backend, model)
    },
    [persistToolbarBackendAndModel]
  )

  const handleTabBackendSwitch = useCallback(() => {
    if (installedBackends.length <= 1) return
    const currentIndex = installedBackends.indexOf(selectedBackend)
    const nextIndex = (currentIndex + 1) % installedBackends.length
    const nextBackend = installedBackends[nextIndex]
    if (nextBackend) handleToolbarBackendChange(nextBackend)
  }, [selectedBackend, installedBackends, handleToolbarBackendChange])

  const handleToolbarProviderChange = useCallback(
    (provider: string | null) => {
      if (activeSessionId) {
        useChatStore.getState().setSelectedProvider(activeSessionId, provider)
        if (activeWorktreeId && activeWorktreePath) {
          setSessionProvider.mutate({
            sessionId: activeSessionId,
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            provider,
          })
        }
      }
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, setSessionProvider]
  )

  const handleToolbarThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      useChatStore.getState().setThinkingLevel(sessionId, level)
      queryClient.setQueryData(
        chatQueryKeys.session(sessionId),
        (old: Session | null | undefined) =>
          old ? applySessionSettingToSession(old, 'thinkingLevel', level) : old
      )
      setSessionThinkingLevel.mutate({
        sessionId,
        worktreeId,
        worktreePath,
        thinkingLevel: level,
      })
      invoke('broadcast_session_setting', {
        sessionId,
        key: 'thinkingLevel',
        value: level,
      }).catch(() => undefined)
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutate is stable, refs used for IDs
    []
  )

  const handleToolbarEffortLevelChange = useCallback((level: EffortLevel) => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    useChatStore.getState().setEffortLevel(sessionId, level)
    queryClient.setQueryData(
      chatQueryKeys.session(sessionId),
      (old: Session | null | undefined) =>
        old ? applySessionSettingToSession(old, 'effortLevel', level) : old
    )
    setSessionEffortLevel.mutate({
      sessionId,
      worktreeId,
      worktreePath,
      effortLevel: level,
    })
    invoke('broadcast_session_setting', {
      sessionId,
      key: 'effortLevel',
      value: level,
    }).catch(() => undefined)
    window.dispatchEvent(new CustomEvent('focus-chat-input'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutate is stable, refs used for IDs
  }, [])

  const handleToggleMcpServer = useCallback((serverName: string) => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    useChatStore
      .getState()
      .toggleMcpServer(sessionId, serverName, enabledMcpServersRef.current)
  }, [])

  const handleOpenProjectSettings = useCallback(() => {
    if (!worktreeProjectId) return
    useProjectsStore.getState().openProjectSettings(worktreeProjectId)
  }, [worktreeProjectId])

  const handleToolbarSetExecutionMode = useCallback(
    (mode: ExecutionMode) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      const normalizedMode = normalizeExecutionModeForBackend(
        selectedBackend,
        mode
      )

      if (sessionId) {
        setExecutionMode(sessionId, normalizedMode)
        queryClient.setQueryData(
          chatQueryKeys.session(sessionId),
          (old: Session | null | undefined) =>
            old
              ? applySessionSettingToSession(
                  old,
                  'executionMode',
                  normalizedMode
                )
              : old
        )

        // Persist immediately so browser/WebSocket mode survives reloads
        // even if debounced background persistence is delayed/skipped.
        if (worktreeId && worktreePath) {
          invoke('update_session_state', {
            worktreeId,
            worktreePath,
            sessionId,
            selectedExecutionMode: normalizedMode,
          }).catch(() => undefined)
        }

        invoke('broadcast_session_setting', {
          sessionId,
          key: 'executionMode',
          value: normalizedMode,
        }).catch(() => undefined)
      }
      window.dispatchEvent(new CustomEvent('focus-chat-input'))
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedBackend,
      setExecutionMode,
    ]
  )

  const handleOpenMagicModal = useCallback(() => {
    useUIStore.getState().setMagicModalOpen(true)
  }, [])

  const handleLoadContextModalChange = useCallback(
    (open: boolean) => {
      setLoadContextModalOpen(open)
    },
    [setLoadContextModalOpen]
  )

  return {
    handleToolbarModelChange,
    handleToolbarBackendChange,
    handleToolbarBackendModelChange,
    handleTabBackendSwitch,
    handleToolbarProviderChange,
    handleToolbarThinkingLevelChange,
    handleToolbarEffortLevelChange,
    handleToggleMcpServer,
    handleOpenProjectSettings,
    handleToolbarSetExecutionMode,
    handleOpenMagicModal,
    handleLoadContextModalChange,
  }
}
