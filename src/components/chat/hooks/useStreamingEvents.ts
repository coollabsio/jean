import { useEffect } from 'react'
import { listen, useWsConnectionStatus } from '@/lib/transport'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { chatQueryKeys } from '@/services/chat'
import { isTauri, saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences, NotificationSound } from '@/types/preferences'
import { triggerImmediateGitPoll } from '@/services/git-status'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { playNotificationSound } from '@/lib/sounds'
import { findPlanFilePath } from '@/components/chat/tool-call-utils'
import { generateId } from '@/lib/uuid'
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
} from '@/types/chat'

interface UseStreamingEventsParams {
  queryClient: QueryClient
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
      clearStreamingContent,
      clearToolCalls,
      clearStreamingContentBlocks,
      removeSendingSession,
      addSendingSession,
    } = useChatStore.getState()

    // Sync sending state across clients (web <-> native)
    const unlistenSending = listen<{
      session_id: string
      worktree_id: string
    }>('chat:sending', event => {
      const { session_id, worktree_id: wtId } = event.payload
      addSendingSession(session_id)
      // Invalidate sessions list so non-sender windows update metadata.
      // IMPORTANT: Do NOT invalidate individual session queries here — it races
      // with the mutation's optimistic updates and can overwrite them with stale
      // JSONL data, causing duplicate/mismatched messages.
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(wtId),
      })
    })

    const unlistenChunk = listen<ChunkEvent>('chat:chunk', event => {
      appendStreamingContent(event.payload.session_id, event.payload.content)
      // Also add to content blocks for inline rendering
      addTextBlock(event.payload.session_id, event.payload.content)
    })

    const unlistenToolUse = listen<ToolUseEvent>('chat:tool_use', event => {
      const { session_id, id, name, input, parent_tool_use_id } = event.payload
      addToolCall(session_id, { id, name, input, parent_tool_use_id })
    })

    const unlistenToolBlock = listen<ToolBlockEvent>(
      'chat:tool_block',
      event => {
        const { session_id, tool_call_id } = event.payload
        addToolBlock(session_id, tool_call_id)
      }
    )

    // Handle thinking content blocks (extended thinking)
    const unlistenThinking = listen<ThinkingEvent>('chat:thinking', event => {
      const { session_id, content } = event.payload
      addThinkingBlock(session_id, content)
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

        // Skip storing output for Read tool (files can be large, users can click to open)
        if (toolCall?.name === 'Read') {
          return
        }

        updateToolCallOutput(session_id, tool_use_id, output)
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

      const {
        streamingContents,
        activeToolCalls,
        streamingContentBlocks,
        setError,
        clearLastSentMessage,
        clearStreamingPlanApproval,
        clearExecutingMode,
        setSessionReviewing,
        isQuestionAnswered,
        setWaitingForInput,
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

      // Check if session recap is enabled in preferences
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

      // Only generate digest if status is CHANGING to review (not already reviewing)
      // This prevents generating digests for all restored sessions on app startup
      const wasAlreadyReviewing =
        useChatStore.getState().reviewingSessions[sessionId] ?? false

      if (!isCurrentlyViewing && sessionRecapEnabled && !wasAlreadyReviewing) {
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

      if (hasUnansweredBlockingTool) {
        // Check if there are queued messages AND only ExitPlanMode is blocking (not AskUserQuestion)
        const { messageQueues } = useChatStore.getState()
        const hasQueuedMessages = (messageQueues[sessionId]?.length ?? 0) > 0
        const isOnlyExitPlanMode =
          effectiveToolCalls?.every(
            tc => !isAskUserQuestion(tc) || isQuestionAnswered(sessionId, tc.id)
          ) &&
          effectiveToolCalls?.some(
            tc => isExitPlanMode(tc) && !isQuestionAnswered(sessionId, tc.id)
          )

        if (hasQueuedMessages && isOnlyExitPlanMode) {
          // Queued message takes priority over plan approval
          // Clear tool calls so approval UI doesn't show, let queue processor handle the queued message
          // Don't set waitingForInput(true) - this allows queue processor to send the queued message
          clearStreamingContent(sessionId)
          clearStreamingContentBlocks(sessionId)
          clearToolCalls(sessionId)
          clearExecutingMode(sessionId)
          removeSendingSession(sessionId)
        } else {
          // Original behavior: show blocking tool UI and wait for user input
          // Keep tool calls and content blocks so UI shows question
          // Clear text content (not blocks) and executing mode
          // Set waiting state and allow user to send messages (answers)
          clearStreamingContent(sessionId)
          clearExecutingMode(sessionId)
          setWaitingForInput(sessionId, true)
          removeSendingSession(sessionId)

          // Determine waiting type: question or plan
          const hasUnansweredQuestion = effectiveToolCalls?.some(
            tc => isAskUserQuestion(tc) && !isQuestionAnswered(sessionId, tc.id)
          )
          const hasUnansweredPlan = effectiveToolCalls?.some(
            tc => isExitPlanMode(tc) && !isQuestionAnswered(sessionId, tc.id)
          )
          // Questions take priority over plans for the type indicator
          const waitingType: 'question' | 'plan' | null = hasUnansweredQuestion
            ? 'question'
            : hasUnansweredPlan
              ? 'plan'
              : null

          // Persist plan file path and pending message ID for ExitPlanMode
          if (effectiveToolCalls) {
            const planPath = findPlanFilePath(effectiveToolCalls)
            if (planPath) {
              useChatStore.getState().setPlanFilePath(sessionId, planPath)
            }

            // Check if there's an ExitPlanMode tool call - if so, generate a message ID
            // that will be used for the optimistic message and persist it
            const hasExitPlanModeCall = effectiveToolCalls.some(tc => isExitPlanMode(tc))
            if (hasExitPlanModeCall) {
              // Generate message ID now so we can persist it before the optimistic message is created
              const pendingMessageId = generateId()
              useChatStore
                .getState()
                .setPendingPlanMessageId(sessionId, pendingMessageId)
              // Store for use when creating the optimistic message
              ;(window as unknown as Record<string, string>)[
                `__pendingMessageId_${sessionId}`
              ] = pendingMessageId

              // Persist directly to session file (session state persistence hook only handles active session)
              const { worktreePaths } = useChatStore.getState()
              const wtPath = worktreePaths[worktreeId]
              if (wtPath) {
                invoke('update_session_state', {
                  worktreeId,
                  worktreePath: wtPath,
                  sessionId,
                  planFilePath: planPath ?? undefined,
                  pendingPlanMessageId: pendingMessageId,
                  waitingForInput: true,
                  waitingForInputType: waitingType,
                }).catch(err => {
                  console.error(
                    '[useStreamingEvents] Failed to persist plan state:',
                    err
                  )
                })
              }
            } else if (waitingType === 'question') {
              // Persist question waiting state (no plan file path needed)
              const { worktreePaths } = useChatStore.getState()
              const wtPath = worktreePaths[worktreeId]
              if (wtPath) {
                invoke('update_session_state', {
                  worktreeId,
                  worktreePath: wtPath,
                  sessionId,
                  waitingForInput: true,
                  waitingForInputType: waitingType,
                }).catch(err => {
                  console.error(
                    '[useStreamingEvents] Failed to persist question state:',
                    err
                  )
                })
              }
            }
          }

          // Play waiting sound if not currently viewing this session
          if (!isCurrentlyViewing) {
            const waitingSound = (preferences?.waiting_sound ??
              'none') as NotificationSound
            playNotificationSound(waitingSound)
          }
        }
      } else {
        // No blocking tools - clear everything and mark for review
        clearStreamingContent(sessionId)
        clearStreamingContentBlocks(sessionId)
        clearToolCalls(sessionId)
        removeSendingSession(sessionId)
        setWaitingForInput(sessionId, false)
        clearStreamingPlanApproval(sessionId)
        clearExecutingMode(sessionId)
        setSessionReviewing(sessionId, true)

        // Persist reviewing state to disk BEFORE invalidating queries below.
        // Without this, invalidateQueries can refetch stale is_reviewing: false
        // and useSessionStatePersistence overwrites Zustand, causing idle↔review oscillation.
        const { worktreePaths: wtPaths } = useChatStore.getState()
        const wtPath = wtPaths[worktreeId]
        if (wtPath) {
          invoke('update_session_state', {
            worktreeId,
            worktreePath: wtPath,
            sessionId,
            isReviewing: true,
            waitingForInput: false,
          }).catch(err =>
            console.error(
              '[useStreamingEvents] Failed to persist reviewing state:',
              err
            )
          )
        }

        // Play review sound if not currently viewing this session
        if (!isCurrentlyViewing) {
          const reviewSound = (preferences?.review_sound ??
            'none') as NotificationSound
          playNotificationSound(reviewSound)
        }
      }

      // NOW add optimistic message after streaming state is cleared
      // Add message if there's content OR tool calls (some responses are only tool calls)
      if (content || (effectiveToolCalls && effectiveToolCalls.length > 0)) {
        // Use pre-generated message ID if available (for ExitPlanMode), otherwise generate new
        const pendingIdKey = `__pendingMessageId_${sessionId}`
        const preGeneratedId = (window as unknown as Record<string, string>)[
          pendingIdKey
        ]
        const messageId = preGeneratedId ?? generateId()
        // Clean up the temporary storage
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
              messages: [
                ...old.messages,
                {
                  id: messageId,
                  session_id: sessionId,
                  role: 'assistant' as const,
                  content: content ?? '',
                  timestamp: Math.floor(Date.now() / 1000),
                  tool_calls: effectiveToolCalls ?? [],
                  content_blocks: effectiveContentBlocks ?? [],
                },
              ],
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

      // Invalidate sessions list to update metadata
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
    })

    // Handle errors from Claude CLI
    const unlistenError = listen<ErrorEvent>('chat:error', event => {
      const { session_id, error } = event.payload

      // Store error for inline display and restore input
      const {
        lastSentMessages,
        setInputDraft,
        clearLastSentMessage,
        setError,
        setWaitingForInput,
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

      // Check if session recap is enabled in preferences
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

      // Only generate digest if status is CHANGING to review (not already reviewing)
      const wasAlreadyReviewing =
        useChatStore.getState().reviewingSessions[session_id] ?? false

      if (!isCurrentlyViewing && sessionRecapEnabled && !wasAlreadyReviewing) {
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

      // Restore the input that failed so user can retry
      const lastMessage = lastSentMessages[session_id]
      if (lastMessage) {
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

      }

      // Restore attachments that were cleared on send
      useChatStore.getState().restoreAttachments(session_id)

      // Clear streaming state for this session
      clearStreamingContent(session_id)
      clearToolCalls(session_id)
      removeSendingSession(session_id)

      // Clear waiting state (in case error occurred while waiting for input)
      setWaitingForInput(session_id, false)

      // Clear executing planning mode and set reviewing state
      const { clearExecutingMode, setSessionReviewing } =
        useChatStore.getState()
      clearExecutingMode(session_id)
      setSessionReviewing(session_id, true)
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
        } = event.payload

        // Capture streaming state BEFORE clearing (like chat:done does)
        const {
          streamingContents,
          activeToolCalls,
          streamingContentBlocks,
          activeWorktreeId,
          activeSessionIds,
          markSessionNeedsDigest,
        } = useChatStore.getState()
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

        // Clear streaming and compacting state for this session
        useChatStore.getState().setCompacting(session_id, false)
        clearStreamingContent(session_id)
        clearToolCalls(session_id)
        clearStreamingContentBlocks(session_id)
        removeSendingSession(session_id)

        // Clear waiting state (in case cancelled while waiting for input)
        const {
          setWaitingForInput,
          clearExecutingMode,
          clearStreamingPlanApproval,
          setSessionReviewing,
        } = useChatStore.getState()
        setWaitingForInput(session_id, false)
        clearExecutingMode(session_id)
        clearStreamingPlanApproval(session_id)

        // Determine if we should restore message to input:
        // - undo_send from backend, OR
        // - No content streamed yet (cancelled before any response)
        // BUT: Don't restore if there are queued messages (user chose "Skip to Next")
        const hasContent = content || (toolCalls && toolCalls.length > 0)
        const hasQueuedMessages =
          (useChatStore.getState().messageQueues[session_id] ?? []).length > 0
        const shouldRestoreMessage =
          !hasQueuedMessages && (undo_send || !hasContent)

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

          // Restore review state if session still has messages after undoing the send
          const updatedSession = queryClient.getQueryData<Session>(
            chatQueryKeys.session(session_id)
          )
          if (updatedSession && updatedSession.messages.length > 0) {
            setSessionReviewing(session_id, true)
          }
        } else {
          // Partial response exists — attachments were consumed, don't restore
          useChatStore.getState().clearLastSentAttachments(session_id)
          // Preserve partial response as optimistic message
          // This provides immediate visual feedback; mutation completion will update with persisted version
          queryClient.setQueryData<Session>(
            chatQueryKeys.session(session_id),
            old => {
              if (!old) return old
              return {
                ...old,
                messages: [
                  ...old.messages,
                  {
                    id: generateId(),
                    session_id,
                    role: 'assistant' as const,
                    content: content ?? '',
                    timestamp: Math.floor(Date.now() / 1000),
                    tool_calls: toolCalls ?? [],
                    content_blocks: contentBlocks ?? [],
                    cancelled: true,
                  },
                ],
              }
            }
          )
          toast.info('Request cancelled')
          setSessionReviewing(session_id, true)
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
              console.error(
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
        const { session_id } = event.payload
        const { setCompacting } = useChatStore.getState()
        setCompacting(session_id, true)
        toast.info('Compacting context...')
      }
    )

    const unlistenCompacted = listen<CompactedEvent>(
      'chat:compacted',
      event => {
        const { session_id, metadata } = event.payload
        const { setLastCompaction, setCompacting } = useChatStore.getState()
        setCompacting(session_id, false)
        setLastCompaction(session_id, metadata.trigger)

        // Look up session name from query cache
        let sessionName: string | undefined
        const queriesData = queryClient.getQueriesData<WorktreeSessions>({
          queryKey: ['chat', 'sessions'],
        })
        for (const [, data] of queriesData) {
          const match = data?.sessions?.find(s => s.id === session_id)
          if (match) {
            sessionName = match.name
            break
          }
        }
        const label = sessionName ? ` (${sessionName})` : ''
        toast.info(
          `Context ${metadata.trigger === 'auto' ? 'auto-' : ''}compacted${label}`
        )
      }
    )

    // Handle session setting changes (model, thinking level, execution mode)
    // Broadcast by other clients via broadcast_session_setting command
    const unlistenSettingChanged = listen<{
      session_id: string
      key: string
      value: string
    }>('session:setting-changed', event => {
      const { session_id, key, value } = event.payload
      const store = useChatStore.getState()
      switch (key) {
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
      }
    })

    return () => {
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
