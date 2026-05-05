import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Brain,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  FlaskConical,
  Image,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Search,
  Shield,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
} from 'lucide-react'
import {
  useAcpCancel,
  useAcpCreateSession,
  useAcpLocalSessionState,
  useAcpListProviders,
  useAcpResumeSession,
  useAcpSendMessage,
  useAcpSetConfigOption,
  useAcpSetMode,
  useAcpSetModel,
  acpResolvePermission,
  hasPersistedAcpSession,
  type AcpImageInput,
} from '../api/api'
import {
  selectAcpAvailableCommands,
  selectAcpAvailableModels,
  selectAcpAvailableModes,
  selectAcpAvailableThoughtLevels,
  selectAcpCurrentModelId,
  selectAcpCurrentModeId,
  selectAcpCurrentThoughtLevelId,
  selectAcpHydrated,
  selectAcpMessages,
  selectAcpPendingImages,
  selectAcpPendingPermissions,
  selectAcpPromptImageSupported,
  selectAcpSessionPlan,
  selectAcpSessionTitle,
  selectAcpStreamingBlocks,
  selectAcpThoughtLevelConfigId,
  selectAcpUsage,
  parseAvailableCommands,
  parseSemanticSelectConfigOption,
  useAcpStore,
  type AcpAssistantBlock,
  type AcpAvailableCommand,
  type AcpModeInfo,
  type AcpModelInfo,
  type AcpPendingImage,
  type AcpPendingPermission,
  type AcpPlanEntry,
  type AcpThoughtLevelInfo,
  type AcpToolCall,
  type AcpToolCallContent,
  type AcpUiMessage,
  type AcpUsage,
} from '../store/acp-store'
import { AcpListPicker } from './AcpListPicker'
import {
  AcpMentionPopover,
  type AcpMentionPopoverHandle,
} from './AcpMentionPopover'
import { AcpSlashPopover, type AcpSlashPopoverHandle } from './AcpSlashPopover'
import { AcpUsageStrip } from './AcpUsageStrip'
import { AcpImageLightbox, type AcpLightboxImage } from './AcpImageLightbox'
import {
  buildSlashGhost,
  getVisibleSlashGhostHint,
  shouldKeepSlashGhost,
  type SlashGhost,
} from '../lib/slash-ghost'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ContextCard } from '@/components/chat/ContextCard'
import {
  hasContextUsage,
  parseContextUsage,
} from '@/components/chat/context-usage-utils'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Textarea } from '@/components/ui/textarea'
import { useUIStore } from '@/store/ui-store'
import { useRenameSession } from '@/services/chat'
import type { Session } from '@/types/chat'
import { CopyableErrorAlert } from '@/components/ui/copyable-error-alert.tsx'

interface AcpChatProps {
  session: Session
  worktreeId: string
  /** Absolute path to the worktree root. */
  worktreePath: string
  /** Optional subdirectory (relative to worktreePath) that scopes the
   *  effective working root — used for @-file listing so the user sees
   *  only the files relevant to their workspace, not the whole monorepo.
   *  Corresponds to `Worktree.scope_path`. */
  worktreeScopePath?: string
}

/**
 * Standalone ACP chat surface — replaces ChatWindow for sessions whose
 * backend is `acp_lab`.
 *
 * State model (mirrors `useStreamingEvents.ts` for the existing chat):
 *   - **Finalized history** comes from `useAcpStore.messages[sid]`. Seeded
 *     once per session via `hydrateFromLog` (cold disk read) and grown by
 *     `pushUserMessage` + `finalizeStreamingAssistant`. Never touched by
 *     per-chunk live events.
 *   - **In-flight assistant turn** is the trio
 *     (`streamingText`, `streamingThinking`, `streamingToolCalls`) in the
 *     store, written to by the global `useAcpStreamingEvents` singleton
 *     with `requestAnimationFrame` batching. Rendered as a single trailing
 *     "live" assistant row whenever any of the three is non-empty.
 *   - **Lazy session creation**: provider choice is local UI state until
 *     the first prompt. That send path then creates or resumes the ACP
 *     session on demand before dispatching the prompt. Existing persisted
 *     ACP sessions instead resume immediately when the tab opens.
 */
