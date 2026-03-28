import { useEffect } from 'react'
import { listen, useWsConnectionStatus } from '@/lib/transport'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { chatQueryKeys, persistEnqueue } from '@/services/chat'
import { isTauri, saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import type { Project, Worktree } from '@/types/projects'
import { preferencesQueryKeys } from '@/services/preferences'
import {
  resolveMagicPromptProvider,
  type AppPreferences,
  type NotificationSound,
} from '@/types/preferences'
import { triggerImmediateGitPoll } from '@/services/git-status'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { playNotificationSound } from '@/lib/sounds'
import { findPlanFilePath } from '@/components/chat/tool-call-utils'
import { generateId } from '@/lib/uuid'
import {
  markBackendPersisting,
  clearBackendPersisting,
} from '@/lib/backend-persist-guard'
import type {
  ChunkEvent,
  ToolUseEvent,
  ToolBlockEvent,
  ToolResultEvent,
  DoneEvent,
  ErrorEvent,
  CancelledEvent,
  ThinkingEvent,
  PermissionDeniedEvent,
  CompactingEvent,
  CompactedEvent,
  Session,
  SessionDigest,
  WorktreeSessions,
  SaveContextResponse,
} from '@/types/chat'
import {
  applySessionSettingToSession,
  type SessionSettingKey,
} from '@/components/chat/hooks/session-setting-sync'

interface UseStreamingEventsParams {
  queryClient: QueryClient
}

/**
 * Upsert an optimistic assistant message into the session's message list.
 * If the last message is already an assistant message (e.g. from a cancelled run),
 * replace it instead of appending — prevents duplicate assistant messages when
 * the user cancels and resends.
 */
function upsertAssistantMessage(
  messages: Session['messages'],
  newMsg: Session['messages'][number]
): Session['messages'] {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    // Replace the trailing assistant message
    const updated = [...messages]
    updated[updated.length - 1] = newMsg
    return updated
  }
  return [...messages, newMsg]
}

/**
 * Look up project/worktree/session names from query cache for display in toasts.
 * Returns a formatted label like "project / worktree / session" with graceful fallback.
 */
function lookupSessionLabel(
  queryClient: QueryClient,
  sessionId: string,
  worktreeId: string
): string {
  let projectName: string | undefined
  let worktreeName: string | undefined
  let sessionName: string | undefined

  // Look up session name from sessions cache
  const sessionsData = queryClient.getQueriesData<WorktreeSessions>({
    queryKey: ['chat', 'sessions'],
  })
  for (const [, data] of sessionsData) {
    const match = data?.sessions?.find(s => s.id === sessionId)
    if (match) {
      sessionName = match.name
      break
    }
  }

  // Look up worktree name and project name from worktrees cache
  const worktreesData = queryClient.getQueriesData<Worktree[]>({
    queryKey: [...projectsQueryKeys.all, 'worktrees'],
  })
  for (const [, worktrees] of worktreesData) {
    const match = worktrees?.find(w => w.id === worktreeId)
    if (match) {
      worktreeName = match.name
      // Look up project name
      const projects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      projectName = projects?.find(p => p.id === match.project_id)?.name
      break
    }
  }

  const parts = [projectName, worktreeName, sessionName].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : ''
}

/**
 * Look up worktree path and project display name from query cache for auto-save context.
 */
function findWorktreeForAutoSave(
  queryClient: QueryClient,
  worktreeId: string
): { path: string; projectName: string } | null {
  const worktreesData = queryClient.getQueriesData<Worktree[]>({
    queryKey: [...projectsQueryKeys.all, 'worktrees'],
  })
  for (const [, worktrees] of worktreesData) {
    const wt = worktrees?.find(w => w.id === worktreeId)
    if (wt) {
      // Resolve project display name (e.g., "royal-camel") instead of worktree name (e.g., "main")
      const projects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const projectName =
        projects?.find(p => p.id === wt.project_id)?.name ?? wt.name
      return { path: wt.path, projectName }
    }
  }
  return null
}

/**
 * Auto-save context after session completion (fire-and-forget).
 * Reuses the same `generate_context_from_session` command as manual save.
 * Silent: no toasts, errors only logged to console.
 */
async function autoSaveContext(params: {
  sessionId: string
  worktreeId: string
  worktreePath: string
  projectName: string
  preferences: AppPreferences | undefined
  queryClient: QueryClient
}) {
  try {
    await invoke<SaveContextResponse>('generate_context_from_session', {
      worktreePath: params.worktreePath,
      worktreeId: params.worktreeId,
      sourceSessionId: params.sessionId,
      projectName: params.projectName,
      customPrompt: params.preferences?.magic_prompts?.context_summary,
      model: params.preferences?.magic_prompt_models?.context_summary_model,
      customProfileName: resolveMagicPromptProvider(
        params.preferences?.magic_prompt_providers,
        'context_summary_provider',
        params.preferences?.default_provider
      ),
      reasoningEffort:
        params.preferences?.magic_prompt_efforts?.context_summary_effort ??
        null,
    })
    // Silently invalidate cache — no toast for auto-save
    params.queryClient.invalidateQueries({ queryKey: ['session-context'] })
  } catch (err) {
    console.warn('[AutoSave] Failed to auto-save context:', err)
  }
}

/**
 * Hook that sets up global Tauri event listeners for streaming events from Rust.
 * Events include session_id for routing to the correct session.
 *
 * Handles: chat:chunk, chat:tool_use, chat:tool_block, chat:thinking,
 * chat:tool_result, chat:permission_denied, chat:done, chat:error,
 * chat:cancelled, chat:compacted
 */
