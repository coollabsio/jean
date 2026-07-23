import { useEffect } from 'react'
import { listen, useWsConnectionStatus } from '@/lib/transport'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { chatQueryKeys } from '@/services/chat'
import { isTauri, saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import type { Project, Worktree } from '@/types/projects'
import { preferencesQueryKeys } from '@/services/preferences'
import {
  resolveMagicPromptProvider,
  type AppPreferences,
  type CliBackend,
  type NotificationSound,
} from '@/types/preferences'
import { triggerImmediateGitPoll } from '@/services/git-status'
import {
  getCodexUserInputRequestId,
  isAskUserQuestion,
  isPlanToolCall,
  normalizeCodexQuestions,
  upsertCodexUserInputRequest,
} from '@/types/chat'
import { playNotificationSound } from '@/lib/sounds'
import { notifyIfBackground } from '@/lib/session-notifications'
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
  ToolEventEvent,
  DoneEvent,
  ErrorEvent,
  CancelledEvent,
  ThinkingEvent,
  PermissionDeniedEvent,
  CodexCommandApprovalRequestEvent,
  CodexPermissionRequestEvent,
  CodexUserInputRequestEvent,
  CodexMcpElicitationRequestEvent,
  CodexDynamicToolCallRequestEvent,
  CompactingEvent,
  CompactedEvent,
  Session,
  WorktreeSessions,
  SaveContextResponse,
  WakeupFiredEvent,
  WakeupScheduledEvent,
  WakeupCancelledEvent,
  PendingWakeupEntry,
  QueuedMessage,
  ContentBlock,
  ChatMessage,
} from '@/types/chat'
import { persistEnqueue, saveCancelledMessage } from '@/services/chat'
import {
  applySessionSettingToSession,
  type SessionSettingKey,
} from '@/components/chat/hooks/session-setting-sync'
import {
  hasMeaningfulAssistantPayload,
  shouldHydrateCompletedSessionFromBackend,
} from '@/components/chat/hooks/completion-hydration'
import {
  handleCliAuthError,
  isCliAuthError,
} from '@/lib/cli-auth'

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

function getTextContentFromBlocks(
  contentBlocks: Session['messages'][number]['content_blocks'] | undefined
): string {
  if (!contentBlocks?.length) return ''

  return contentBlocks
    .flatMap(block => (block.type === 'text' && block.text ? [block.text] : []))
    .join('')
}

const CLAUDE_COMPACTION_SUMMARY_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'

function isClaudeCompactionSummaryText(text: string): boolean {
  return text.trimStart().startsWith(CLAUDE_COMPACTION_SUMMARY_PREFIX)
}

function sanitizeCancelledContentBlocks(
  contentBlocks: ContentBlock[] | undefined
): ContentBlock[] | undefined {
  if (!contentBlocks) return undefined
  return contentBlocks.filter(
    block => block.type !== 'text' || !isClaudeCompactionSummaryText(block.text)
  )
}