export default function AcpChat({
  session,
  worktreeId,
  worktreePath,
  worktreeScopePath,
}: AcpChatProps) {
  // The effective root for @-file search: scope_path sub-scopes the search
  // to the user's configured base path (e.g. a monorepo package) so the
  // popover shows only relevant files rather than everything in the worktree.
  const fileSearchRoot = worktreeScopePath
    ? `${worktreePath}/${worktreeScopePath}`
    : worktreePath
  const providersQuery = useAcpListProviders()
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null
  )
  const [lastCreateAttemptProviderId, setLastCreateAttemptProviderId] =
    useState<string | null>(null)
  const localStateQuery = useAcpLocalSessionState(session.id)
  const createSessionQuery = useAcpCreateSession(
    session.id,
    worktreePath,
    selectedProviderId
  )
  const resumeSessionQuery = useAcpResumeSession(session.id, worktreePath)
  const localSessionState = localStateQuery.data
  const localSnapshot = localSessionState?.snapshot ?? null
  const liveSessionInfo = createSessionQuery.data ?? resumeSessionQuery.data
  const sessionInfo = liveSessionInfo ?? localSnapshot
  const localSessionKnown = !localStateQuery.isLoading
  const hasLocalSession = hasPersistedAcpSession(localSessionState)
  const sessionOpening =
    createSessionQuery.isFetching || resumeSessionQuery.isFetching
  const acpSessionId = sessionInfo?.session_id
  const hasAcpSession = acpSessionId != null
  const activeProviderId = sessionInfo?.provider ?? selectedProviderId
  const sendMutation = useAcpSendMessage()
  const cancelMutation = useAcpCancel()

  const messages = useAcpStore(selectAcpMessages(session.id))
  const streamingBlocks = useAcpStore(selectAcpStreamingBlocks(session.id))
  const hydrated = useAcpStore(selectAcpHydrated(session.id))
  const availableModels = useAcpStore(selectAcpAvailableModels(session.id))
  const currentModelId = useAcpStore(selectAcpCurrentModelId(session.id))
  const availableModes = useAcpStore(selectAcpAvailableModes(session.id))
  const currentModeId = useAcpStore(selectAcpCurrentModeId(session.id))
  const availableThoughtLevels = useAcpStore(
    selectAcpAvailableThoughtLevels(session.id)
  )
  const currentThoughtLevelId = useAcpStore(
    selectAcpCurrentThoughtLevelId(session.id)
  )
  const thoughtLevelConfigId = useAcpStore(
    selectAcpThoughtLevelConfigId(session.id)
  )
  const availableCommands = useAcpStore(selectAcpAvailableCommands(session.id))
  const pendingPermissions = useAcpStore(
    selectAcpPendingPermissions(session.id)
  )
  const usage = useAcpStore(selectAcpUsage(session.id))
  const sessionTitle = useAcpStore(selectAcpSessionTitle(session.id))
  const sessionPlan = useAcpStore(selectAcpSessionPlan(session.id))
  const pendingImages = useAcpStore(selectAcpPendingImages(session.id))
  const promptImageSupported = useAcpStore(
    selectAcpPromptImageSupported(session.id)
  )
  const setConfigOptionMutation = useAcpSetConfigOption(session.id)
  const setModelMutation = useAcpSetModel(session.id)
  const setModeMutation = useAcpSetMode(session.id)

  const [draft, setDraft] = useState('')

  // Suppress the global FloatingDock while this surface is mounted —
  // ACP has its own composer and the dock would overlap it. Mirrors the
  // signal `ChatToolbar` sends for the non-ACP chat.
  useEffect(() => {
    const { setChatToolbarMounted } = useUIStore.getState()
    setChatToolbarMounted(true)
    return () => setChatToolbarMounted(false)
  }, [])

  // Hydrate from disk once per session per app run. The local-state query
  // returns both the JSONL transcript and the persisted snapshot so first
  // paint can restore the chat before the live resume RPC completes.
  useEffect(() => {
    if (hydrated) return
    if (localStateQuery.isLoading || !localSessionState) return
    useAcpStore
      .getState()
      .hydrateFromLog(session.id, localSessionState.log_entries)
  }, [hydrated, localSessionState, localStateQuery.isLoading, session.id])

  // Existing ACP tabs should resume as soon as the tab opens, not only on
  // the next send. The local-state endpoint tells us whether a persisted
  // ACP snapshot exists, so we avoid flashing the provider chooser while
  // the resume RPC is still in flight.
  const [resumeAttempted, setResumeAttempted] = useState(false)
  useEffect(() => {
    if (resumeAttempted) return
    if (
      createSessionQuery.data?.session_id ||
      resumeSessionQuery.data?.session_id
    )
      return
    if (localStateQuery.isLoading || !localSessionState) return
    if (!hasLocalSession) return
    setResumeAttempted(true)
    void resumeSessionQuery.refetch()
  }, [
    createSessionQuery.data?.session_id,
    hasLocalSession,
    localSessionState,
    localStateQuery.isLoading,
    resumeAttempted,
    resumeSessionQuery.data?.session_id,
    resumeSessionQuery.refetch,
  ])

  // ACP's canonical session-config surface is `config_options`. Hydrate the
  // three UI pickers from that generic source only.
  //
  // **First-mount-only for currentId** — guarded by checking the store
  // because the create/resume query data is cached with
  // `staleTime: Infinity` and still holds the original selection from
  // session open. Without the guard, every tab switch would re-fire this
  // effect and stomp live updates from `config_option_update`.
  useEffect(() => {
    const parsed = parseSemanticSelectConfigOption<AcpModelInfo>(
      sessionInfo?.config_options,
      'model'
    )
    if (!parsed) return
    if (session.id in useAcpStore.getState().currentModelId) return
    useAcpStore
      .getState()
      .setSessionModels(
        session.id,
        parsed.currentId,
        parsed.available,
        parsed.configId
      )
  }, [session.id, sessionInfo?.config_options])

  // Mirror the generic-config hydration for mode.
  useEffect(() => {
    const parsed = parseSemanticSelectConfigOption<AcpModeInfo>(
      sessionInfo?.config_options,
      'mode'
    )
    if (!parsed) return
    if (session.id in useAcpStore.getState().currentModeId) return
    useAcpStore
      .getState()
      .setSessionModes(
        session.id,
        parsed.currentId,
        parsed.available,
        parsed.configId
      )
  }, [session.id, sessionInfo?.config_options])

  // And again for thought level.
  useEffect(() => {
    const parsed = parseSemanticSelectConfigOption<AcpThoughtLevelInfo>(
      sessionInfo?.config_options,
      'thought_level'
    )
    if (!parsed) return
    if (session.id in useAcpStore.getState().currentThoughtLevelId) return
    useAcpStore
      .getState()
      .setSessionThoughtLevels(
        session.id,
        parsed.currentId,
        parsed.available,
        parsed.configId
      )
  }, [session.id, sessionInfo?.config_options])

  // Hydrate the slash-command catalog from the backend session snapshot.
  // First-mount-only guard so live `available_commands_update`s remain the
  // source of truth once the session is active.
  useEffect(() => {
    const parsed = parseAvailableCommands({
      availableCommands: sessionInfo?.available_commands,
    })
    if (!parsed) return
    if (session.id in useAcpStore.getState().availableCommands) return
    useAcpStore.getState().setSessionCommands(session.id, parsed)
  }, [session.id, sessionInfo?.available_commands])

  // Hydrate the agent-pushed session title from the create/resume
  // response. First-mount-only guard so live `session_info_update`s
  // don't get clobbered by the cached query data.
  useEffect(() => {
    const t = sessionInfo?.title
    if (t === undefined) return
    if (session.id in useAcpStore.getState().sessionTitles) return
    useAcpStore.getState().setSessionTitle(session.id, t)
  }, [session.id, sessionInfo?.title])

  // Hydrate image-prompt capability once from the session create/resume
  // response. First-mount-only (key-presence guard) — the value is stable
  // for the lifetime of the adapter process and never changes mid-session.
  useEffect(() => {
    const pi = sessionInfo?.prompt_image
    if (pi === undefined) return
    if (session.id in useAcpStore.getState().promptImageSupported) return
    useAcpStore.getState().setPromptImageSupported(session.id, pi)
  }, [session.id, sessionInfo?.prompt_image])

  // Mirror the agent's title into the jean chat-store so it shows up in
  // the session sidebar. Gated to once per (app session × jean session)
  // via a ref: after the first push, further updates are ignored so a
  // user manual rename sticks. Does nothing when the agent never pushes
  // a title, when worktree info isn't yet known, or when the title is
  // empty/cleared.
  const renameMutation = useRenameSession()
  const titleAppliedRef = useRef(false)
  useEffect(() => {
    if (titleAppliedRef.current) return
    if (!sessionTitle) return
    if (session.name === sessionTitle) {
      titleAppliedRef.current = true
      return
    }
    titleAppliedRef.current = true
    renameMutation.mutate({
      worktreeId,
      worktreePath,
      sessionId: session.id,
      newName: sessionTitle,
    })
  }, [
    sessionTitle,
    session.id,
    session.name,
    renameMutation,
    worktreeId,
    worktreePath,
  ])

  // Track the most recent send so the per-prompt onSettled finalize fires
  // exactly once even if React re-creates handlers.
  const sendingRef = useRef<{ promptId: number } | null>(null)

  const applyConfigOptionsSnapshot = useCallback(
    (configOptions: unknown) => {
      const store = useAcpStore.getState()
      const model = parseSemanticSelectConfigOption<AcpModelInfo>(
        configOptions,
        'model'
      )
      if (model) {
        store.setSessionModels(
          session.id,
          model.currentId,
          model.available,
          model.configId
        )
      }
      const mode = parseSemanticSelectConfigOption<AcpModeInfo>(
        configOptions,
        'mode'
      )
      if (mode) {
        store.setSessionModes(
          session.id,
          mode.currentId,
          mode.available,
          mode.configId
        )
      }
      const thoughtLevel = parseSemanticSelectConfigOption<AcpThoughtLevelInfo>(
        configOptions,
        'thought_level'
      )
      if (thoughtLevel) {
        store.setSessionThoughtLevels(
          session.id,
          thoughtLevel.currentId,
          thoughtLevel.available,
          thoughtLevel.configId
        )
      } else if (Array.isArray(configOptions)) {
        store.setSessionThoughtLevels(session.id, '', [], '')
      }
    },
    [session.id]
  )

  // Once the live create/resume RPC returns, let it override any stale
  // local snapshot values we may have painted for first render.
  useEffect(() => {
    if (!liveSessionInfo) return
    applyConfigOptionsSnapshot(liveSessionInfo.config_options)

    const commands = parseAvailableCommands({
      availableCommands: liveSessionInfo.available_commands,
    })
    if (commands) {
      useAcpStore.getState().setSessionCommands(session.id, commands)
    }

    useAcpStore.getState().setSessionTitle(session.id, liveSessionInfo.title)
    useAcpStore
      .getState()
      .setPromptImageSupported(session.id, liveSessionInfo.prompt_image)
  }, [applyConfigOptionsSnapshot, liveSessionInfo, session.id])

  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? draft).trim()
      const imagesLoading = (
        useAcpStore.getState().pendingImages[session.id] ?? []
      ).some(i => i.loading)
      if (
        !text ||
        !activeProviderId ||
        sendMutation.isPending ||
        sessionOpening ||
        !localSessionKnown ||
        imagesLoading
      )
        return

      setDraft('')

      const store = useAcpStore.getState()
      const images = store.pendingImages[session.id] ?? []
      const imageInputs: AcpImageInput[] = images.map(i => ({
        data: i.data,
        mime_type: i.mimeType,
      }))
      // Revoke object URLs and clear before send so the tray empties
      // immediately rather than waiting for settle.
      images.forEach(i => URL.revokeObjectURL(i.previewUrl))
      store.clearPendingImages(session.id)

      // Pull `@<path>` tokens out of the prompt text. Match preceded by
      // start-of-string OR whitespace so `email@host` and similar non-mention
      // ats don't accidentally enroll. The backend re-validates against the
      // worktree (traversal, missing files) so we just hand it the raw
      // relative paths.
      const mentions: string[] = []
      const seen = new Set<string>()
      for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
        const path = m[1]
        if (path && !seen.has(path)) {
          mentions.push(path)
          seen.add(path)
        }
      }

      store.pushUserMessage(
        session.id,
        text,
        imageInputs.length > 0
          ? imageInputs.map(i => ({ data: i.data, mimeType: i.mime_type }))
          : undefined,
        undefined,
        mentions.length > 0 ? mentions : undefined
      )

      if (!sessionInfo?.session_id) {
        setLastCreateAttemptProviderId(activeProviderId)
        const result = await createSessionQuery.refetch()
        if (!result.data?.session_id) {
          const errText = result.error
            ? String(result.error)
            : 'session creation returned no id'
          store.appendStreamingText(
            session.id,
            `[error] failed to create session: ${errText}`
          )
          store.finalizeStreamingAssistant(session.id)
          return
        }
      }

      const promptId = Date.now()
      sendingRef.current = { promptId }
      sendMutation.mutate(
        {
          jeanSessionId: session.id,
          text,
          images: imageInputs.length > 0 ? imageInputs : undefined,
          mentions: mentions.length > 0 ? mentions : undefined,
          worktreePath: mentions.length > 0 ? fileSearchRoot : undefined,
        },
        {
          onSettled: (data, _err) => {
            if (sendingRef.current?.promptId === promptId) {
              const stopReason = parseStopReason(data)
              useAcpStore
                .getState()
                .finalizeStreamingAssistant(session.id, stopReason)
              sendingRef.current = null
            }
          },
          onError: e => {
            const msg = String(e)
            // Mention expansion errors (e.g. "@src/foo: No such file") are
            // surfaced as a toast so the user can correct the path without
            // an error block polluting the transcript. Other errors (network,
            // token limits, cancellation) still go inline so they're visible
            // in context.
            if (mentions.length > 0 && msg.includes('@')) {
              toast.error('File mention failed', { description: msg })
            } else {
              useAcpStore
                .getState()
                .appendStreamingText(session.id, `[error] ${msg}`)
            }
          },
        }
      )
    },
    [
      activeProviderId,
      createSessionQuery.refetch,
      draft,
      fileSearchRoot,
      sendMutation,
      session.id,
      sessionInfo?.session_id,
      sessionOpening,
      localSessionKnown,
    ]
  )

  const handleCancel = useCallback(() => {
    if (!acpSessionId) return
    cancelMutation.mutate({ jeanSessionId: session.id })
  }, [acpSessionId, cancelMutation, session.id])

  const mutateConfigOption = useCallback(
    (
      configId: string | undefined,
      valueId: string,
      apply: () => void,
      rollback: () => void
    ) => {
      apply()
      if (!configId) {
        rollback()
        return
      }
      setConfigOptionMutation.mutate(
        { configId, valueId },
        {
          onSuccess: data => {
            const configOptions =
              data && typeof data === 'object'
                ? (data as Record<string, unknown>).configOptions
                : undefined
            if (configOptions !== undefined) {
              applyConfigOptionsSnapshot(configOptions)
            }
          },
          onError: rollback,
        }
      )
    },
    [applyConfigOptionsSnapshot, setConfigOptionMutation]
  )

  /** Optimistic model change. Always uses the dedicated model ACP API. */
  const handleModelChange = useCallback(
    (modelId: string) => {
      if (!acpSessionId) return
      const prev = useAcpStore.getState().currentModelId[session.id]
      if (prev === modelId) return
      useAcpStore.getState().setCurrentModelId(session.id, modelId)
      setModelMutation.mutate(modelId, {
        onError: () => {
          if (prev !== undefined) {
            useAcpStore.getState().setCurrentModelId(session.id, prev)
          }
        },
      })
    },
    [acpSessionId, session.id, setModelMutation]
  )

  /** Same optimistic-with-rollback shape as `handleModelChange`, for mode. */
  const handleModeChange = useCallback(
    (modeId: string) => {
      if (!acpSessionId) return
      const prev = useAcpStore.getState().currentModeId[session.id]
      if (prev === modeId) return
      useAcpStore.getState().setCurrentModeId(session.id, modeId)
      setModeMutation.mutate(modeId, {
        onError: () => {
          if (prev !== undefined) {
            useAcpStore.getState().setCurrentModeId(session.id, prev)
          }
        },
      })
    },
    [acpSessionId, session.id, setModeMutation]
  )

  /** Same optimistic-with-rollback shape as `handleModeChange`, for thought level. */
  const handleThoughtLevelChange = useCallback(
    (thoughtLevelId: string) => {
      if (!acpSessionId) return
      const prev = useAcpStore.getState().currentThoughtLevelId[session.id]
      if (prev === thoughtLevelId) return
      mutateConfigOption(
        thoughtLevelConfigId,
        thoughtLevelId,
        () =>
          useAcpStore
            .getState()
            .setCurrentThoughtLevelId(session.id, thoughtLevelId),
        () => {
          if (prev !== undefined) {
            useAcpStore.getState().setCurrentThoughtLevelId(session.id, prev)
          }
        }
      )
    },
    [acpSessionId, mutateConfigOption, session.id, thoughtLevelConfigId]
  )

  /** Provider choice is purely local draft state until the first send. */
  const handleProviderSelect = useCallback(
    (providerId: string) => {
      if (acpSessionId || providerId === activeProviderId) return
      setSelectedProviderId(providerId)
    },
    [acpSessionId, activeProviderId]
  )

  const handleResolvePermission = useCallback(
    (requestId: string, optionId: string | null) => {
      useAcpStore.getState().removePendingPermission(session.id, requestId)
      acpResolvePermission(requestId, optionId).catch(err => {
        // eslint-disable-next-line no-console
        console.error('[acp] resolve permission failed', err)
      })
    },
    [session.id]
  )

  // Errors stay in the transcript so the user sees the failure inline
  // with their conversation. The "Creating…/Resuming…" loading state
  // moved to the composer toolbar (next to the pickers) so the message
  // list isn't cluttered with a transient row on every tab open — see
  // `Composer`'s `sessionLoadingLabel` prop.
  const sessionStatus: SessionStatus | null =
    !localStateQuery.isLoading && localStateQuery.isError
      ? { kind: 'error', message: String(localStateQuery.error) }
      : !resumeSessionQuery.isFetching &&
          resumeAttempted &&
          resumeSessionQuery.isError
        ? { kind: 'error', message: String(resumeSessionQuery.error) }
        : !createSessionQuery.isFetching &&
            createSessionQuery.isError &&
            lastCreateAttemptProviderId === selectedProviderId
          ? { kind: 'error', message: String(createSessionQuery.error) }
          : null

  const sessionLoadingLabel = localStateQuery.isLoading
    ? 'Loading session…'
    : sessionOpening
      ? hasLocalSession
        ? 'Resuming session…'
        : 'Creating session…'
      : null

  const hasStreaming = streamingBlocks.length > 0

  // Show a "Planning next steps…" placeholder while a prompt is in flight
  // but the agent hasn't emitted any text/thinking/tool call yet for this
  // turn. Suppressed once the first chunk lands (hasStreaming → true) or
  // when we're still waiting on session creation (covered by sessionStatus).
  const planning = sendMutation.isPending && !hasStreaming
  const modelChangePending = setModelMutation.isPending
  const modeChangePending = setModeMutation.isPending
  const thoughtLevelChangePending = setConfigOptionMutation.isPending

  if (providersQuery.isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading providers...</span>
      </div>
    )
  }

  if (providersQuery.isError) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <CopyableErrorAlert
          title={'Failed to load providers'}
          error={
            providersQuery.error instanceof Error
              ? providersQuery.error.message
              : 'Unknown error'
          }
        ></CopyableErrorAlert>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <AcpBanner sessionId={session.id} acpSessionId={acpSessionId} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <MessageList
            messages={messages}
            streamingBlocks={streamingBlocks}
            hasStreaming={hasStreaming}
            planning={planning}
            status={sessionStatus}
            pendingPermissions={pendingPermissions}
            onResolvePermission={handleResolvePermission}
            sessionPlan={sessionPlan}
            availableProviders={providersQuery.data ?? []}
            selectedProviderId={activeProviderId}
            onProviderSelect={handleProviderSelect}
            showProviderChooser={
              localSessionKnown && !hasLocalSession && !hasAcpSession
            }
            sessionCreating={
              localStateQuery.isLoading || sessionOpening || hasAcpSession
            }
          />
          {/* Bottom fade — mirrors the non-ACP chat (`ChatWindow.tsx:2594`).
              8px-tall gradient that fades scroll content into the
              background as it slides under the composer, so the message
              list doesn't end with a hard cut. */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-8 bg-gradient-to-b from-transparent to-background" />
        </div>
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onCancel={handleCancel}
          sending={sendMutation.isPending}
          disabled={!localSessionKnown || sessionOpening || !activeProviderId}
          canCancel={hasAcpSession && sendMutation.isPending}
          availableModels={availableModels}
          currentModelId={currentModelId}
          onModelChange={handleModelChange}
          modelChangeDisabled={!acpSessionId || modelChangePending}
          availableModes={availableModes}
          currentModeId={currentModeId}
          onModeChange={handleModeChange}
          modeChangeDisabled={!acpSessionId || modeChangePending}
          availableThoughtLevels={availableThoughtLevels}
          currentThoughtLevelId={currentThoughtLevelId}
          onThoughtLevelChange={handleThoughtLevelChange}
          thoughtLevelChangeDisabled={
            !acpSessionId || !thoughtLevelConfigId || thoughtLevelChangePending
          }
          availableCommands={availableCommands}
          usage={usage}
          pendingImages={pendingImages}
          promptImageSupported={promptImageSupported}
          sessionId={session.id}
          worktreePath={fileSearchRoot}
          sessionLoadingLabel={sessionLoadingLabel}
        />
      </div>
    </div>
  )
}