export default function useStreamingEvents({
  queryClient,
}: UseStreamingEventsParams): void {
  // Re-run effect when WS connects so listeners are registered in web mode
  const wsConnected = useWsConnectionStatus()

  useEffect(() => {
    if (!isTauri()) return

    const {
      appendStreamingContent,
      addToolCall,
      updateToolCallOutput,
      addTextBlock,
      addToolBlock,
      addThinkingBlock,
      addSendingSession,
    } = useChatStore.getState()

    // Sync sending state across clients (web <-> native)
    const unlistenSending = listen<{
      session_id: string
      worktree_id: string
      user_message: string
    }>('chat:sending', event => {
      const { session_id, worktree_id: wtId, user_message } = event.payload
      // Check if THIS client initiated the send (sender calls addSendingSession
      // before sendMessage.mutate, so it's already in sendingSessionIds).
      const isSender = !!useChatStore.getState().sendingSessionIds[session_id]
      addSendingSession(session_id)
      // Only invalidate for non-sender clients. The sender already has correct
      // optimistic state; refetching can overwrite it with stale disk data
      // (especially on WebSocket where dispatch is concurrent).
      if (!isSender) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(wtId),
        })
      }
      // Add the user message to the session cache so cross-client viewers
      // see it immediately. Skip if this client already has the message
      // (the sender added it via onMutate optimistic update).
      if (user_message) {
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(session_id),
          old => {
            if (!old) return old
            const lastMsg = old.messages.at(-1)
            // Skip if the last message already matches (sender's optimistic update)
            if (lastMsg?.role === 'user' && lastMsg.content === user_message) {
              return old
            }
            return {
              ...old,
              messages: [
                ...old.messages,
                {
                  id: `sending-${session_id}-${Date.now()}`,
                  session_id,
                  role: 'user' as const,
                  content: user_message,
                  timestamp: Math.floor(Date.now() / 1000),
                  tool_calls: [],
                },
              ],
            }
          }
        )
      }
    })

    // Buffer chunks and flush on animation frames to avoid per-chunk re-renders.
    // Codex app-server sends very frequent deltas; without batching, each delta
    // triggers 2 store mutations + full StreamingMessage re-render.
    const chunkBuffer: Record<string, string> = {}
    let chunkRafId: number | null = null

    function flushChunkBuffer() {
      chunkRafId = null
      for (const [sid, buffered] of Object.entries(chunkBuffer)) {
        appendStreamingContent(sid, buffered)
        addTextBlock(sid, buffered)
      }
      // Clear buffer (mutate in place for perf)
      for (const key of Object.keys(chunkBuffer)) {
        delete chunkBuffer[key]
      }
    }

    const unlistenChunk = listen<ChunkEvent>('chat:chunk', event => {
      const { session_id, content } = event.payload
      // Guard: drop stale chunks for sessions already cancelled/completed.
      // Without this, late events re-add the session to sendingSessionIds
      // after cancelSession() cleared it, causing the response to "still arrive".
      const currentState = useChatStore.getState()
      if (
        currentState.reviewingSessions[session_id] &&
        !currentState.sendingSessionIds[session_id]
      ) {
        return
      }
      // Ensure session is marked as sending (recovers state after reconnect/refresh)
      addSendingSession(session_id)
      // Accumulate into buffer
      chunkBuffer[session_id] = (chunkBuffer[session_id] ?? '') + content
      // Schedule flush on next animation frame (coalesces all chunks in this frame)
      if (chunkRafId === null) {
        chunkRafId = requestAnimationFrame(flushChunkBuffer)
      }
    })

    const unlistenToolUse = listen<ToolUseEvent>('chat:tool_use', event => {
      const { session_id, id, name, input, parent_tool_use_id } = event.payload
      addToolCall(session_id, { id, name, input, parent_tool_use_id })

      // Auto-switch Jean's mode when Claude enters plan mode
      if (name === 'EnterPlanMode') {
        useChatStore.getState().setExecutionMode(session_id, 'plan')
      }
    })

    const unlistenToolBlock = listen<ToolBlockEvent>(
      'chat:tool_block',
      event => {
        const { session_id, tool_call_id } = event.payload
        addToolBlock(session_id, tool_call_id)
      }
    )

    // Buffer thinking deltas and flush on animation frames (same pattern as chunks).
    // OpenCode/Codex stream thinking as frequent small deltas; without batching,
    // each delta triggers a store mutation + re-render.
    const thinkingBuffer: Record<string, string> = {}
    let thinkingRafId: number | null = null

    function flushThinkingBuffer() {
      thinkingRafId = null
      for (const [sid, buffered] of Object.entries(thinkingBuffer)) {
        addThinkingBlock(sid, buffered)
      }
      for (const key of Object.keys(thinkingBuffer)) {
        delete thinkingBuffer[key]
      }
    }

    const unlistenThinking = listen<ThinkingEvent>('chat:thinking', event => {
      const { session_id, content } = event.payload
      thinkingBuffer[session_id] = (thinkingBuffer[session_id] ?? '') + content
      if (thinkingRafId === null) {
        thinkingRafId = requestAnimationFrame(flushThinkingBuffer)
      }
    })

    // Handle tool result events (tool execution output)
    const unlistenToolResult = listen<ToolResultEvent>(
      'chat:tool_result',
      event => {
        const { session_id, tool_use_id, output } = event.payload

        // Check if this tool was in pending denials - if so, it ran anyway
        // (e.g., yolo mode, or tool was pre-approved via allowedTools)
        const { pendingPermissionDenials, setPendingDenials, activeToolCalls } =
          useChatStore.getState()
        const denials = pendingPermissionDenials[session_id]
        if (denials?.some(d => d.tool_use_id === tool_use_id)) {
          // Remove this tool from pending denials since it already ran
          const remainingDenials = denials.filter(
            d => d.tool_use_id !== tool_use_id
          )
          setPendingDenials(session_id, remainingDenials)
        }

        // Look up the tool call to get its name
        const toolCalls = activeToolCalls[session_id] ?? []
        const toolCall = toolCalls.find(tc => tc.id === tool_use_id)

        // For Read tools, store empty placeholder instead of full content (can be large)
        updateToolCallOutput(
          session_id,
          tool_use_id,
          toolCall?.name === 'Read' ? '' : output
        )
      }
    )

    // Handle permission denied events (tools that require approval)
    const unlistenPermissionDenied = listen<PermissionDeniedEvent>(
      'chat:permission_denied',
      event => {
        const { session_id, denials } = event.payload
        const {
          setPendingDenials,
          lastSentMessages,
          setDeniedMessageContext,
          executionModes,
          thinkingLevels,
          selectedModels,
        } = useChatStore.getState()

        // Store the denials for the approval UI
        setPendingDenials(session_id, denials)

        // Store the message context for re-send
        const originalMessage = lastSentMessages[session_id]
        if (originalMessage) {
          setDeniedMessageContext(session_id, {
            message: originalMessage,
            model: selectedModels[session_id],
            executionMode: executionModes[session_id] ?? 'plan',
            thinkingLevel: thinkingLevels[session_id] ?? 'off',
          })
        }
      }
    )

    const unlistenDone = listen<DoneEvent>('chat:done', event => {
      const sessionId = event.payload.session_id
      const worktreeId = event.payload.worktree_id

      // Flush any buffered chunks/thinking so streaming state is up to date
      if (chunkRafId !== null) {
        cancelAnimationFrame(chunkRafId)
        flushChunkBuffer()
      }
      if (thinkingRafId !== null) {
        cancelAnimationFrame(thinkingRafId)
        flushThinkingBuffer()
      }

      console.log(`[Done] chat:done received session=${sessionId}`, {
        currentSending: Object.keys(useChatStore.getState().sendingSessionIds),
      })

      const {
        streamingContents,
        activeToolCalls,
        streamingContentBlocks,
        setError,
        clearLastSentMessage,
        isQuestionAnswered,
        completeSession,
        pauseSession,
        activeWorktreeId,
        activeSessionIds,
        markSessionNeedsDigest,
      } = useChatStore.getState()

      // Check if this session is currently being viewed
      // Only skip digest if BOTH the worktree AND session are active (user is looking at it)
      const isActiveWorktree = worktreeId === activeWorktreeId
      const isActiveSession = activeSessionIds[worktreeId] === sessionId
      const isViewingInFullView = isActiveWorktree && isActiveSession

      // Also check if viewing in modal (modal doesn't change activeWorktreeId)
      const { sessionChatModalOpen, sessionChatModalWorktreeId } =
        useUIStore.getState()
      const isViewingInModal =
        sessionChatModalOpen &&
        sessionChatModalWorktreeId === worktreeId &&
        isActiveSession

      const isCurrentlyViewing = isViewingInFullView || isViewingInModal

      // If user is currently viewing this session, bump last_opened_at so it
      // doesn't appear as "unread" (updated_at will be newer after the run ends).
      // Also auto-mark user-initiated sessions (e.g. Clear Context & YOLO) as opened.
      const { userInitiatedSessionIds, removeUserInitiatedSession } =
        useChatStore.getState()
      const isUserInitiated = !!userInitiatedSessionIds[sessionId]
      if (isCurrentlyViewing || isUserInitiated) {
        if (isUserInitiated) removeUserInitiatedSession(sessionId)
        invoke('set_session_last_opened', { sessionId })
          .then(() => window.dispatchEvent(new CustomEvent('session-opened')))
          .catch(() => undefined)
      }

      // Check if session recap is enabled in preferences
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

      // Only generate digest if status is CHANGING to review (not already reviewing)
      // This prevents generating digests for all restored sessions on app startup
      const wasAlreadyReviewing =
        useChatStore.getState().reviewingSessions[sessionId] ?? false

      if (
        !isCurrentlyViewing &&
        !isUserInitiated &&
        sessionRecapEnabled &&
        !wasAlreadyReviewing
      ) {
        // Mark for digest and generate it in the background immediately
        markSessionNeedsDigest(sessionId)

        // Generate digest in background (fire and forget)
        invoke<SessionDigest>('generate_session_digest', { sessionId })
          .then(digest => {
            useChatStore.getState().setSessionDigest(sessionId, digest)
            // Persist digest to disk so it survives app reload
            invoke('update_session_digest', { sessionId, digest }).catch(
              err => {
                console.error(
                  '[useStreamingEvents] Failed to persist digest:',
                  err
                )
              }
            )
          })
          .catch(err => {
            console.error(
              '[useStreamingEvents] Failed to generate digest:',
              err
            )
          })
      }

      // Capture streaming state to local variables BEFORE clearing
      // This ensures we have the data for the optimistic message
      const content = streamingContents[sessionId]
      const toolCalls = activeToolCalls[sessionId]
      const contentBlocks = streamingContentBlocks[sessionId]

      if (!content && !toolCalls?.length) {
        console.warn(
          `[chat:done] No streaming content for session=${sessionId}. ` +
            `Optimistic message will be empty; messages will load from JSONL on refetch.`
        )
      }

      // Codex has no native plan approval flow — skip synthetic ExitPlanMode injection.
      // Codex plan completions fall through to the "no blocking tools" path → status = "review".
      const effectiveToolCalls = toolCalls
      const effectiveContentBlocks = contentBlocks

      // Check for unanswered blocking tools BEFORE clearing state
      // This determines whether to show "waiting" status in the UI
      const hasUnansweredBlockingTool = effectiveToolCalls?.some(
        tc =>
          (isAskUserQuestion(tc) || isExitPlanMode(tc)) &&
          !isQuestionAnswered(sessionId, tc.id)
      )

      // Clear compacting state (safety net in case chat:compacted was missed)
      useChatStore.getState().setCompacting(sessionId, false)

      // CRITICAL: Clear streaming/sending state BEFORE adding optimistic message
      // This prevents double-render where both StreamingMessage and persisted message show
      // React Query's setQueryData triggers subscribers immediately, so isSending must be
      // false before the new message appears in the cache
      setError(sessionId, null)
      clearLastSentMessage(sessionId)
      useChatStore.getState().clearLastSentAttachments(sessionId)

      // Completion state is now persisted by the backend (single authoritative write).
      // Frontend only updates in-memory state (Zustand + TanStack Query caches).
      // Guard: prevent useImmediateSessionStateSave from racing with backend write.
      markBackendPersisting(sessionId)
      setTimeout(() => clearBackendPersisting(sessionId), 2000)

      if (hasUnansweredBlockingTool) {
        // YOLO mode auto-continue: automatically answer blocking tools and continue
        // without showing the question/plan UI. This prevents YOLO mode from getting
        // stuck when Claude asks questions or proposes plans.
        const executingMode = useChatStore.getState().executingModes[sessionId]
        if (executingMode === 'yolo') {
          console.log(
            `[chat:done] YOLO auto-continue: session=${sessionId}, auto-answering blocking tools`
          )

          // Mark all blocking tools as answered
          const {
            markQuestionAnswered,
            worktreePaths,
            selectedModels,
            effortLevels,
          } = useChatStore.getState()
          for (const tc of effectiveToolCalls ?? []) {
            if (
              (isAskUserQuestion(tc) || isExitPlanMode(tc)) &&
              !isQuestionAnswered(sessionId, tc.id)
            ) {
              markQuestionAnswered(sessionId, tc.id, [])
            }
          }

          // Add optimistic assistant message so the content is preserved in history
          if (
            content ||
            (effectiveToolCalls && effectiveToolCalls.length > 0)
          ) {
            queryClient.setQueryData<Session>(
              chatQueryKeys.session(sessionId),
              old => {
                if (!old) return old
                return {
                  ...old,
                  messages: upsertAssistantMessage(old.messages, {
                    id: generateId(),
                    session_id: sessionId,
                    role: 'assistant' as const,
                    content: content ?? '',
                    timestamp: Math.floor(Date.now() / 1000),
                    tool_calls: effectiveToolCalls ?? [],
                    content_blocks: effectiveContentBlocks ?? [],
                  }),
                }
              }
            )
          }

          // Queue a continuation message so the queue processor sends it
          // after the current send_chat_message completes
          const autoMessage =
            'Continue — make your best judgment and proceed autonomously.'
          const wtPath = worktreePaths[worktreeId]
          if (wtPath) {
            const queuedMsg = {
              id: generateId(),
              message: autoMessage,
              pendingImages: [] as never[],
              pendingFiles: [] as never[],
              pendingSkills: [] as never[],
              pendingTextFiles: [] as never[],
              model: selectedModels[sessionId] ?? 'sonnet',
              provider: null,
              executionMode: 'yolo' as const,
              thinkingLevel: 'off' as const,
              effortLevel: effortLevels[sessionId],
              queuedAt: Date.now(),
            }
            useChatStore.getState().enqueueMessage(sessionId, queuedMsg)
            persistEnqueue(worktreeId, wtPath, sessionId, queuedMsg)
          }

          // Complete session (clears sending state) — queue processor will pick up the auto-message
          completeSession(sessionId)

          // Skip the normal blocking tool handling below
        } else {
          // Check if there are queued messages AND only ExitPlanMode is blocking (not AskUserQuestion)
          const { messageQueues } = useChatStore.getState()
          const hasQueuedMessages = (messageQueues[sessionId]?.length ?? 0) > 0
          const isOnlyExitPlanMode =
            effectiveToolCalls?.every(
              tc =>
                !isAskUserQuestion(tc) || isQuestionAnswered(sessionId, tc.id)
            ) &&
            effectiveToolCalls?.some(
              tc => isExitPlanMode(tc) && !isQuestionAnswered(sessionId, tc.id)
            )

          // Add optimistic assistant message BEFORE clearing streaming state.
          // This ensures the plan/question is visible in MessageList
          // before StreamingMessage unmounts (isSending becomes false).
          if (
            content ||
            (effectiveToolCalls && effectiveToolCalls.length > 0)
          ) {
            const pendingIdKey = `__pendingMessageId_${sessionId}`
            const preGeneratedId = (
              window as unknown as Record<string, string>
            )[pendingIdKey]
            const messageId = preGeneratedId ?? generateId()
            if (preGeneratedId) {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
              delete (window as unknown as Record<string, string>)[pendingIdKey]
            }
            // Store the ID for downstream use (plan message persistence)
            ;(window as unknown as Record<string, string>)[pendingIdKey] =
              messageId

            queryClient.setQueryData<Session>(
              chatQueryKeys.session(sessionId),
              old => {
                if (!old) return old
                return {
                  ...old,
                  messages: upsertAssistantMessage(old.messages, {
                    id: messageId,
                    session_id: sessionId,
                    role: 'assistant' as const,
                    content: content ?? '',
                    timestamp: Math.floor(Date.now() / 1000),
                    tool_calls: effectiveToolCalls ?? [],
                    content_blocks: effectiveContentBlocks ?? [],
                  }),
                }
              }
            )
          }

          if (hasQueuedMessages && isOnlyExitPlanMode) {
            // Queued message takes priority over plan approval
            // Clear tool calls so approval UI doesn't show, let queue processor handle the queued message
            // Don't set waitingForInput(true) - this allows queue processor to send the queued message
            // Use completeSession to batch-clear (reviewing=true is fine, queue processor will override)
            completeSession(sessionId)
          } else {
            // Original behavior: show blocking tool UI and wait for user input
            // Keep tool calls and content blocks so UI shows question/plan
            // Batch-clear text content, executing mode, sending — set waiting state
            pauseSession(sessionId)

            // Persist plan file path and pending message ID for ExitPlanMode
            if (effectiveToolCalls) {
              const planPath = findPlanFilePath(effectiveToolCalls)
              if (planPath) {
                useChatStore.getState().setPlanFilePath(sessionId, planPath)
              }

              // Check if there's an ExitPlanMode tool call - if so, use the message ID
              // from the optimistic message (already added above) and persist it
              const hasExitPlanModeCall = effectiveToolCalls.some(tc =>
                isExitPlanMode(tc)
              )
              if (hasExitPlanModeCall) {
                const pendingIdKey = `__pendingMessageId_${sessionId}`
                const pendingMessageId =
                  (window as unknown as Record<string, string>)[pendingIdKey] ??
                  generateId()
                useChatStore
                  .getState()
                  .setPendingPlanMessageId(sessionId, pendingMessageId)

                // Persist plan file path + pending message ID (non-state metadata).
                // Completion state (waitingForInput) is persisted by the backend.
                const { worktreePaths } = useChatStore.getState()
                const wtPath = worktreePaths[worktreeId]
                if (wtPath) {
                  invoke('update_session_state', {
                    worktreeId,
                    worktreePath: wtPath,
                    sessionId,
                    planFilePath: planPath ?? undefined,
                    pendingPlanMessageId: pendingMessageId,
                  }).catch(err => {
                    console.error(
                      '[useStreamingEvents] Failed to persist plan metadata:',
                      err
                    )
                  })
                }
              }
              // Question waiting state is persisted by the backend — no frontend persist needed.
            }

            // Play waiting sound if not currently viewing this session
            if (!isCurrentlyViewing) {
              const waitingSound = (preferences?.waiting_sound ??
                'none') as NotificationSound
              playNotificationSound(waitingSound)
            }
          }
        } // end non-YOLO else
      } else if (event.payload.waiting_for_plan && !isCurrentlyViewing) {
        // Codex/Opencode plan-mode run completed with content — enter plan-waiting state.
        // The backend signals this via the waiting_for_plan field in chat:done.
        // Skip if user is currently viewing this session — go straight to review instead.

        // 1. Add optimistic assistant message to cache
        let planMessageId: string | undefined
        if (content || (effectiveToolCalls && effectiveToolCalls.length > 0)) {
          const pendingIdKey = `__pendingMessageId_${sessionId}`
          const preGeneratedId = (window as unknown as Record<string, string>)[
            pendingIdKey
          ]
          planMessageId = preGeneratedId ?? generateId()
          if (preGeneratedId) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete (window as unknown as Record<string, string>)[pendingIdKey]
          }

          queryClient.setQueryData<Session>(
            chatQueryKeys.session(sessionId),
            old => {
              if (!old) return old
              return {
                ...old,
                messages: upsertAssistantMessage(old.messages, {
                  id: planMessageId as string,
                  session_id: sessionId,
                  role: 'assistant' as const,
                  content: content ?? '',
                  timestamp: Math.floor(Date.now() / 1000),
                  tool_calls: effectiveToolCalls ?? [],
                  content_blocks: effectiveContentBlocks ?? [],
                }),
              }
            }
          )
        }

        // 2. Update caches with plan-waiting state
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old =>
            old
              ? {
                  ...old,
                  last_run_status: 'completed',
                  waiting_for_input: true,
                  waiting_for_input_type: 'plan' as const,
                  is_reviewing: false,
                  pending_plan_message_id: planMessageId,
                }
              : old
        )
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      last_run_status: 'completed' as const,
                      waiting_for_input: true,
                      waiting_for_input_type: 'plan' as const,
                      is_reviewing: false,
                      pending_plan_message_id: planMessageId,
                    }
                  : s
              ),
            }
          }
        )

        // 3. Transition to waiting state in Zustand
        pauseSession(sessionId)
        if (planMessageId) {
          useChatStore
            .getState()
            .setPendingPlanMessageId(sessionId, planMessageId)
        }

        // Plan-waiting state is persisted by the backend.
        // Persist plan metadata (pendingPlanMessageId) only.
        if (planMessageId) {
          const { worktreePaths: wtPaths2 } = useChatStore.getState()
          const wtPath2 = wtPaths2[worktreeId]
          if (wtPath2) {
            invoke('update_session_state', {
              worktreeId,
              worktreePath: wtPath2,
              sessionId,
              pendingPlanMessageId: planMessageId,
            }).catch(err =>
              console.error(
                '[useStreamingEvents] Failed to persist plan metadata:',
                err
              )
            )
          }
        }

        // Play waiting sound if not currently viewing this session
        if (!isCurrentlyViewing) {
          const waitingSound = (preferences?.waiting_sound ??
            'none') as NotificationSound
          playNotificationSound(waitingSound)
        }
      } else {
        // No blocking tools — add optimistic message FIRST, then batch-clear state.
        // This eliminates the flicker gap where neither streaming nor persisted content is visible.
        // The optimistic message lands in TanStack Query cache BEFORE isSending flips to false,
        // so MessageList already has the message when StreamingMessage unmounts.

        // 1. Add optimistic assistant message to cache
        if (content || (effectiveToolCalls && effectiveToolCalls.length > 0)) {
          const pendingIdKey = `__pendingMessageId_${sessionId}`
          const preGeneratedId = (window as unknown as Record<string, string>)[
            pendingIdKey
          ]
          const messageId = preGeneratedId ?? generateId()
          if (preGeneratedId) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete (window as unknown as Record<string, string>)[pendingIdKey]
          }

          queryClient.setQueryData<Session>(
            chatQueryKeys.session(sessionId),
            old => {
              if (!old) {
                console.warn(
                  `[chat:done] Session ${sessionId} not in cache — optimistic assistant message skipped. Will recover from JSONL on next fetch.`
                )
                return old
              }
              return {
                ...old,
                messages: upsertAssistantMessage(old.messages, {
                  id: messageId,
                  session_id: sessionId,
                  role: 'assistant' as const,
                  content: content ?? '',
                  timestamp: Math.floor(Date.now() / 1000),
                  tool_calls: effectiveToolCalls ?? [],
                  content_blocks: effectiveContentBlocks ?? [],
                }),
              }
            }
          )
        }

        // 2. Update last_run_status + session state in caches so UI reflects immediately.
        // CRITICAL: Include waiting_for_input/is_reviewing so useSessionStatePersistence's
        // load effect doesn't overwrite Zustand with stale cache values.
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old =>
            old
              ? {
                  ...old,
                  last_run_status: 'completed',
                  waiting_for_input: false,
                  is_reviewing: true,
                }
              : old
        )
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      last_run_status: 'completed' as const,
                      waiting_for_input: false,
                      is_reviewing: true,
                    }
                  : s
              ),
            }
          }
        )

        // 3. Batch-clear all streaming state in a single Zustand set() — one notification to subscribers
        console.log(`[Done] about to completeSession session=${sessionId}`, {
          currentSending: Object.keys(
            useChatStore.getState().sendingSessionIds
          ),
        })
        completeSession(sessionId)

        // Reviewing state is persisted by the backend — no frontend persist needed.

        // Play review sound if not currently viewing this session
        if (!isCurrentlyViewing) {
          const reviewSound = (preferences?.review_sound ??
            'none') as NotificationSound
          playNotificationSound(reviewSound)
        }

        // Auto-save context (fire-and-forget, no blocking)
        if (preferences?.auto_save_context !== false) {
          const sessionData = queryClient.getQueryData<Session>(
            chatQueryKeys.session(sessionId)
          )
          // +1 for the optimistic assistant message just added
          const messageCount = (sessionData?.messages?.length ?? 0) + 1

          if (messageCount >= 3) {
            const wtInfo = findWorktreeForAutoSave(queryClient, worktreeId)
            if (wtInfo) {
              autoSaveContext({
                sessionId,
                worktreeId,
                worktreePath: wtInfo.path,
                projectName: wtInfo.projectName,
                preferences,
                queryClient,
              })
            }
          }
        }
      }

      // Update last_run_status + waiting state for sessions with blocking tools.
      // CRITICAL: Include waiting_for_input so useSessionStatePersistence's load effect
      // doesn't overwrite Zustand with stale cache values when setQueryData triggers re-render.
      if (hasUnansweredBlockingTool) {
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old =>
            old
              ? {
                  ...old,
                  last_run_status: 'resumable',
                  waiting_for_input: true,
                }
              : old
        )
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      last_run_status: 'resumable' as const,
                      waiting_for_input: true,
                    }
                  : s
              ),
            }
          }
        )
      }

      // Detect PR_CREATED marker and save PR info (async, after main flow)
      // Format: PR_CREATED: #<number> <url>
      if (content) {
        const prMatch = content.match(
          /PR_CREATED:\s*#(\d+)\s+(https?:\/\/\S+)/i
        )
        const prNumberStr = prMatch?.[1]
        const prUrl = prMatch?.[2]
        if (prNumberStr && prUrl) {
          const prNumber = parseInt(prNumberStr, 10)
          // Save PR info to worktree (async, fire and forget)
          saveWorktreePr(worktreeId, prNumber, prUrl)
            .then(() => {
              // Invalidate worktree query to refresh PR link in UI
              queryClient.invalidateQueries({
                queryKey: [...projectsQueryKeys.all, 'worktree', worktreeId],
              })
            })
            .catch(err => {
              console.error('[ChatWindow] Failed to save PR info:', err)
            })
        }
      }

      // Trigger git status poll after prompt completes (Claude may have made changes)
      triggerImmediateGitPoll().catch(err =>
        console.error('[ChatWindow] Failed to trigger git poll:', err)
      )

      // Invalidate sessions list to update metadata.
      // Backend persists completion state and emits cache:invalidate, but we also
      // invalidate here for optimistic cache consistency on the local client.
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
      // Invalidate individual session so cross-client viewers get the
      // complete conversation (user message + assistant response).
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
    })

    // Handle errors from Claude CLI
    const unlistenError = listen<ErrorEvent>('chat:error', event => {
      const { session_id, error } = event.payload

      // Store error for inline display and restore input
      const {
        lastSentMessages,
        streamingContents,
        setInputDraft,
        clearLastSentMessage,
        setError,
        activeWorktreeId,
        activeSessionIds,
        markSessionNeedsDigest,
      } = useChatStore.getState()

      // Check if this session is currently being viewed
      // Look up the worktree from sessionWorktreeMap since ErrorEvent may not have it
      const sessionWorktreeId =
        useChatStore.getState().sessionWorktreeMap[session_id]
      const isActiveWorktree = sessionWorktreeId === activeWorktreeId
      const isActiveSession = sessionWorktreeId
        ? activeSessionIds[sessionWorktreeId] === session_id
        : false
      const isViewingInFullView = isActiveWorktree && isActiveSession

      // Also check if viewing in modal (modal doesn't change activeWorktreeId)
      const { sessionChatModalOpen, sessionChatModalWorktreeId } =
        useUIStore.getState()
      const isViewingInModal =
        sessionChatModalOpen &&
        sessionChatModalWorktreeId === sessionWorktreeId &&
        isActiveSession

      const isCurrentlyViewing = isViewingInFullView || isViewingInModal

      // If user is currently viewing this session, bump last_opened_at so it
      // doesn't appear as "unread" (updated_at will be newer after the run ends).
      // Also auto-mark user-initiated sessions (e.g. Clear Context & YOLO) as opened.
      const {
        userInitiatedSessionIds: uisErr,
        removeUserInitiatedSession: rusErr,
      } = useChatStore.getState()
      const isUserInitiatedErr = !!uisErr[session_id]
      if (isCurrentlyViewing || isUserInitiatedErr) {
        if (isUserInitiatedErr) rusErr(session_id)
        invoke('set_session_last_opened', { sessionId: session_id })
          .then(() => window.dispatchEvent(new CustomEvent('session-opened')))
          .catch(() => undefined)
      }

      // Check if session recap is enabled in preferences
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

      // Only generate digest if status is CHANGING to review (not already reviewing)
      const wasAlreadyReviewing =
        useChatStore.getState().reviewingSessions[session_id] ?? false

      if (
        !isCurrentlyViewing &&
        !isUserInitiatedErr &&
        sessionRecapEnabled &&
        !wasAlreadyReviewing
      ) {
        // Mark for digest and generate it in the background immediately
        markSessionNeedsDigest(session_id)

        invoke<SessionDigest>('generate_session_digest', {
          sessionId: session_id,
        })
          .then(digest => {
            useChatStore.getState().setSessionDigest(session_id, digest)
            // Persist digest to disk so it survives app reload
            invoke('update_session_digest', {
              sessionId: session_id,
              digest,
            }).catch(err => {
              console.error(
                '[useStreamingEvents] Failed to persist digest:',
                err
              )
            })
          })
          .catch(err => {
            console.error(
              '[useStreamingEvents] Failed to generate digest:',
              err
            )
          })
      }

      // Set error state for inline display
      setError(session_id, error)

      // Check if CLI produced streaming content BEFORE clearing state.
      // If content was streamed, the CLI ran — don't remove the user message
      // or rollback, as the conversation is persisted in JSONL on disk (#209).
      const hasStreamedContent = !!streamingContents[session_id]

      // Restore the input that failed so user can retry
      const lastMessage = lastSentMessages[session_id]
      if (lastMessage && !hasStreamedContent) {
        setInputDraft(session_id, lastMessage)
        clearLastSentMessage(session_id)

        // Remove the optimistic user message from query cache
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(session_id),
          old => {
            if (!old?.messages?.length) return old
            // Find last user message matching the failed content
            let lastUserIdx = -1
            for (let i = old.messages.length - 1; i >= 0; i--) {
              if (
                old.messages[i]?.role === 'user' &&
                old.messages[i]?.content === lastMessage
              ) {
                lastUserIdx = i
                break
              }
            }
            if (lastUserIdx === -1) return old
            const newMessages = [...old.messages]
            newMessages.splice(lastUserIdx, 1)
            return { ...old, messages: newMessages }
          }
        )
      } else if (lastMessage) {
        // Had streaming content — don't restore to input, just clear tracking
        clearLastSentMessage(session_id)
      }

      // Restore attachments that were cleared on send
      useChatStore.getState().restoreAttachments(session_id)

      // Optimistically update last_run_status BEFORE clearing state (same pattern as chat:done)
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(session_id),
        old => (old ? { ...old, last_run_status: 'crashed' as const } : old)
      )
      if (sessionWorktreeId) {
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(sessionWorktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === session_id
                  ? { ...s, last_run_status: 'crashed' as const }
                  : s
              ),
            }
          }
        )
      }

      // Batch-clear all streaming state in a single Zustand set()
      useChatStore.getState().failSession(session_id)

      // Invalidate sessions list to update last_run_status in tab bar
      if (sessionWorktreeId) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(sessionWorktreeId),
        })
      }
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
    })

    // Handle cancellation (user pressed Cmd+Option+Backspace / Ctrl+Alt+Backspace)
    // Preserves partial streaming content as an optimistic message (like chat:done)
    // Backend will also persist the partial response; mutation completion will update cache
    const unlistenCancelled = listen<CancelledEvent>(
      'chat:cancelled',
      event => {
        const {
          session_id,
          worktree_id: eventWorktreeId,
          undo_send,
          emitted_at_ms,
        } = event.payload

        // Flush any buffered chunks/thinking so streaming state is up to date
        if (chunkRafId !== null) {
          cancelAnimationFrame(chunkRafId)
          flushChunkBuffer()
        }
        if (thinkingRafId !== null) {
          cancelAnimationFrame(thinkingRafId)
          flushThinkingBuffer()
        }

        console.log(
          `[Cancelled] chat:cancelled received session=${session_id} undo_send=${undo_send}`,
          {
            currentSending: Object.keys(
              useChatStore.getState().sendingSessionIds
            ),
          }
        )

        // Capture streaming state BEFORE clearing (like chat:done does)
        const {
          sendStartedAt,
          streamingContents,
          activeToolCalls,
          streamingContentBlocks,
          activeWorktreeId,
          activeSessionIds,
          markSessionNeedsDigest,
        } = useChatStore.getState()
        const sendStarted = sendStartedAt[session_id] ?? 0
        if (sendStarted > emitted_at_ms) {
          console.warn(
            `[Cancelled] Ignoring stale cancel event for session=${session_id} emitted_at_ms=${emitted_at_ms} send_started_at=${sendStarted}`
          )
          return
        }
        const content = streamingContents[session_id]
        const toolCalls = activeToolCalls[session_id]
        const contentBlocks = streamingContentBlocks[session_id]

        // Check if this session is currently being viewed
        const sessionWorktreeId =
          useChatStore.getState().sessionWorktreeMap[session_id]
        const isActiveWorktree = sessionWorktreeId === activeWorktreeId
        const isActiveSession = sessionWorktreeId
          ? activeSessionIds[sessionWorktreeId] === session_id
          : false
        const isViewingInFullView = isActiveWorktree && isActiveSession

        // Also check if viewing in modal (modal doesn't change activeWorktreeId)
        const { sessionChatModalOpen, sessionChatModalWorktreeId } =
          useUIStore.getState()
        const isViewingInModal =
          sessionChatModalOpen &&
          sessionChatModalWorktreeId === sessionWorktreeId &&
          isActiveSession

        const isCurrentlyViewing = isViewingInFullView || isViewingInModal

        // If user is currently viewing this session, bump last_opened_at so it
        // doesn't appear as "unread" (updated_at will be newer after the run ends).
        // Also auto-mark user-initiated sessions (e.g. Clear Context & YOLO) as opened.
        const {
          userInitiatedSessionIds: uisCan,
          removeUserInitiatedSession: rusCan,
        } = useChatStore.getState()
        const isUserInitiatedCan = !!uisCan[session_id]
        if (isCurrentlyViewing || isUserInitiatedCan) {
          if (isUserInitiatedCan) rusCan(session_id)
          invoke('set_session_last_opened', { sessionId: session_id })
            .then(() => window.dispatchEvent(new CustomEvent('session-opened')))
            .catch(() => undefined)
        }

        // Check if session recap is enabled in preferences
        const preferences = queryClient.getQueryData<AppPreferences>(
          preferencesQueryKeys.preferences()
        )
        const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

        // Only generate digest if status is CHANGING to review (not already reviewing)
        const wasAlreadyReviewing =
          useChatStore.getState().reviewingSessions[session_id] ?? false

        if (
          !isCurrentlyViewing &&
          !isUserInitiatedCan &&
          sessionRecapEnabled &&
          !wasAlreadyReviewing
        ) {
          // Mark for digest and generate it in the background immediately
          markSessionNeedsDigest(session_id)

          invoke<SessionDigest>('generate_session_digest', {
            sessionId: session_id,
          })
            .then(digest => {
              useChatStore.getState().setSessionDigest(session_id, digest)
              // Persist digest to disk so it survives app reload
              invoke('update_session_digest', {
                sessionId: session_id,
                digest,
              }).catch(err => {
                console.error(
                  '[useStreamingEvents] Failed to persist digest:',
                  err
                )
              })
            })
            .catch(err => {
              console.error(
                '[useStreamingEvents] Failed to generate digest:',
                err
              )
            })
        }

        // Clear compacting state (safety net)
        useChatStore.getState().setCompacting(session_id, false)

        // Determine if we should restore message to input:
        // - undo_send from backend, OR
        // - No content streamed yet (cancelled before any response)
        // BUT: Don't restore if there are queued messages (user chose "Skip to Next")
        // Require substantial text (>50 chars) to count as meaningful partial response
        // when there are no tool calls — short filler like "Planning." isn't worth preserving
        const hasToolCalls = toolCalls && toolCalls.length > 0
        const hasSubstantialText = !!content && content.trim().length > 50
        const hasContent = hasToolCalls || hasSubstantialText
        const hasQueuedMessages =
          (useChatStore.getState().messageQueues[session_id] ?? []).length > 0
        const shouldRestoreMessage =
          !hasQueuedMessages && (undo_send || !hasContent)

        // Update TanStack Query cache FIRST (before clearing Zustand streaming state)
        // This ensures the persisted message exists before StreamingMessage unmounts

        // Optimistically update last_run_status so "restored session" indicator hides
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(session_id),
          old => (old ? { ...old, last_run_status: 'cancelled' } : old)
        )
        if (sessionWorktreeId) {
          queryClient.setQueryData<WorktreeSessions>(
            chatQueryKeys.sessions(sessionWorktreeId),
            old => {
              if (!old) return old
              return {
                ...old,
                sessions: old.sessions.map(s =>
                  s.id === session_id
                    ? { ...s, last_run_status: 'cancelled' as const }
                    : s
                ),
              }
            }
          )
        }

        if (shouldRestoreMessage) {
          // Restore message to input and optimistically undo the sent message.
          // This keeps cancel UX immediate while backend state catches up.
          const {
            lastSentMessages,
            inputDrafts,
            setInputDraft,
            clearLastSentMessage,
          } = useChatStore.getState()
          const lastMessage = lastSentMessages[session_id]
          const currentDraft = inputDrafts[session_id] ?? ''

          if (lastMessage) {
            // Only restore if input is empty (user hasn't typed new content)
            if (!currentDraft.trim()) {
              setInputDraft(session_id, lastMessage)
              // Restore any attachments that were sent with the message
              useChatStore.getState().restoreAttachments(session_id)
              toast.info('Message restored to input')
            } else {
              toast.info('Request cancelled')
              useChatStore.getState().clearLastSentAttachments(session_id)
            }
            clearLastSentMessage(session_id)

            queryClient.setQueryData<Session>(
              chatQueryKeys.session(session_id),
              old => {
                if (!old) return old
                const messages = [...old.messages]
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i]?.role === 'user') {
                    messages.splice(i, 1)
                    break
                  }
                }
                return { ...old, messages }
              }
            )
          } else {
            toast.info('Request cancelled')
            useChatStore.getState().clearLastSentAttachments(session_id)
          }
        } else {
          // Partial response exists — attachments were consumed, don't restore
          useChatStore.getState().clearLastSentAttachments(session_id)
          // Preserve partial response as optimistic message BEFORE clearing streaming state
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(session_id),
            old => {
              if (!old) return old
              return {
                ...old,
                messages: upsertAssistantMessage(old.messages, {
                  id: generateId(),
                  session_id,
                  role: 'assistant' as const,
                  content: content ?? '',
                  timestamp: Math.floor(Date.now() / 1000),
                  tool_calls: toolCalls ?? [],
                  content_blocks: contentBlocks ?? [],
                  cancelled: true,
                }),
              }
            }
          )
          // Persist partial content to JSONL so it survives app reload.
          // The backend command handler may not have finished writing yet
          // (e.g., OpenCode POST still in-flight).
          invoke('save_cancelled_message', {
            sessionId: session_id,
            worktreeId: sessionWorktreeId ?? eventWorktreeId,
            worktreePath: '',
            content: content ?? '',
            toolCalls: toolCalls ?? [],
            contentBlocks: contentBlocks ?? [],
          }).catch(err =>
            console.debug(
              '[useStreamingEvents] Failed to persist partial cancelled content:',
              err
            )
          )
          toast.info('Request cancelled')
        }

        // NOW batch-clear all streaming state in a single Zustand set()
        // This happens AFTER optimistic messages are in the cache, preventing flicker
        console.log(
          `[Cancelled] about to cancelSession session=${session_id} shouldRestore=${shouldRestoreMessage}`,
          {
            currentSending: Object.keys(
              useChatStore.getState().sendingSessionIds
            ),
          }
        )
        useChatStore.getState().cancelSession(session_id)

        // For restore path: override reviewing state based on whether messages remain
        if (shouldRestoreMessage) {
          const updatedSession = queryClient.getQueryData<Session>(
            chatQueryKeys.session(session_id)
          )
          if (!updatedSession || updatedSession.messages.length === 0) {
            useChatStore.getState().setSessionReviewing(session_id, false)
          }
        }

        // Persist cancel state to disk BEFORE invalidating queries
        // This prevents a race where invalidation refetches stale waiting_for_input: true from disk
        const resolvedWorktreeId = sessionWorktreeId || eventWorktreeId
        const { worktreePaths } = useChatStore.getState()
        const wtPath = resolvedWorktreeId
          ? worktreePaths[resolvedWorktreeId]
          : null

        const invalidateSessions = () => {
          if (resolvedWorktreeId) {
            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(resolvedWorktreeId),
            })
          }
          queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
        }

        if (resolvedWorktreeId && wtPath) {
          // Determine final reviewing state from the branch that just ran
          const isNowReviewing = shouldRestoreMessage
            ? (queryClient.getQueryData<Session>(
                chatQueryKeys.session(session_id)
              )?.messages.length ?? 0) > 0
            : true

          invoke('update_session_state', {
            worktreeId: resolvedWorktreeId,
            worktreePath: wtPath,
            sessionId: session_id,
            waitingForInput: false,
            waitingForInputType: null,
            isReviewing: isNowReviewing,
          })
            .catch(err =>
              console.debug(
                '[useStreamingEvents] Failed to persist cancel state:',
                err
              )
            )
            .finally(invalidateSessions)
        } else {
          invalidateSessions()
        }
      }
    )

    // Handle context compaction events
    const unlistenCompacting = listen<CompactingEvent>(
      'chat:compacting',
      event => {
        const { session_id, worktree_id } = event.payload
        const { setCompacting } = useChatStore.getState()
        setCompacting(session_id, true)
        const label = lookupSessionLabel(queryClient, session_id, worktree_id)
        toast.info(
          label ? `Compacting context: ${label}...` : 'Compacting context...'
        )
      }
    )

    const unlistenCompacted = listen<CompactedEvent>(
      'chat:compacted',
      event => {
        const { session_id, worktree_id, metadata } = event.payload
        const { setLastCompaction, setCompacting } = useChatStore.getState()
        setCompacting(session_id, false)
        setLastCompaction(session_id, metadata.trigger)

        const label = lookupSessionLabel(queryClient, session_id, worktree_id)
        const prefix = `Context ${metadata.trigger === 'auto' ? 'auto-' : ''}compacted`
        toast.info(label ? `${prefix}: ${label}` : prefix)
      }
    )

    // Handle session setting changes (backend, model, thinking level, execution mode)
    // Broadcast by other clients via broadcast_session_setting command
    const unlistenSettingChanged = listen<{
      session_id: string
      key: string
      value: string
    }>('session:setting-changed', event => {
      const { session_id, key, value } = event.payload
      const store = useChatStore.getState()
      switch (key as SessionSettingKey) {
        case 'backend':
          store.setSelectedBackend(
            session_id,
            value as 'claude' | 'codex' | 'opencode'
          )
          break
        case 'model':
          store.setSelectedModel(session_id, value)
          break
        case 'thinkingLevel':
          store.setThinkingLevel(
            session_id,
            value as 'off' | 'think' | 'megathink' | 'ultrathink'
          )
          break
        case 'executionMode':
          store.setExecutionMode(session_id, value as 'plan' | 'build' | 'yolo')
          break
        case 'waitingForInput':
          if (value === 'false') {
            store.setWaitingForInput(session_id, false)
            store.setPendingPlanMessageId(session_id, null)
          }
          break
      }

      queryClient.setQueryData<Session>(
        chatQueryKeys.session(session_id),
        old =>
          old
            ? applySessionSettingToSession(old, key as SessionSettingKey, value)
            : old
      )
      queryClient.invalidateQueries({
        queryKey: [...chatQueryKeys.all, 'sessions'],
      })
      queryClient.invalidateQueries({
        queryKey: ['all-sessions'],
      })
    })

    return () => {
      // Flush any buffered chunks/thinking before tearing down
      if (chunkRafId !== null) {
        cancelAnimationFrame(chunkRafId)
        flushChunkBuffer()
      }
      if (thinkingRafId !== null) {
        cancelAnimationFrame(thinkingRafId)
        flushThinkingBuffer()
      }
      unlistenSending.then(f => f())
      unlistenChunk.then(f => f())
      unlistenToolUse.then(f => f())
      unlistenToolBlock.then(f => f())
      unlistenThinking.then(f => f())
      unlistenToolResult.then(f => f())
      unlistenPermissionDenied.then(f => f())
      unlistenDone.then(f => f())
      unlistenError.then(f => f())
      unlistenCancelled.then(f => f())
      unlistenCompacting.then(f => f())
      unlistenCompacted.then(f => f())
      unlistenSettingChanged.then(f => f())
    }
  }, [queryClient, wsConnected])
}