async function hydrateCompletedSessionFromBackend(
  queryClient: QueryClient,
  sessionId: string,
  worktreeId: string
): Promise<Session | null> {
  const worktreePath = useChatStore.getState().worktreePaths[worktreeId]
  if (!worktreePath) {
    queryClient.invalidateQueries({
      queryKey: chatQueryKeys.session(sessionId),
    })
    return null
  }

  try {
    const session = await invoke<Session>('get_session', {
      sessionId,
      worktreeId,
      worktreePath,
    })
    queryClient.setQueryData(chatQueryKeys.session(sessionId), session)
    return session
  } catch (error) {
    console.error(
      '[useStreamingEvents] Failed to hydrate completed session from backend:',
      error
    )
    return null
  } finally {
    queryClient.invalidateQueries({
      queryKey: chatQueryKeys.session(sessionId),
    })
  }
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
      appendStreamingChunk,
      addToolCall,
      updateToolCallOutput,
      appendToolEvent,
      addToolBlock,
      addThinkingBlock,
      addUserInputBlock,
      addSendingSession,
    } = useChatStore.getState()
    const cancelledRunIds = new Map<string, Set<string>>()
    const cancelledUntaggedSessionIds = new Set<string>()

    // Fire a native OS banner (background-only) for a session lifecycle event,
    // gated by the desktop_notifications_enabled preference. Body = session name.
    const notifySession = (sessionId: string, title: string): void => {
      const prefs = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      if (prefs?.desktop_notifications_enabled === false) return
      const name = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )?.name
      notifyIfBackground(title, name)
    }

    // Hydrate ScheduleWakeup indicator store from backend so reloads do not
    // show historical tool_use blocks stuck in the "pending" spinner state.
    invoke<PendingWakeupEntry[]>('list_pending_wakeups')
      .then(entries => {
        const store = useChatStore.getState()
        for (const entry of entries) {
          store.setScheduledWakeup(entry.wakeup.tool_call_id, {
            ...entry.wakeup,
            status: 'pending',
          })
        }
      })
      .catch(err => {
        console.error('[useStreamingEvents] list_pending_wakeups failed:', err)
      })

    // Sync sending state across clients (web <-> native)
    const unlistenSending = listen<{
      session_id: string
      worktree_id: string
      user_message: string
    }>('chat:sending', event => {
      const { session_id, worktree_id: wtId, user_message } = event.payload
      cancelledUntaggedSessionIds.delete(session_id)
      // Check if THIS client initiated the send (sender calls addSendingSession
      // before sendMessage.mutate, so it's already in sendingSessionIds).
      const isSender = !!useChatStore.getState().sendingSessionIds[session_id]
      // A remote web/mobile client may start a new turn while this client still
      // has the previous turn parked as waiting/reviewing in Zustand. Clear
      // those stale terminal flags before marking the session as running.
      useChatStore.setState(state => {
        if (
          !state.waitingForInputSessionIds[session_id] &&
          !state.reviewingSessions[session_id]
        ) {
          return state
        }
        const { [session_id]: _waiting, ...waitingForInputSessionIds } =
          state.waitingForInputSessionIds
        const { [session_id]: _reviewing, ...reviewingSessions } =
          state.reviewingSessions
        return { waitingForInputSessionIds, reviewingSessions }
      })
      addSendingSession(session_id)
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(session_id),
        old =>
          old
            ? {
                ...old,
                waiting_for_input: false,
                waiting_for_input_type: null,
                is_reviewing: false,
                last_run_status: 'running',
              }
            : old
      )
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
    let chunkBuffer: Record<string, string> = {}
    let chunkRafId: number | null = null

    function flushChunkBuffer() {
      chunkRafId = null
      for (const [sid, buffered] of Object.entries(chunkBuffer)) {
        // Single atomic set() updates both streamingContents (string fallback,
        // load-bearing for resume/dedupe/error paths) and streamingContentBlocks
        // — one subscriber sweep per frame instead of two.
        appendStreamingChunk(sid, buffered)
      }
      chunkBuffer = {}
    }

    const unlistenChunk = listen<ChunkEvent>('chat:chunk', event => {
      const { session_id, content, run_id: eventRunId } = event.payload
      // Guard: drop stale chunks for sessions already cancelled/completed.
      // Without this, late events re-add the session to sendingSessionIds
      // after cancelSession() cleared it, causing the response to "still arrive".
      const currentState = useChatStore.getState()
      const cancelledRunsForSession = cancelledRunIds.get(session_id)
      if (eventRunId && cancelledRunsForSession?.has(eventRunId)) {
        return
      }
      if (!eventRunId && cancelledUntaggedSessionIds.has(session_id)) {
        return
      }
      if (
        currentState.reviewingSessions[session_id] &&
        !currentState.sendingSessionIds[session_id]
      ) {
        return
      }
      const replayFilteredContent =
        useChatStore
          .getState()
          .consumeStreamingReplayText(session_id, content) ?? ''
      if (!replayFilteredContent) return
      // Ensure session is marked as sending (recovers state after refresh)
      addSendingSession(session_id)
      // Accumulate into buffer
      chunkBuffer[session_id] =
        (chunkBuffer[session_id] ?? '') + replayFilteredContent
      // Schedule flush on next animation frame (coalesces all chunks in this frame)
      if (chunkRafId === null) {
        chunkRafId = requestAnimationFrame(flushChunkBuffer)
      }
    })

    const unlistenToolUse = listen<ToolUseEvent>('chat:tool_use', event => {
      const { session_id, id, name, input, parent_tool_use_id } = event.payload
      const toolCall = { id, name, input, parent_tool_use_id }
      addToolCall(session_id, toolCall)

      // Auto-switch Jean's mode when Claude enters plan mode
      if (name === 'EnterPlanMode') {
        useChatStore.getState().setExecutionMode(session_id, 'plan')
      }

      // Note: Do NOT pauseSession here for question tools.
      // For OpenCode, the HTTP POST is still in-flight (blocking until answered).
      // Pausing here would clear sendingSessionIds, unmounting StreamingMessage
      // before any persisted message exists — leaving the question UI with nowhere
      // to render. Instead, let StreamingMessage render the question inline via
      // buildTimeline(). When the user answers, the POST unblocks, chat:done fires,
      // and the normal completion flow handles pause/complete.
    })

    const unlistenToolBlock = listen<ToolBlockEvent>(
      'chat:tool_block',
      event => {
        const { session_id, tool_call_id } = event.payload
        if (
          useChatStore
            .getState()
            .consumeStreamingReplayToolBlock(session_id, tool_call_id)
        ) {
          return
        }
        addToolBlock(session_id, tool_call_id)
      }
    )

    // Buffer thinking deltas and flush on animation frames (same pattern as chunks).
    // OpenCode/Codex stream thinking as frequent small deltas; without batching,
    // each delta triggers a store mutation + re-render.
    let thinkingBuffer: Record<string, string> = {}
    let thinkingRafId: number | null = null

    function flushThinkingBuffer() {
      thinkingRafId = null
      for (const [sid, buffered] of Object.entries(thinkingBuffer)) {
        addThinkingBlock(sid, buffered)
      }
      thinkingBuffer = {}
    }

    const unlistenThinking = listen<ThinkingEvent>('chat:thinking', event => {
      const { session_id, content } = event.payload
      const replayFilteredContent =
        useChatStore
          .getState()
          .consumeStreamingReplayThinking(session_id, content) ?? ''
      if (!replayFilteredContent) return
      thinkingBuffer[session_id] =
        (thinkingBuffer[session_id] ?? '') + replayFilteredContent
      if (thinkingRafId === null) {
        thinkingRafId = requestAnimationFrame(flushThinkingBuffer)
      }
    })

    // User text injected into a running turn (Codex turn/steer) — render
    // inline in the streaming message as a user-style bubble.
    const unlistenSteered = listen<{
      session_id: string
      worktree_id: string
      text: string
    }>('chat:steered', event => {
      const { session_id, text } = event.payload
      if (
        useChatStore
          .getState()
          .consumeStreamingReplayUserInput(session_id, text)
      ) {
        return
      }
      addUserInputBlock(session_id, text)
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

        // For question tools, don't overwrite — we store JSON-encoded answer data
        // in the output at answer time (see useMessageHandlers handleQuestionAnswer)
        if (toolCall?.name === 'question' && toolCall?.output) return

        // For Monitor, notifications stream through chat:tool_event into
        // `events`. Writing .output here would render the same text again
        // in both the "Final output" block and the outer raw-output panel.
        if (toolCall?.name === 'Monitor') return

        // For Read tools, store empty placeholder instead of full content (can be large)
        updateToolCallOutput(
          session_id,
          tool_use_id,
          toolCall?.name === 'Read' ? '' : output
        )
      }
    )

    // Handle live tool events (Monitor notifications, status changes, etc.)
    const unlistenToolEvent = listen<ToolEventEvent>(
      'chat:tool_event',
      event => {
        const { session_id, tool_use_id, kind, payload, ts_ms } = event.payload
        appendToolEvent(session_id, tool_use_id, {
          kind,
          payload,
          ts_ms,
        })
      }
    )

    // Handle permission denied events (tools that require approval)
    const unlistenPermissionDenied = listen<PermissionDeniedEvent>(
      'chat:permission_denied',
      event => {
        const { session_id, worktree_id, denials } = event.payload
        const {
          setPendingDenials,
          lastSentMessages,
          setDeniedMessageContext,
          executionModes,
          thinkingLevels,
          selectedModels,
          worktreePaths,
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

        const worktreePath = worktreePaths[worktree_id]
        if (worktreePath) {
          invoke('update_session_state', {
            worktreeId: worktree_id,
            worktreePath,
            sessionId: session_id,
            waitingForInput: true,
            pendingPermissionDenials: denials,
          }).catch(err => {
            console.error(
              '[useStreamingEvents] Failed to persist Claude permission denial:',
              err
            )
          })
        }
      }
    )

    const persistCodexPendingState = (
      sessionId: string,
      worktreeId: string,
      updates: Record<string, unknown>
    ) => {
      const worktreePath = useChatStore.getState().worktreePaths[worktreeId]
      if (!worktreePath) return
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: true,
        ...updates,
      }).catch(err => {
        console.error(
          '[useStreamingEvents] Failed to persist Codex pending request:',
          err
        )
      })
    }

    const enqueueCodexMcpElicitation = (
      sessionId: string,
      worktreeId: string,
      request: CodexMcpElicitationRequestEvent['request']
    ) => {
      const { setPendingCodexMcpElicitationRequests, setWaitingForInput } =
        useChatStore.getState()
      const current =
        useChatStore.getState().pendingCodexMcpElicitationRequests[sessionId] ??
        []
      const next = [...current, request]
      setPendingCodexMcpElicitationRequests(sessionId, next)
      setWaitingForInput(sessionId, true)
      persistCodexPendingState(sessionId, worktreeId, {
        pendingCodexMcpElicitationRequests: next,
      })
    }

    const unlistenCodexPermissionRequest = listen<CodexPermissionRequestEvent>(
      'chat:codex_permission_request',
      event => {
        const { session_id, worktree_id, request } = event.payload
        const { setPendingCodexPermissionRequests, setWaitingForInput } =
          useChatStore.getState()
        const current =
          useChatStore.getState().pendingCodexPermissionRequests[session_id] ??
          []
        const next = [...current, request]
        setPendingCodexPermissionRequests(session_id, next)
        setWaitingForInput(session_id, true)
        notifySession(session_id, 'Needs your input')
        persistCodexPendingState(session_id, worktree_id, {
          pendingCodexPermissionRequests: next,
        })
      }
    )

    const unlistenCodexCommandApprovalRequest =
      listen<CodexCommandApprovalRequestEvent>(
        'chat:codex_command_approval_request',
        event => {
          const { session_id, worktree_id, request } = event.payload
          const { setPendingCodexCommandApprovalRequests, setWaitingForInput } =
            useChatStore.getState()
          const current =
            useChatStore.getState().pendingCodexCommandApprovalRequests[
              session_id
            ] ?? []
          const next = [...current, request]
          setPendingCodexCommandApprovalRequests(session_id, next)
          setWaitingForInput(session_id, true)
          notifySession(session_id, 'Needs your input')
          persistCodexPendingState(session_id, worktree_id, {
            pendingCodexCommandApprovalRequests: next,
          })
        }
      )

    const unlistenCodexUserInputRequest = listen<CodexUserInputRequestEvent>(
      'chat:codex_user_input_request',
      event => {
        const { session_id, worktree_id, request } = event.payload
        const {
          setPendingCodexUserInputRequests,
          setWaitingForInput,
          addToolCall,
          addToolBlock,
        } = useChatStore.getState()
        const current =
          useChatStore.getState().pendingCodexUserInputRequests[session_id] ??
          []
        const next = upsertCodexUserInputRequest(current, request)
        setPendingCodexUserInputRequests(session_id, next)
        setWaitingForInput(session_id, true)

        const questions = normalizeCodexQuestions(request.questions)

        const toolCall = {
          id: getCodexUserInputRequestId(request),
          name: 'AskUserQuestion',
          input: { questions },
        }
        addToolCall(session_id, toolCall)
        addToolBlock(session_id, toolCall.id)

        if (next === current) return

        notifySession(session_id, 'Needs your input')
        persistCodexPendingState(session_id, worktree_id, {
          pendingCodexUserInputRequests: next,
        })
      }
    )

    const unlistenCodexMcpElicitation = listen<CodexMcpElicitationRequestEvent>(
      'chat:codex_mcp_elicitation_request',
      event => {
        const { session_id, worktree_id, request } = event.payload
        const enabledMcpServers =
          useChatStore.getState().enabledMcpServers[session_id] ?? []

        if (enabledMcpServers.includes(request.server_name)) {
          invoke('respond_codex_mcp_elicitation', {
            sessionId: session_id,
            rpcId: request.rpc_id,
            action: 'accept',
          }).catch(err => {
            console.error(
              '[useStreamingEvents] Failed to auto-accept Codex MCP elicitation:',
              err
            )
            enqueueCodexMcpElicitation(session_id, worktree_id, request)
          })
          return
        }

        enqueueCodexMcpElicitation(session_id, worktree_id, request)
      }
    )

    const unlistenCodexDynamicToolCall =
      listen<CodexDynamicToolCallRequestEvent>(
        'chat:codex_dynamic_tool_call_request',
        event => {
          const { session_id, worktree_id, request } = event.payload
          const { setPendingCodexDynamicToolCallRequests, setWaitingForInput } =
            useChatStore.getState()
          const current =
            useChatStore.getState().pendingCodexDynamicToolCallRequests[
              session_id
            ] ?? []
          const next = [...current, request]
          setPendingCodexDynamicToolCallRequests(session_id, next)
          setWaitingForInput(session_id, true)
          notifySession(session_id, 'Needs your input')
          persistCodexPendingState(session_id, worktree_id, {
            pendingCodexDynamicToolCallRequests: next,
          })
        }
      )

    const unlistenCodexGoal = listen<{
      session_id: string
      worktree_id: string
      goal: string | null
    }>('chat:codex_goal', event => {
      const { session_id, goal } = event.payload
      useChatStore.getState().setCodexGoal(session_id, goal ?? null)
    })

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
      } = useChatStore.getState()

      // Check if this session is currently being viewed
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

      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )

      // Capture streaming state to local variables BEFORE clearing
      // This ensures we have the data for the optimistic message.
      // Prefer backend-authoritative final text when present (Grok sends this
      // so leading-space word fragments cannot stick as a glued message).
      const authoritativeContent =
        typeof event.payload.content === 'string' &&
        event.payload.content.length > 0
          ? event.payload.content
          : null
      const streamedContent = streamingContents[sessionId]
      const toolCalls = activeToolCalls[sessionId]
      const streamedBlocks = streamingContentBlocks[sessionId]
      const rawContent = authoritativeContent ?? streamedContent
      // Keep structural blocks (tools, thinking, mid-turn steers). Replacing with
      // a single authoritative text block would drop steered `user_input` bubbles
      // after the turn finishes (Grok/Codex steer).
      const hasNonTextBlocks = (streamedBlocks ?? []).some(
        b =>
          b.type === 'tool_use' ||
          b.type === 'thinking' ||
          b.type === 'user_input'
      )
      // Text-only turns: replace blocks with authoritative string (spaces intact).
      // Tool/thinking/steer turns: keep streamed block order; Grok hydration repairs text.
      const contentBlocks =
        authoritativeContent != null && !hasNonTextBlocks
          ? [{ type: 'text' as const, text: authoritativeContent }]
          : streamedBlocks
      const content = rawContent || getTextContentFromBlocks(contentBlocks)
      const hasMeaningfulPayload = hasMeaningfulAssistantPayload(
        content ?? '',
        contentBlocks ?? [],
        toolCalls ?? []
      )
      const sessionBackend = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )?.backend
      const needsBackendHydration = shouldHydrateCompletedSessionFromBackend(
        content ?? '',
        contentBlocks ?? [],
        toolCalls ?? [],
        { backend: sessionBackend }
      )

      if (needsBackendHydration) {
        console.warn(
          `[chat:done] No streaming content for session=${sessionId}. ` +
            `Skipping empty optimistic assistant; hydrating from backend.`
        )
      }

      const effectiveToolCalls = toolCalls
      const effectiveContentBlocks = contentBlocks

      // Check for unanswered blocking tools BEFORE clearing state
      // This determines whether to show "waiting" status in the UI
      const hasUnansweredBlockingTool = effectiveToolCalls?.some(
        tc =>
          (isAskUserQuestion(tc) ||
            isPlanToolCall(tc) ||
            tc.name === 'question') &&
          !isQuestionAnswered(sessionId, tc.id)
      )
      const hasPendingPermissionDenials =
        (useChatStore.getState().pendingPermissionDenials[sessionId]?.length ??
          0) > 0

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
        // Check if there are queued messages AND only plan approval is blocking (not AskUserQuestion)
        const { messageQueues } = useChatStore.getState()
        const hasQueuedMessages = (messageQueues[sessionId]?.length ?? 0) > 0
        const isOnlyPlanApproval =
          effectiveToolCalls?.every(
            tc =>
              (!isAskUserQuestion(tc) && tc.name !== 'question') ||
              isQuestionAnswered(sessionId, tc.id)
          ) &&
          effectiveToolCalls?.some(
            tc => isPlanToolCall(tc) && !isQuestionAnswered(sessionId, tc.id)
          )

        // Add optimistic assistant message BEFORE clearing streaming state.
        // This ensures the plan/question is visible in MessageList
        // before StreamingMessage unmounts (isSending becomes false).
        if (hasMeaningfulPayload) {
          const pendingIdKey = `__pendingMessageId_${sessionId}`
          const preGeneratedId = (window as unknown as Record<string, string>)[
            pendingIdKey
          ]
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

        if (hasQueuedMessages && isOnlyPlanApproval) {
          // Queued message takes priority over plan approval
          // Clear tool calls so approval UI doesn't show, let queue processor handle the queued message
          // Don't set waitingForInput(true) - this allows queue processor to send the queued message
          // Use completeSession to batch-clear (reviewing=true is fine, queue processor will override)
          completeSession(sessionId)
        } else {
          // Always stop on blocking tools, including in yolo mode.
          // Preserve question/plan UI and wait for explicit user action.
          pauseSession(sessionId)

          if (needsBackendHydration) {
            void hydrateCompletedSessionFromBackend(
              queryClient,
              sessionId,
              worktreeId
            )
          }

          // Persist plan file path and pending message ID for plan approval tools
          if (effectiveToolCalls) {
            const planPath = findPlanFilePath(effectiveToolCalls)
            if (planPath) {
              useChatStore.getState().setPlanFilePath(sessionId, planPath)
            }

            // Check if there's a plan tool call - if so, use the message ID
            // from the optimistic message (already added above) and persist it
            const hasPlanToolCall = effectiveToolCalls.some(tc =>
              isPlanToolCall(tc)
            )
            if (hasPlanToolCall) {
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
                    '[useStreamingEvents] Failed to persist pending plan state:',
                    err
                  )
                })
              }
            }
            // Question waiting state is persisted by the backend — no frontend persist needed.
          }

          // Play waiting sound
          const waitingSound = (preferences?.waiting_sound ??
            'none') as NotificationSound
          playNotificationSound(waitingSound, {
            webAccessSoundsEnabled:
              preferences?.web_access_sounds_enabled ?? true,
          })
          notifySession(sessionId, 'Needs your input')
        }
      } else if (event.payload.waiting_for_plan) {
        // Codex/Opencode plan-mode run completed with content — enter plan-waiting state.
        // The backend signals this via the waiting_for_plan field in chat:done.

        // 1. Add optimistic assistant message to cache
        let planMessageId: string | undefined
        if (hasMeaningfulPayload) {
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

        const hasQueuedMessages =
          (useChatStore.getState().messageQueues[sessionId]?.length ?? 0) > 0
        if (hasQueuedMessages) {
          // A queued prompt means the user already chose to continue past this
          // plain plan-mode response. Do not park the session on approval; clear
          // sending/waiting so the queue processor can immediately send it.
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(sessionId),
            old =>
              old
                ? {
                    ...old,
                    last_run_status: 'completed',
                    waiting_for_input: false,
                    waiting_for_input_type: undefined,
                    is_reviewing: false,
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
                        waiting_for_input_type: undefined,
                        is_reviewing: false,
                      }
                    : s
                ),
              }
            }
          )
          completeSession(sessionId)
          if (needsBackendHydration) {
            void hydrateCompletedSessionFromBackend(
              queryClient,
              sessionId,
              worktreeId
            )
          }
          return
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
        if (needsBackendHydration) {
          void hydrateCompletedSessionFromBackend(
            queryClient,
            sessionId,
            worktreeId
          )
        }
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

        // Play waiting sound
        const waitingSound = (preferences?.waiting_sound ??
          'none') as NotificationSound
        playNotificationSound(waitingSound, {
          webAccessSoundsEnabled:
            preferences?.web_access_sounds_enabled ?? true,
        })
        notifySession(sessionId, 'Needs your input')
      } else {
        // No blocking tools — add optimistic message FIRST, then batch-clear state.
        // This eliminates the flicker gap where neither streaming nor persisted content is visible.
        // The optimistic message lands in TanStack Query cache BEFORE isSending flips to false,
        // so MessageList already has the message when StreamingMessage unmounts.

        // 1. Add optimistic assistant message to cache
        if (hasMeaningfulPayload) {
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

        if (hasPendingPermissionDenials) {
          // Claude reports command/tool permission denials as a completed turn,
          // not as a backend-attached live approval request. Keep the session in
          // a waiting state so the permission approval card remains visible.
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(sessionId),
            old =>
              old
                ? {
                    ...old,
                    last_run_status: 'completed',
                    waiting_for_input: true,
                    is_reviewing: false,
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
                        is_reviewing: false,
                      }
                    : s
                ),
              }
            }
          )

          completeSession(sessionId)
          const store = useChatStore.getState()
          store.setSessionReviewing(sessionId, false)
          store.setWaitingForInput(sessionId, true)

          if (needsBackendHydration) {
            void hydrateCompletedSessionFromBackend(
              queryClient,
              sessionId,
              worktreeId
            )
          }

          const waitingSound = (preferences?.waiting_sound ??
            'none') as NotificationSound
          playNotificationSound(waitingSound, {
            webAccessSoundsEnabled:
              preferences?.web_access_sounds_enabled ?? true,
          })
          notifySession(sessionId, 'Needs your input')
        } else {
          // 2. Update last_run_status + session state in caches so UI reflects immediately.
          // CRITICAL: Include waiting_for_input/is_reviewing so
          // useSessionStatePersistence's load effect doesn't overwrite Zustand
          // with stale cache values. A normal completed chat turn is not a code
          // review; only the backend-created review session should carry
          // is_reviewing=true while its review job is running.
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(sessionId),
            old =>
              old
                ? {
                    ...old,
                    last_run_status: 'completed',
                    waiting_for_input: false,
                    is_reviewing: false,
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
                        is_reviewing: false,
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

          if (needsBackendHydration) {
            void hydrateCompletedSessionFromBackend(
              queryClient,
              sessionId,
              worktreeId
            )
          }

          // Reviewing state is persisted by the backend — no frontend persist needed.

          // Play review sound
          const reviewSound = (preferences?.review_sound ??
            'none') as NotificationSound
          playNotificationSound(reviewSound, {
            webAccessSoundsEnabled:
              preferences?.web_access_sounds_enabled ?? true,
          })
          notifySession(sessionId, 'Session finished')

          // Auto-save context (fire-and-forget, no blocking)
          if (preferences?.auto_save_context === true) {
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

    // Handle errors from any CLI backend (Claude, Codex, OpenCode, Cursor)
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

      // Auth failures from headless CLIs (e.g. Claude "Please run /login")
      // are not actionable inside chat — rewrite and offer Jean's Login modal.
      let displayError = error
      if (isCliAuthError(error)) {
        const session = queryClient.getQueryData<Session>(
          chatQueryKeys.session(session_id)
        )
        const backend = (session?.backend as CliBackend | undefined) ?? 'claude'
        displayError = handleCliAuthError(error, backend)
      }

      // Set error state for inline display
      setError(session_id, displayError)

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

      notifySession(session_id, 'Session failed')

      // Invalidate sessions list to update last_run_status in tab bar
      if (sessionWorktreeId) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(sessionWorktreeId),
        })
      }
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
    })

    // Handle cancellation (user pressed Cmd+Option+Backspace / Ctrl+Alt+Backspace).
    // Cancelled turns are removed from the visible chat timeline; run logs and
    // metadata may still retain them for diagnostics.
    const unlistenCancelled = listen<CancelledEvent>(
      'chat:cancelled',
      event => {
        const {
          session_id,
          worktree_id: eventWorktreeId,
          undo_send,
          emitted_at_ms,
          run_id: eventRunId,
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
          streamingThinkingContent,
          activeToolCalls,
          streamingContentBlocks,
          activeWorktreeId,
          activeSessionIds,
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
        const sanitizedContentBlocks =
          sanitizeCancelledContentBlocks(contentBlocks)
        const sanitizedContent =
          sanitizedContentBlocks && sanitizedContentBlocks.length > 0
            ? getTextContentFromBlocks(sanitizedContentBlocks)
            : content && isClaudeCompactionSummaryText(content)
              ? ''
              : (content ?? '')

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

        // Clear compacting state (safety net)
        useChatStore.getState().setCompacting(session_id, false)

        // Determine if we should restore message to input:
        // - undo_send from backend, OR
        // - No content streamed yet (cancelled before any response)
        // BUT: Don't restore if there are queued messages (user chose "Skip to Next")
        // Any assistant output (text, tool call, thinking, content block) counts
        // as a started response — if present, remove it from history and leave
        // input empty.
        const hasToolCalls = toolCalls && toolCalls.length > 0
        const hasText = sanitizedContent.trim().length > 0
        const hasThinking = !!streamingThinkingContent[session_id]
        const hasContentBlocks =
          !!sanitizedContentBlocks && sanitizedContentBlocks.length > 0
        const hasContent =
          hasToolCalls || hasText || hasThinking || hasContentBlocks
        const hasQueuedMessages =
          (useChatStore.getState().messageQueues[session_id] ?? []).length > 0
        const shouldHydrateCancelledFromBackend = !undo_send && !hasContent
        const shouldRestoreMessage =
          !hasQueuedMessages && (undo_send || !hasContent)

        const removeLatestUserMessageFromCache = () => {
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(session_id),
            old => {
              if (!old) return old
              const messages = [...old.messages]
              const lastIndex = messages.length - 1
              if (messages[lastIndex]?.role === 'user') {
                messages.splice(lastIndex, 1)
              }
              return { ...old, messages }
            }
          )
        }

        // Update TanStack Query cache FIRST (before clearing Zustand streaming state)
        // so the cancelled optimistic prompt/partial response disappears as soon
        // as StreamingMessage unmounts. The backend still keeps run logs/metadata
        // for diagnostics, but cancelled turns are not visible chat history.

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
              useChatStore.getState().clearLastSentAttachments(session_id)
            }
            clearLastSentMessage(session_id)

            removeLatestUserMessageFromCache()
          } else {
            useChatStore.getState().clearLastSentAttachments(session_id)
            removeLatestUserMessageFromCache()
          }
        } else {
          // Partial response exists — keep the prompt + streamed partial output
          // (text and tool calls) visible in history, marked cancelled. Attachments
          // were consumed, don't restore. Clear lastSentMessage so a later
          // chat:error (e.g., codex turn.failed emitted after interrupt) can't fall
          // back to restoring the prompt once streamingContents has been wiped by
          // cancelSession().
          useChatStore.getState().clearLastSentAttachments(session_id)
          useChatStore.getState().clearLastSentMessage(session_id)

          // Keep the partial assistant output (text + tool calls) visible in
          // history, marked cancelled. Append it optimistically to the cache so it
          // survives StreamingMessage unmounting, and persist it to the run JSONL
          // so it also survives an app reload.
          const cancelledAssistant: ChatMessage = {
            id: `cancelled-${session_id}-${emitted_at_ms}`,
            session_id,
            role: 'assistant',
            content: sanitizedContent,
            timestamp: emitted_at_ms,
            tool_calls: toolCalls ?? [],
            content_blocks: sanitizedContentBlocks ?? [],
            cancelled: true,
          }
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(session_id),
            old => {
              if (!old) return old
              // Avoid duplicate appends if the event fires twice.
              if (old.messages.some(m => m.id === cancelledAssistant.id)) {
                return old
              }
              return { ...old, messages: [...old.messages, cancelledAssistant] }
            }
          )

          const persistWorktreeId = sessionWorktreeId || eventWorktreeId
          const persistPath = persistWorktreeId
            ? useChatStore.getState().worktreePaths[persistWorktreeId]
            : undefined
          if (persistWorktreeId && persistPath) {
            void saveCancelledMessage(
              persistWorktreeId,
              persistPath,
              session_id,
              sanitizedContent,
              (toolCalls ?? []).map(tc => ({
                id: tc.id,
                name: tc.name,
                input: tc.input,
              })),
              (sanitizedContentBlocks ?? []) as Parameters<
                typeof saveCancelledMessage
              >[5]
            )
          }
        }

        // NOW batch-clear all streaming state in a single Zustand set()
        // This happens AFTER cancelled messages have been removed from cache,
        // preventing flicker.
        console.log(
          `[Cancelled] about to cancelSession session=${session_id} shouldRestore=${shouldRestoreMessage}`,
          {
            currentSending: Object.keys(
              useChatStore.getState().sendingSessionIds
            ),
          }
        )
        useChatStore.getState().cancelSession(session_id)
        if (eventRunId) {
          const runIds = cancelledRunIds.get(session_id) ?? new Set<string>()
          runIds.add(eventRunId)
          cancelledRunIds.set(session_id, runIds)
        }
        // Some backends (including Grok ACP) do not tag chunks with run_id.
        // Block their delayed output too; chat:sending clears this guard when a
        // legitimate next run starts for the session.
        cancelledUntaggedSessionIds.add(session_id)

        // Override reviewing state based on whether visible messages remain.
        const updatedSession = queryClient.getQueryData<Session>(
          chatQueryKeys.session(session_id)
        )
        useChatStore
          .getState()
          .setSessionReviewing(
            session_id,
            (updatedSession?.messages.length ?? 0) > 0
          )

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
            if (shouldHydrateCancelledFromBackend) {
              void hydrateCompletedSessionFromBackend(
                queryClient,
                session_id,
                resolvedWorktreeId
              ).then(session => {
                const lastHydratedMessage = session?.messages.at(-1)
                const hydratedCancelledAssistant =
                  lastHydratedMessage?.role === 'assistant' &&
                  lastHydratedMessage.cancelled === true
                if (hydratedCancelledAssistant) {
                  useChatStore.getState().clearInputDraft(session_id)
                }
              })
            }
          }
          queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
        }

        if (resolvedWorktreeId && wtPath) {
          const isNowReviewing =
            (queryClient.getQueryData<Session>(
              chatQueryKeys.session(session_id)
            )?.messages.length ?? 0) > 0

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

    // Handle ScheduleWakeup lifecycle events (pending/fired/cancelled) so the
    // ToolCallInline indicator can render a live countdown + status change.
    const unlistenWakeupScheduled = listen<WakeupScheduledEvent>(
      'chat:wakeup_scheduled',
      event => {
        const { wakeup } = event.payload
        useChatStore.getState().setScheduledWakeup(wakeup.tool_call_id, {
          ...wakeup,
          status: 'pending',
        })
      }
    )

    const unlistenWakeupCancelled = listen<WakeupCancelledEvent>(
      'chat:wakeup_cancelled',
      event => {
        const { tool_call_id } = event.payload
        if (!tool_call_id) return
        useChatStore
          .getState()
          .markScheduledWakeupStatus(tool_call_id, 'cancelled')
      }
    )

    // Handle ScheduleWakeup fires — the Rust scheduler emits this when a
    // persisted wakeup's fire_at_unix <= now. Enqueue the stored prompt so
    // the existing queue processor drives it through send_chat_message with
    // the session's current model/backend/execution-mode settings.
    const unlistenWakeupFired = listen<WakeupFiredEvent>(
      'chat:wakeup_fired',
      event => {
        const { session_id, worktree_id, worktree_path, prompt, tool_call_id } =
          event.payload
        const store = useChatStore.getState()
        store.markScheduledWakeupStatus(tool_call_id, 'fired')
        const model = store.selectedModels[session_id] ?? 'sonnet'
        const executionMode = store.executionModes[session_id] ?? 'yolo'
        const thinkingLevel = store.thinkingLevels[session_id] ?? 'off'
        const backend = store.selectedBackends[session_id]
        const provider = store.selectedProviders?.[session_id] ?? null
        const queuedMessage: QueuedMessage = {
          id: generateId(),
          message: prompt,
          pendingImages: [],
          pendingFiles: [],
          pendingSkills: [],
          pendingTextFiles: [],
          model,
          provider,
          executionMode,
          thinkingLevel,
          backend,
          queuedAt: Date.now(),
        }
        // Ensure the queue processor can resolve worktree → path and
        // session → worktree when firing this message.
        if (worktree_id && worktree_path) {
          store.registerWorktreePath(worktree_id, worktree_path)
        }
        useChatStore.setState(s => ({
          sessionWorktreeMap: {
            ...s.sessionWorktreeMap,
            [session_id]: worktree_id,
          },
        }))
        store.enqueueMessage(session_id, queuedMessage)
        persistEnqueue(worktree_id, worktree_path, session_id, queuedMessage)
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
            value as
              | 'claude'
              | 'codex'
              | 'opencode'
              | 'cursor'
              | 'pi'
              | 'commandcode'
          )
          store.setSelectedBackend(session_id, value as CliBackend)
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
        case 'effortLevel':
          store.setEffortLevel(
            session_id,
            value as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'ultracode'
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
      unlistenSteered.then(f => f())
      unlistenToolResult.then(f => f())
      unlistenToolEvent.then(f => f())
      unlistenPermissionDenied.then(f => f())
      unlistenCodexPermissionRequest.then(f => f())
      unlistenCodexCommandApprovalRequest.then(f => f())
      unlistenCodexUserInputRequest.then(f => f())
      unlistenCodexMcpElicitation.then(f => f())
      unlistenCodexDynamicToolCall.then(f => f())
      unlistenCodexGoal.then(f => f())
      unlistenDone.then(f => f())
      unlistenError.then(f => f())
      unlistenCancelled.then(f => f())
      unlistenCompacting.then(f => f())
      unlistenCompacted.then(f => f())
      unlistenWakeupScheduled.then(f => f())
      unlistenWakeupCancelled.then(f => f())
      unlistenWakeupFired.then(f => f())
      unlistenSettingChanged.then(f => f())
    }
  }, [queryClient, wsConnected])
}