interface SessionStatus {
  kind: 'error'
  message: string
}

function MessageList({
  messages,
  streamingBlocks,
  hasStreaming,
  planning,
  status,
  pendingPermissions,
  onResolvePermission,
  sessionPlan,
  availableProviders,
  selectedProviderId,
  onProviderSelect,
  showProviderChooser,
  sessionCreating,
}: {
  messages: AcpUiMessage[]
  streamingBlocks: AcpAssistantBlock[]
  hasStreaming: boolean
  planning: boolean
  status: SessionStatus | null
  pendingPermissions: AcpPendingPermission[]
  onResolvePermission: (requestId: string, optionId: string | null) => void
  sessionPlan: AcpPlanEntry[] | null
  availableProviders: { id: string; name: string }[]
  selectedProviderId: string | null
  onProviderSelect: (providerId: string) => void
  showProviderChooser: boolean
  sessionCreating: boolean
}) {
  // Auto-scroll to bottom on new content. We measure inside an effect so
  // the scroll happens after layout, not during render.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [messages, streamingBlocks, status, planning, pendingPermissions])

  const isEmpty =
    messages.length === 0 &&
    !hasStreaming &&
    !planning &&
    !status &&
    pendingPermissions.length === 0

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      {sessionPlan && sessionPlan.length > 0 && (
        <div className="sticky top-0 z-10 px-4 pt-2 pb-1 md:px-6">
          <StickyPlanStrip entries={sessionPlan} />
        </div>
      )}
      <div className="mx-auto max-w-7xl px-4 pt-4 pb-6 md:px-6 min-w-0 w-full">
        <div className="select-text space-y-4 font-mono text-sm min-w-0 break-words overflow-x-auto">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-4 pt-16">
              {showProviderChooser && availableProviders.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2">
                  {availableProviders.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={sessionCreating}
                      onClick={() => onProviderSelect(p.id)}
                      className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                        selectedProviderId === p.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-foreground hover:bg-muted'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {messages.map(m => (
                <MessageRow key={m.id} message={m} />
              ))}
              {hasStreaming ? (
                <LiveAssistantRow blocks={streamingBlocks} />
              ) : planning ? (
                <PlanningRow />
              ) : null}
              {pendingPermissions.map(req => (
                <PermissionPrompt
                  key={req.requestId}
                  request={req}
                  onResolve={onResolvePermission}
                />
              ))}
              {status ? <SessionStatusRow status={status} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PlanningRow() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>Planning next steps…</span>
    </div>
  )
}

/**
 * Inline card for a pending `session/request_permission`. Visually quiet
 * — the agent has already shown the tool call (`Ready to code? · pending`)
 * just above, so we don't repeat the title prominently. One clear primary
 * action (the highest-weight allow option), other allows as outline,
 * reject options as ghost. Drops the explicit Cancel; the agent's own
 * reject options cover that semantically.
 */
function PermissionPrompt({
  request,
  onResolve,
}: {
  request: AcpPendingPermission
  onResolve: (requestId: string, optionId: string | null) => void
}) {
  // Preserve agent order — the agent picked it deliberately. Primary is
  // the *least aggressive* allow option (last allow before any reject) so
  // we don't make "bypass permissions" the default click target. Reject
  // options stay where the agent put them but render quietly.
  const allowOpts = request.options.filter(o => !isRejectKind(o.kind))
  const primaryId = allowOpts[allowOpts.length - 1]?.optionId
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Shield className="h-3.5 w-3.5" />
        <span>Permission needed</span>
        {request.toolTitle ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate font-mono text-foreground">
              {request.toolTitle}
            </span>
          </>
        ) : null}
      </div>
      {request.description ? (
        <div className="mb-3 whitespace-pre-wrap text-sm text-foreground">
          {request.description}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {request.options.map(opt => {
          const isPrimary = opt.optionId === primaryId
          const isReject = isRejectKind(opt.kind)
          return (
            <Button
              key={opt.optionId}
              type="button"
              size="sm"
              variant={isPrimary ? 'default' : isReject ? 'ghost' : 'outline'}
              onClick={() => onResolve(request.requestId, opt.optionId)}
              className={cn(
                'h-7 text-xs',
                isReject && !isPrimary && 'text-muted-foreground'
              )}
            >
              {opt.name}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function isRejectKind(kind: string | undefined): boolean {
  return kind?.startsWith('reject') ?? false
}

function SessionStatusRow({ status }: { status: SessionStatus }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <CopyableErrorAlert
        title={'Failed to start session'}
        error={status.message}
      ></CopyableErrorAlert>
    </div>
  )
}

function MessageRow({ message }: { message: AcpUiMessage }) {
  if (message.role === 'user') {
    return <UserMessageRow message={message} />
  }
  return (
    <div className="space-y-1">
      <AssistantBody blocks={message.blocks} streaming={false} />
      <StopReasonFooter stopReason={message.stopReason} />
    </div>
  )
}

function UserMessageRow({
  message,
}: {
  message: Extract<AcpUiMessage, { role: 'user' }>
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(0)

  const images: AcpLightboxImage[] = (message.images ?? []).map(i => ({
    data: i.data,
    mimeType: i.mimeType,
  }))

  return (
    <div className="w-full rounded-lg border border-border bg-muted/20 px-3 py-2 text-foreground min-w-0 break-words">
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setLightboxIndex(i)
                setLightboxOpen(true)
              }}
              className="group relative overflow-hidden rounded-md border border-border/60 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`View image ${i + 1}`}
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt=""
                className="h-24 max-w-[12rem] object-cover transition-opacity group-hover:opacity-80"
              />
            </button>
          ))}
        </div>
      )}
      {message.mentions && message.mentions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {message.mentions.map(path => {
            const sep = path.lastIndexOf('/')
            const basename = sep >= 0 ? path.slice(sep + 1) : path
            return (
              <span
                key={path}
                title={path}
                className="inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                <FileText className="h-3 w-3 shrink-0" />
                {basename}
              </span>
            )
          })}
        </div>
      )}
      <div className="whitespace-pre-wrap break-words">
        {message.text || ' '}
      </div>
      {images.length > 0 && (
        <AcpImageLightbox
          images={images}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
        />
      )}
    </div>
  )
}

/**
 * One-liner shown under a finalized assistant turn when the agent
 * stopped for a non-normal reason. `end_turn` is the happy path and
 * suppressed entirely — surfacing it on every message would be visual
 * noise. The other four reasons (`cancelled`, `refusal`, `max_tokens`,
 * `max_turn_requests`) all signal something the user needs to know.
 */
function StopReasonFooter({ stopReason }: { stopReason?: string }) {
  if (!stopReason || stopReason === 'end_turn') return null
  const label = stopReasonLabel(stopReason)
  const tone = stopReasonTone(stopReason)
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
        tone
      )}
    >
      <span aria-hidden>•</span>
      <span>{label}</span>
    </div>
  )
}

function stopReasonLabel(reason: string): string {
  switch (reason) {
    case 'cancelled':
      return 'Cancelled'
    case 'refusal':
      return 'Refused'
    case 'max_tokens':
      return 'Max tokens reached'
    case 'max_turn_requests':
      return 'Max turn requests reached'
    default:
      // Forward-compat: surface the raw id rather than swallowing it.
      return reason
  }
}

/** Refusal/limit reasons get a warning tint; cancellation is neutral
 *  since it's user-initiated. Unknown reasons fall back to the
 *  warning tone — better to be visible than invisible. */
function stopReasonTone(reason: string): string {
  if (reason === 'cancelled') return 'bg-muted/40 text-muted-foreground'
  return 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
}

function LiveAssistantRow({ blocks }: { blocks: AcpAssistantBlock[] }) {
  return <AssistantBody blocks={blocks} streaming />
}

/**
 * Render an assistant turn as an ordered timeline of blocks. Each block
 * carries its own kind so we render text, thinking, and tool calls inline
 * at the position the agent emitted them — preserving the
 * narration → tool → narration → tool sequence.
 *
 * `streaming` is forwarded to text and thinking blocks so the markdown
 * renderer can avoid trailing-newline flicker and the thinking panel
 * auto-expands while in flight.
 */
function AssistantBody({
  blocks,
  streaming,
}: {
  blocks: AcpAssistantBlock[]
  streaming: boolean
}) {
  if (blocks.length === 0) return null
  return (
    <div className="w-full min-w-0 space-y-2 break-words">
      {blocks.map((block, i) => {
        if (block.kind === 'thinking') {
          // A thought is "live" only while it's still the trailing block of
          // a streaming turn — once any other block lands after it, the
          // model has moved on and the thought should collapse.
          const live = streaming && i === blocks.length - 1
          return (
            <ThinkingBlock key={`th-${i}`} text={block.text} streaming={live} />
          )
        }
        if (block.kind === 'tool') {
          return <ToolCallRow key={`tool-${block.call.id}`} call={block.call} />
        }
        if (block.kind === 'plan') {
          return (
            <PlanBlock
              key={`plan-${i}`}
              entries={block.entries}
              streaming={streaming}
            />
          )
        }
        // text — only the *finalized* turn checks for the /context block.
        // Streaming chunks should keep flowing through the normal
        // markdown renderer to avoid render flicker mid-parse.
        const isContext = !streaming && hasContextUsage(block.text)
        if (isContext) {
          const parsed = parseContextUsage(block.text)
          if (parsed) return <ContextCard key={`tx-${i}`} data={parsed} />
        }
        return (
          <Markdown key={`tx-${i}`} streaming={streaming}>
            {block.text}
          </Markdown>
        )
      })}
    </div>
  )
}

/**
 * "Thinking" output from the agent.
 *
 * - While **streaming** we render the live text inline (italic, sans-serif,
 *   with a brain icon on the left) so the user can watch the reasoning land
 *   without an extra header or collapsible chrome — the text itself is the
 *   signal.
 * - Once the turn finalizes we collapse into the same chevron + teaser
 *   panel used for `ToolCallRow`, keeping the transcript scannable.
 */
function ThinkingBlock({
  text,
  streaming,
}: {
  text: string
  streaming: boolean
}) {
  const [userToggled, setUserToggled] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  if (streaming) {
    return (
      <div className="flex items-start gap-2 px-2 py-1">
        <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <p className="font-sans text-xs italic leading-relaxed text-muted-foreground/70 whitespace-pre-wrap break-words min-w-0 flex-1">
          {text}
        </p>
      </div>
    )
  }
  const open = userToggled ? manualOpen : false
  const teaser = firstNonEmptyLine(text)
  return (
    <div className="rounded px-2 py-1 hover:bg-muted/20">
      <button
        type="button"
        onClick={() => {
          setUserToggled(true)
          setManualOpen(!open)
        }}
        className="flex w-full cursor-pointer items-center gap-2 text-left text-xs"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90'
          )}
        />
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="shrink-0 text-muted-foreground/70">Thinking</span>
        {!open && teaser ? (
          <>
            <span className="shrink-0 text-muted-foreground/40">·</span>
            <span className="truncate text-muted-foreground/60">{teaser}</span>
          </>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 pl-5">
          <p className="font-sans text-xs italic leading-relaxed text-muted-foreground/70 whitespace-pre-wrap break-words">
            {text}
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** First non-empty trimmed line of `text` — used as the always-visible
 *  teaser so the user can see what the model is reasoning about without
 *  expanding the panel. */
function firstNonEmptyLine(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line) return line
  }
  return undefined
}

/**
 * Renders an agent execution plan as a checklist. Per spec, each update is a
 * full snapshot — entries replace wholesale. Status icons: ○ pending,
 * ⟳ in_progress, ✓ completed. High-priority entries get full foreground color.
 */
/**
 * Inline plan block rendered at the position in the transcript where the
 * agent first emitted the plan. The always-visible mirror of the latest
 * plan lives in `StickyPlanStrip` at the top of the scroll container.
 */
function PlanBlock({
  entries,
  streaming,
}: {
  entries: AcpPlanEntry[]
  streaming: boolean
}) {
  const done = entries.filter(e => e.status === 'completed').length
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          To-dos
          {!streaming && entries.length > 0 && (
            <span className="ml-1.5 tabular-nums">
              {done}/{entries.length}
            </span>
          )}
        </span>
      </div>
      <ul className="divide-y divide-border/30 max-h-[8.25rem] overflow-y-auto">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-start gap-2.5 px-3 py-2">
            <PlanEntryIcon status={entry.status} />
            <span
              className={cn(
                'text-xs leading-relaxed min-w-0 flex-1',
                entry.status === 'completed'
                  ? 'text-muted-foreground line-through decoration-muted-foreground/50'
                  : entry.priority === 'high'
                    ? 'text-foreground'
                    : 'text-foreground/80'
              )}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Compact always-visible mirror of the latest plan, pinned to the top of
 * the scroll container. Hides itself only when the session has no plan at
 * all — completed plans stay visible so the user can review the final list.
 */
function StickyPlanStrip({ entries }: { entries: AcpPlanEntry[] }) {
  const done = entries.filter(e => e.status === 'completed').length
  const listRef = useRef<HTMLUListElement | null>(null)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)
  // Auto-scroll to the last completed entry so the user lands with the
  // most-recent done item visible at the top, just above what's in flight.
  let lastDone = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.status === 'completed') lastDone = i
  }
  const updateFades = useCallback(() => {
    const ul = listRef.current
    if (!ul) return
    setCanScrollUp(ul.scrollTop > 0)
    setCanScrollDown(ul.scrollTop + ul.clientHeight < ul.scrollHeight - 1)
  }, [])
  useEffect(() => {
    const ul = listRef.current
    if (!ul) return
    if (lastDone > 0) {
      const target = ul.children[lastDone] as HTMLElement | undefined
      if (target) ul.scrollTop = target.offsetTop - ul.offsetTop
    }
    updateFades()
  }, [lastDone, entries.length, updateFades])
  return (
    <div className="mx-auto max-w-7xl rounded-md border border-border/60 bg-background/80 backdrop-blur overflow-hidden shadow-sm">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/40">
        <div className="flex items-center gap-1.5">
          <ListChecks className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="text-[11px] font-medium text-muted-foreground">
            To-dos
          </span>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {done}/{entries.length}
        </span>
      </div>
      <div className="relative">
        <ul
          ref={listRef}
          onScroll={updateFades}
          className="divide-y divide-border/30 max-h-[84px] overflow-y-auto"
        >
          {entries.map((entry, i) => (
            <li key={i} className="flex items-center gap-2 px-3 py-1.5">
              <PlanEntryIcon status={entry.status} />
              <span
                className={cn(
                  'text-[11px] leading-snug min-w-0 flex-1 truncate',
                  entry.status === 'completed'
                    ? 'text-muted-foreground line-through decoration-muted-foreground/50'
                    : entry.status === 'in_progress'
                      ? 'text-foreground font-medium'
                      : 'text-foreground/70'
                )}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
        {canScrollUp && (
          <div className="pointer-events-none absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-background to-transparent" />
        )}
        {canScrollDown && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
    </div>
  )
}

function PlanEntryIcon({ status }: { status: AcpPlanEntry['status'] }) {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 shrink-0 h-3.5 w-3.5 rounded-full bg-primary/15 flex items-center justify-center">
        <svg
          viewBox="0 0 10 10"
          className="h-2 w-2 text-primary"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="1.5,5 4,7.5 8.5,2.5" />
        </svg>
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <Loader2 className="mt-0.5 shrink-0 h-3.5 w-3.5 text-primary animate-spin" />
    )
  }
  return (
    <span className="mt-0.5 shrink-0 h-3.5 w-3.5 rounded-full border border-border/70" />
  )
}

/**
 * Compact per-tool-call row: status icon + kind icon + title with optional
 * inline summary (Bash command, file path), and a collapsible details
 * section for raw input/output and diff/content blocks. Renders the same
 * layout for live and finalized calls — `status` drives the badge.
 */
function ToolCallRow({ call }: { call: AcpToolCall }) {
  const [open, setOpen] = useState(false)
  const summary = inlineSummary(call)
  const hasDetails = Boolean(
    call.rawInput || call.rawOutput || (call.content && call.content.length > 0)
  )
  // Successful runs are the dominant case; a row of green checks adds
  // visual noise without information. Only surface a status icon when the
  // call is still going (loading) or actually broke (failed).
  const StatusIcon =
    call.status === 'failed'
      ? CircleAlert
      : call.status === 'completed'
        ? null
        : Loader2
  const statusClass =
    call.status === 'failed'
      ? 'text-destructive'
      : 'text-muted-foreground animate-spin'

  return (
    <div className="rounded px-2 py-1 hover:bg-muted/20">
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex w-full items-center gap-2 text-left text-xs',
          hasDetails ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        {StatusIcon ? (
          <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusClass)} />
        ) : null}
        <KindIcon kind={call.kind} />
        <span className="truncate text-muted-foreground/70">{call.title}</span>
        {summary ? (
          <span className="truncate font-mono text-muted-foreground/50">
            {summary}
          </span>
        ) : null}
      </button>
      {open && hasDetails ? (
        <div className="mt-2 space-y-2 pl-5">
          {call.content?.map((c, i) => (
            <ToolContentBlock key={i} block={c} />
          ))}
          {call.rawInput !== undefined ? (
            <RawBlock label="input" value={call.rawInput} />
          ) : null}
          {call.rawOutput !== undefined ? (
            <RawBlock label="output" value={call.rawOutput} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function KindIcon({ kind }: { kind: string }) {
  const Icon =
    kind === 'read'
      ? FileText
      : kind === 'edit'
        ? Pencil
        : kind === 'execute'
          ? TerminalIcon
          : kind === 'search'
            ? Search
            : kind === 'fetch'
              ? Download
              : kind === 'think'
                ? Brain
                : kind === 'delete'
                  ? Trash2
                  : Wrench
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
}

function ToolContentBlock({ block }: { block: AcpToolCallContent }) {
  if (block.type === 'diff') {
    return (
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{block.path}</div>
        <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1.5 text-xs">
          {block.newText}
        </pre>
      </div>
    )
  }
  if (block.type === 'terminal') {
    return (
      <div className="text-xs text-muted-foreground">
        terminal: <span className="font-mono">{block.terminalId}</span>
      </div>
    )
  }
  if (block.text) {
    return (
      <div className="rounded bg-muted/50 px-2 py-1.5 text-xs">
        <Markdown streaming={false}>{block.text}</Markdown>
      </div>
    )
  }
  return null
}

function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {typeof value === 'string' ? (
        <div className="max-h-96 overflow-auto rounded bg-muted/50 px-2 py-1.5 text-xs">
          <Markdown streaming={false}>{value}</Markdown>
        </div>
      ) : (
        <pre className="max-h-40 overflow-auto rounded bg-muted/50 px-2 py-1.5 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  )
}

/**
 * Pull a one-line inline hint from the tool's raw input — Bash command,
 * Edit/Read file path, etc. Returns `undefined` when the title already
 * conveys it (no point repeating).
 */
function inlineSummary(call: AcpToolCall): string | undefined {
  const input = call.rawInput as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return undefined
  if (call.kind === 'execute' && typeof input.command === 'string') {
    const cmd = input.command as string
    // Title for `execute` is often the command itself — skip the
    // duplicate. Only show when the agent picked a friendlier title.
    return call.title.includes(cmd) ? undefined : cmd
  }
  if (
    (call.kind === 'edit' || call.kind === 'read' || call.kind === 'delete') &&
    typeof input.file_path === 'string'
  ) {
    // Title usually already includes the path; only add when it doesn't.
    const path = input.file_path as string
    return call.title.includes(path) ? undefined : path
  }
  return undefined
}

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /** Submit the current composer value, or `override` if provided. */
  onSend: (override?: string) => void
  onCancel: () => void
  /** `true` while the current prompt is in flight. Drives the stop-icon
   *  swap on the send button. Does NOT cover session-loading — that's
   *  the separate `disabled` flag. */
  sending: boolean
  /** Disables sending without showing the stop icon. Used while session
   *  creation/resume is in flight (and any future "agent unavailable"
   *  states). Composer keeps the send icon, just inert. */
  disabled: boolean
  /** Show the Cancel button only when there's actually something to cancel
   * — i.e. an in-flight prompt against a known ACP session. */
  canCancel: boolean
  availableModels: AcpModelInfo[]
  currentModelId: string | undefined
  onModelChange: (modelId: string) => void
  modelChangeDisabled: boolean
  availableModes: AcpModeInfo[]
  currentModeId: string | undefined
  onModeChange: (modeId: string) => void
  modeChangeDisabled: boolean
  availableThoughtLevels: AcpThoughtLevelInfo[]
  currentThoughtLevelId: string | undefined
  onThoughtLevelChange: (thoughtLevelId: string) => void
  thoughtLevelChangeDisabled: boolean
  /** Slash command catalog from the agent. Empty → popover never opens. */
  availableCommands: AcpAvailableCommand[]
  /** Latest usage snapshot — drives the cost / context% strip above
   *  the composer. Empty object when nothing has been reported yet. */
  usage: AcpUsage
  pendingImages: AcpPendingImage[]
  /** When `true`, show the image attachment button and accept paste/drop. */
  promptImageSupported: boolean
  /** When non-null, render a small spinner + label in the toolbar (next
   *  to the pickers) indicating session creation/resume is in flight. */
  sessionLoadingLabel: string | null
  /** Session id — needed for dispatching pending-image store actions. */
  sessionId: string
  /** Absolute worktree root — search scope for the @file mention popover. */
  worktreePath: string
}

/**
 * ACP composer — visually mirrors `ChatWindow`'s composer card so the UX is
 * consistent with the non-ACP chat. Strips back to ACP's actual feature
 * set: a textarea up top, a thin toolbar with the model picker on the
 * left and `SendCancelButton` on the right.
 *
 * Reuses `SendCancelButton` from `components/chat/toolbar` — that
 * component is store-agnostic and presentation-only, no chat coupling.
 *
 * Layout chain (matches `ChatWindow.tsx:2956-3110`):
 *   bg-background → max-w-7xl → max-w-3xl xl:max-w-4xl → form (the card)
 */
function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  sending,
  disabled,
  canCancel,
  availableModels,
  currentModelId,
  onModelChange,
  modelChangeDisabled,
  availableModes,
  currentModeId,
  onModeChange,
  modeChangeDisabled,
  availableThoughtLevels,
  currentThoughtLevelId,
  onThoughtLevelChange,
  thoughtLevelChangeDisabled,
  availableCommands,
  usage,
  pendingImages,
  promptImageSupported,
  sessionLoadingLabel,
  sessionId,
  worktreePath,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const textareaWrapRef = useRef<HTMLDivElement | null>(null)
  const slashHandleRef = useRef<AcpSlashPopoverHandle | null>(null)
  const mentionHandleRef = useRef<AcpMentionPopoverHandle | null>(null)
  const [slashGhost, setSlashGhost] = useState<SlashGhost | null>(null)
  const [caretPos, setCaretPos] = useState(0)
  // Esc closes the mention popover without modifying the textarea. Reset on
  // any value change so typing past the dismissal naturally re-opens.
  const [mentionDismissed, setMentionDismissed] = useState(false)
  useEffect(() => {
    setMentionDismissed(false)
  }, [value])
  const updateCaret = useCallback(() => {
    const el = textareaRef.current
    if (el) setCaretPos(el.selectionStart ?? 0)
  }, [])
  const [isDragOver, setIsDragOver] = useState(false)
  const [trayLightboxOpen, setTrayLightboxOpen] = useState(false)
  const [trayLightboxIndex, setTrayLightboxIndex] = useState(0)
  const [plusOpen, setPlusOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Use Tauri's native drag-drop event instead of HTML5 drag events.
  // dragDropEnabled=true in tauri.conf.json intercepts OS-level file drops
  // before they reach the DOM, so onDrop never fires on the form element.
  useEffect(() => {
    if (!promptImageSupported) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    let lastDropTime = 0

    const setup = async () => {
      const { isNativeApp } = await import('@/lib/environment')
      if (!isNativeApp()) return
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const unlistenFn = await getCurrentWindow().onDragDropEvent(
        async event => {
          if (event.payload.type === 'enter') {
            setIsDragOver(true)
          } else if (event.payload.type === 'leave') {
            setIsDragOver(false)
          } else if (event.payload.type === 'drop') {
            setIsDragOver(false)
            const now = Date.now()
            if (now - lastDropTime < 500) return
            lastDropTime = now

            const imagePaths = event.payload.paths.filter(p => {
              const ext = p.split('.').pop()?.toLowerCase() ?? ''
              return ['png', 'jpg', 'jpeg', 'webp'].includes(ext)
            })
            if (imagePaths.length === 0) return

            const { readFile } = await import('@tauri-apps/plugin-fs')
            for (const path of imagePaths) {
              const ext = path.split('.').pop()?.toLowerCase() ?? 'jpeg'
              const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
              const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
              try {
                const bytes = await readFile(path)
                const blob = new Blob([bytes], { type: mimeType })
                const previewUrl = URL.createObjectURL(blob)
                useAcpStore.getState().addPendingImage(sessionId, {
                  id,
                  data: '',
                  mimeType,
                  previewUrl,
                  loading: true,
                })
                let binary = ''
                for (const b of bytes) binary += String.fromCharCode(b)
                const rawData = btoa(binary)
                try {
                  const processed = await invoke<{
                    data: string
                    mime_type: string
                  }>('acp_process_image', { data: rawData, mimeType })
                  useAcpStore.getState().updatePendingImage(sessionId, id, {
                    data: processed.data,
                    mimeType: processed.mime_type,
                    loading: false,
                  })
                } catch {
                  useAcpStore.getState().updatePendingImage(sessionId, id, {
                    data: rawData,
                    loading: false,
                  })
                }
              } catch (e) {
                console.error('Failed to read dropped image', path, e)
              }
            }
          }
        }
      )
      if (!cancelled) unlisten = unlistenFn
      else unlistenFn()
    }
    setup()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [promptImageSupported, sessionId])

  /** Restore focus to the chat textarea after a popover closes. Deferred
   *  to the next frame so Radix's auto-focus restoration doesn't immediately
   *  bounce focus back to the popover trigger. */
  const focusTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [])

  // Shift+Tab "hold-to-cycle" for the mode picker. Pressing Shift+Tab opens
  // the popover and advances to the next mode; subsequent Tab presses
  // (while Shift is still held) keep advancing. Releasing Shift closes the
  // popover and restores focus to the textarea. Wired at window/capture so
  // it pre-empts browser focus traversal regardless of where focus lives.
  const [modePickerOpen, setModePickerOpen] = useState(false)
  const shiftCycleActiveRef = useRef(false)
  useEffect(() => {
    if (modeChangeDisabled || availableModes.length < 2) return
    const advance = () => {
      const idx = availableModes.findIndex(m => m.id === currentModeId)
      const next = availableModes[(idx + 1) % availableModes.length]
      if (next && next.id !== currentModeId) onModeChange(next.id)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)
        return
      e.preventDefault()
      e.stopImmediatePropagation()
      shiftCycleActiveRef.current = true
      setModePickerOpen(true)
      advance()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      // Close on Shift release, but only if we actually opened the popover
      // via Shift+Tab (avoids closing it if the user opened it some other
      // way and happened to be holding Shift).
      if (e.key !== 'Shift' || !shiftCycleActiveRef.current) return
      shiftCycleActiveRef.current = false
      setModePickerOpen(false)
      focusTextarea()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
    }
  }, [
    availableModes,
    currentModeId,
    focusTextarea,
    modeChangeDisabled,
    onModeChange,
  ])

  // Slash popover opens when the textarea content matches `/^\/[^\s]*$/` —
  // a leading slash optionally followed by a word, with no whitespace and
  // nothing before it. The popover tracks the substring after `/` as its
  // search query. Closing on space, newline, or any non-matching edit.
  const slashMatch = /^\/([^\s]*)$/.exec(value)
  const slashQuery = slashMatch?.[1] ?? ''
  const slashOpen = slashMatch != null && availableCommands.length > 0
  const visibleSlashGhostHint = getVisibleSlashGhostHint(value, slashGhost)

  useEffect(() => {
    if (!slashGhost) return
    if (shouldKeepSlashGhost(value, slashGhost)) return
    setSlashGhost(null)
  }, [value, slashGhost])

  // Mention popover detection: walk back from the caret looking for an `@`
  // that's at start-of-string or preceded by whitespace, and where the
  // run from `@` to the caret contains no whitespace. That run becomes
  // the popover's search query. Mid-sentence `@src/foo` works; `email@host`
  // and `@with space` do not (correctly — neither is a mention attempt).
  const mentionMatch = (() => {
    if (slashOpen) return null // don't double-open with slash popover
    let i = caretPos - 1
    while (i >= 0) {
      const ch = value[i]
      if (ch === '@') {
        const before = i === 0 ? ' ' : (value[i - 1] ?? ' ')
        if (!/\s/.test(before)) return null
        const query = value.slice(i + 1, caretPos)
        if (/\s/.test(query)) return null
        return { startIndex: i, query }
      }
      if (ch === undefined || /\s/.test(ch)) return null
      i--
    }
    return null
  })()
  const mentionOpen =
    mentionMatch != null && !mentionDismissed && !!worktreePath

  const handleMentionSelect = useCallback(
    (relPath: string) => {
      const el = textareaRef.current
      if (!el) return
      const caret = el.selectionStart ?? value.length
      // Re-derive the mention range from the live value/caret to defend
      // against the value having shifted between popover render and click.
      let i = caret - 1
      while (i >= 0) {
        const ch = value[i]
        if (ch === '@') break
        if (ch === undefined || /\s/.test(ch)) {
          i = -1
          break
        }
        i--
      }
      if (i < 0) return
      const before = value.slice(0, i)
      const after = value.slice(caret)
      const insertion = `@${relPath} `
      const next = before + insertion + after
      const newCaret = before.length + insertion.length
      onChange(next)
      requestAnimationFrame(() => {
        const el2 = textareaRef.current
        if (!el2) return
        el2.focus()
        el2.setSelectionRange(newCaret, newCaret)
        setCaretPos(newCaret)
      })
    },
    [value, onChange]
  )

  // Focus the composer when the global keybinding system dispatches
  // `focus-chat-input` (default `mod+l`, user-rebindable via preferences).
  // Mirrors the non-ACP chat in `useChatWindowEvents.ts` — we share the
  // CustomEvent so a single keystroke focuses whichever chat is mounted.
  // We don't roll our own keydown listener: the global handler in
  // `useMainWindowEventListeners.ts` already calls `preventDefault` +
  // `stopPropagation` on the matched shortcut, so a parallel keydown
  // listener would never receive the event anyway.
  useEffect(() => {
    const onFocus = () => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      // Place caret at end so the user can keep typing without an extra
      // keystroke after the focus jump.
      const end = el.value.length
      el.setSelectionRange(end, end)
    }
    window.addEventListener('focus-chat-input', onFocus)
    return () => window.removeEventListener('focus-chat-input', onFocus)
  }, [])

  // Add image from a File object (paste or drop). Reads as base64, creates
  // a preview object-URL, stores in the pending-images slice. Only active
  // when `promptImageSupported` is true. Silently ignores non-image files.
  const addImageFile = useCallback(
    (file: File) => {
      if (!promptImageSupported) return
      if (!file.type.startsWith('image/')) return
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const previewUrl = URL.createObjectURL(file)
      // Add a loading placeholder immediately so the tray shows a spinner.
      useAcpStore.getState().addPendingImage(sessionId, {
        id,
        data: '',
        mimeType: file.type,
        previewUrl,
        loading: true,
      })
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as string
        const comma = result.indexOf(',')
        if (comma === -1) {
          useAcpStore.getState().removePendingImage(sessionId, id)
          return
        }
        const rawData = result.slice(comma + 1)
        try {
          const processed = await invoke<{ data: string; mime_type: string }>(
            'acp_process_image',
            { data: rawData, mimeType: file.type }
          )
          useAcpStore.getState().updatePendingImage(sessionId, id, {
            data: processed.data,
            mimeType: processed.mime_type,
            loading: false,
          })
        } catch {
          // Processing failed — fall back to raw data, still usable.
          useAcpStore.getState().updatePendingImage(sessionId, id, {
            data: rawData,
            loading: false,
          })
        }
      }
      reader.readAsDataURL(file)
    },
    [promptImageSupported, sessionId]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!promptImageSupported) return
      const files = Array.from(e.clipboardData.files).filter(f =>
        f.type.startsWith('image/')
      )
      if (files.length === 0) return
      e.preventDefault()
      files.forEach(addImageFile)
    },
    [promptImageSupported, addImageFile]
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim() || sending) return
    onSend()
  }

  /** Picked from the slash popover. Keep `/name ` in the textarea so the
   *  user can review or add args before pressing Enter. The trailing space
   *  closes the popover automatically because the slash regex no longer
   *  matches. */
  const handleSlashSelect = useCallback(
    (cmd: AcpAvailableCommand) => {
      const next = `/${cmd.name} `
      setSlashGhost(buildSlashGhost(cmd))
      onChange(next)
      // Refocus + place caret at the end so the user can immediately
      // keep typing.
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.length, next.length)
      })
    },
    [onChange]
  )

  return (
    <div className="bg-background">
      <div className="mx-auto max-w-7xl">
        <div className="relative sm:mx-auto sm:mb-3 sm:max-w-3xl xl:max-w-4xl">
          <form
            onSubmit={handleSubmit}
            className={cn(
              'relative overflow-hidden border-t border-border bg-card sm:rounded-lg sm:border transition-colors',
              isDragOver && 'border-primary ring-1 ring-primary'
            )}
          >
            <AcpUsageStrip
              usage={usage}
              onClose={focusTextarea}
              shortcut={{
                display: '⌘ U',
                match: e =>
                  e.key === 'u' &&
                  (e.metaKey || e.ctrlKey) &&
                  !e.shiftKey &&
                  !e.altKey,
              }}
            />
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 px-4 pt-2 md:px-6">
                {pendingImages.map((img, i) => (
                  <div key={img.id} className="group relative cursor-pointer">
                    {img.loading ? (
                      <div className="h-16 w-16 rounded-md border border-border/60 bg-muted/40 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <img
                        src={img.previewUrl}
                        alt=""
                        onClick={() => {
                          setTrayLightboxIndex(i)
                          setTrayLightboxOpen(true)
                        }}
                        className="h-16 w-16 rounded-md object-cover border border-border/60 transition-opacity group-hover:opacity-80"
                      />
                    )}
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        URL.revokeObjectURL(img.previewUrl)
                        useAcpStore
                          .getState()
                          .removePendingImage(sessionId, img.id)
                      }}
                      className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-background border border-border text-muted-foreground hover:text-foreground text-xs leading-none"
                      aria-label="Remove image"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <AcpImageLightbox
              images={pendingImages.map(i => ({
                data: i.data,
                mimeType: i.mimeType,
              }))}
              initialIndex={trayLightboxIndex}
              open={trayLightboxOpen}
              onOpenChange={setTrayLightboxOpen}
            />
            {/* Textarea section. Mirror ChatInput.tsx — wrap in
                `relative min-w-0` so the textarea can shrink and any
                future overlay (file mention, slash) anchors correctly. */}
            <div className="px-4 pt-3 pb-2 md:px-6">
              <div ref={textareaWrapRef} className="relative min-w-0">
                {visibleSlashGhostHint ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono text-base md:text-sm"
                  >
                    <span className="invisible">{value}</span>
                    <span className="text-muted-foreground/45">
                      {visibleSlashGhostHint}
                    </span>
                  </div>
                ) : null}
                <Textarea
                  ref={textareaRef}
                  value={value}
                  onChange={e => {
                    onChange(e.target.value)
                    // The browser updates selectionStart synchronously after
                    // typing, but onChange fires before React reads it back —
                    // schedule a microtask so caretPos lands on the new value.
                    queueMicrotask(updateCaret)
                  }}
                  onSelect={updateCaret}
                  onClick={updateCaret}
                  onKeyUp={updateCaret}
                  onPaste={handlePaste}
                  placeholder="Send a message…"
                  rows={1}
                  autoFocus
                  className="custom-scrollbar relative z-10 min-h-[40px] max-h-[50vh] w-full resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent dark:bg-transparent p-0 font-mono text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-sm"
                  onKeyDown={e => {
                    // Mention popover keyboard intercepts (checked first —
                    // an `@` mid-line is never also a slash command).
                    if (mentionOpen) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        mentionHandleRef.current?.moveDown()
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        mentionHandleRef.current?.moveUp()
                        return
                      }
                      if (
                        e.key === 'Enter' &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault()
                        mentionHandleRef.current?.selectCurrent()
                        return
                      }
                      if (e.key === 'Tab') {
                        e.preventDefault()
                        mentionHandleRef.current?.selectCurrent()
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        // Don't bubble to SessionChatModal's window listener —
                        // we just want to dismiss the popover, not the modal.
                        e.nativeEvent.stopImmediatePropagation()
                        // Unlike the slash popover, dismiss preserves the
                        // textarea content; the user may want to keep their
                        // partial `@foo` as literal text.
                        setMentionDismissed(true)
                        return
                      }
                    }
                    // Slash popover keyboard intercepts. While the popover
                    // is open the textarea owns focus, so we forward
                    // Up/Down/Enter/Tab/Esc to the popover handle before
                    // any default textarea behavior (newline, caret nav).
                    if (slashOpen) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        slashHandleRef.current?.moveDown()
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        slashHandleRef.current?.moveUp()
                        return
                      }
                      if (
                        e.key === 'Enter' &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault()
                        slashHandleRef.current?.selectCurrent()
                        return
                      }
                      if (e.key === 'Tab') {
                        e.preventDefault()
                        slashHandleRef.current?.selectCurrent()
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        // Prevent SessionChatModal's window-level Escape
                        // listener from also firing and closing the modal.
                        e.nativeEvent.stopImmediatePropagation()
                        // Closing is owned by the parent: clearing the `/`
                        // makes the regex no longer match, which collapses
                        // the popover.
                        onChange('')
                        return
                      }
                    }
                    // Enter = submit, Shift+Enter = newline. Matches the
                    // existing chat shortcut.
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault()
                      handleSubmit(e)
                    }
                  }}
                />
                <AcpSlashPopover
                  open={slashOpen}
                  onOpenChange={next => {
                    // The popover only requests close (next === false) on
                    // outside click / Escape inside its own content. Mirror
                    // the textarea Escape path: clear the slash so our
                    // regex stops matching.
                    if (!next) onChange('')
                  }}
                  commands={availableCommands}
                  searchQuery={slashQuery}
                  anchorRef={textareaWrapRef}
                  onSelectCommand={handleSlashSelect}
                  handleRef={slashHandleRef}
                />
                <AcpMentionPopover
                  open={mentionOpen}
                  onOpenChange={next => {
                    // Outside-click / Escape inside the popover. Same
                    // semantics as the textarea Escape branch: dismiss
                    // without modifying the user's draft.
                    if (!next) setMentionDismissed(true)
                  }}
                  worktreePath={worktreePath}
                  searchQuery={mentionMatch?.query ?? ''}
                  anchorRef={textareaWrapRef}
                  onSelectPath={handleMentionSelect}
                  handleRef={mentionHandleRef}
                />
              </div>
            </div>

            {/* Bottom toolbar: model/mode/thought-level group (left) + Send/Cancel
                (right). Pickers are joined with `h-4 w-px bg-border/50`
                vertical dividers — same visual treatment as the non-ACP
                composer in `ChatToolbar.tsx`. Each trigger is pinned to
                a fixed width so swapping the selection doesn't make the
                row jump. Mode and Thought level use a borderless "ghost"
                style (override via `triggerClassName`) so the bordered Model
                pill stands out as the primary control. */}
            <div className="@container flex items-center justify-between gap-2 px-4 py-2 md:px-6">
              <div className="-ml-3 inline-flex min-w-0 flex-nowrap items-center overflow-x-auto">
                {/* Hidden file input for image attachment */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  tabIndex={-1}
                  className="sr-only"
                  onChange={e => {
                    Array.from(e.target.files ?? []).forEach(addImageFile)
                    e.target.value = ''
                  }}
                />
                <Popover open={plusOpen} onOpenChange={setPlusOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Add attachment"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="top" className="w-48 p-1">
                    {promptImageSupported ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPlusOpen(false)
                          // Defer click so popover finishes closing first.
                          setTimeout(() => fileInputRef.current?.click(), 0)
                        }}
                        className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
                      >
                        <Image className="h-4 w-4 text-muted-foreground" />
                        Attach image
                      </button>
                    ) : (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        No attachments supported by this agent.
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
                <AcpListPicker
                  available={availableModels}
                  currentId={currentModelId}
                  onChange={onModelChange}
                  disabled={modelChangeDisabled}
                  triggerClassName="border-0 bg-transparent gap-1.5"
                  onClose={focusTextarea}
                  ariaLabel="Choose model"
                  tooltipLabel="Model"
                  searchPlaceholder="Search models…"
                  emptyText="No models found."
                  fallbackLabel="Select model"
                  shortcut={{
                    display: '⌥ P',
                    match: e =>
                      e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyP',
                  }}
                />
                {availableModes.length > 0 ? (
                  <span aria-hidden className="mx-1 h-4 w-px bg-border/50" />
                ) : null}
                <AcpListPicker
                  available={availableModes}
                  currentId={currentModeId}
                  onChange={onModeChange}
                  disabled={modeChangeDisabled}
                  triggerClassName="border-0 bg-transparent gap-1.5"
                  onClose={focusTextarea}
                  ariaLabel="Choose mode"
                  tooltipLabel="Mode"
                  searchPlaceholder="Search modes…"
                  emptyText="No modes found."
                  fallbackLabel="Select mode"
                  // Mode binding is owned by Composer (Shift+Tab hold-to-cycle);
                  // shortcut is display-only here.
                  shortcut={{ display: '⇧ ⇥' }}
                  open={modePickerOpen}
                  onOpenChange={setModePickerOpen}
                />
                {availableThoughtLevels.length > 0 ? (
                  <span aria-hidden className="mx-1 h-4 w-px bg-border/50" />
                ) : null}
                <AcpListPicker
                  available={availableThoughtLevels}
                  currentId={currentThoughtLevelId}
                  onChange={onThoughtLevelChange}
                  disabled={thoughtLevelChangeDisabled}
                  triggerClassName="border-0 bg-transparent gap-1.5"
                  onClose={focusTextarea}
                  ariaLabel="Choose thought level"
                  tooltipLabel="Thought level"
                  searchPlaceholder="Search thought levels…"
                  emptyText="No thought levels found."
                  fallbackLabel="Select thought level"
                  shortcut={{
                    display: '⌘ E',
                    match: e =>
                      (e.metaKey || e.ctrlKey) &&
                      !e.altKey &&
                      !e.shiftKey &&
                      e.code === 'KeyE',
                  }}
                />
                {sessionLoadingLabel ? (
                  <span
                    aria-live="polite"
                    className="ml-2 inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {sessionLoadingLabel}
                  </span>
                ) : null}
              </div>
              <SendButton
                isSending={sending}
                canSend={value.trim().length > 0 && !sending && !disabled}
                cancelDisabled={!canCancel}
                onCancel={onCancel}
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

/**
 * Fully rounded send/stop icon button. Mirrors the visual treatment used
 * by chat composers (round, primary fill, single icon). When sending,
 * shows a stop icon and routes clicks to `onCancel`; otherwise submits
 * the parent form.
 */
function SendButton({
  isSending,
  canSend,
  cancelDisabled,
  onCancel,
}: {
  isSending: boolean
  canSend: boolean
  cancelDisabled: boolean
  onCancel: () => void
}) {
  if (isSending) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={cancelDisabled}
            onClick={onCancel}
            aria-label="Stop"
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{cancelDisabled ? 'Stopping…' : 'Stop'}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send"
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50',
            canSend
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground'
          )}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Send (Enter)</TooltipContent>
    </Tooltip>
  )
}

/**
 * Compact, right-aligned status strip riding above the composer textarea.
 * Shows the running chat cost and the current context utilization as a
 * percentage (only when both `size` and `used` are known). Renders
 * nothing when no usage has been reported — keeps the composer clean
 * for fresh sessions.
 */

function AcpBanner({
  sessionId,
  acpSessionId,
}: {
  sessionId: string
  acpSessionId?: string
}) {
  return (
    <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
      <FlaskConical className="h-3.5 w-3.5" />
      <span>Experimental — ACP Labs</span>
      <span className="ml-auto select-text font-mono text-[10px] text-amber-700/70 dark:text-amber-300/70">
        jean:{sessionId.slice(0, 8)} · acp:{acpSessionId?.slice(0, 8) ?? 'N/A'}
      </span>
    </div>
  )
}

/**
 * Pull `stopReason` out of the `session/prompt` mutation result. Spec
 * guarantees the field is present and one of the known stop reasons,
 * but we treat unknown shapes/strings as "missing" so a malformed agent
 * doesn't blow up the finalize path. Returns `undefined` when absent
 * so the UI footer can suppress the normal `end_turn` case via a
 * separate check.
 */
function parseStopReason(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const obj = data as Record<string, unknown>
  const reason = obj.stopReason
  if (typeof reason !== 'string' || !reason) return undefined
  return reason
}
