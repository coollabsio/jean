import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import type { QueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { chatQueryKeys } from '@/services/chat'
import { isTauri, saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences, NotificationSound } from '@/types/preferences'
import { triggerImmediateGitPoll } from '@/services/git-status'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { playNotificationSound } from '@/lib/sounds'
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
  CompactedEvent,
  Session,
  SessionDigest,
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
    } = useChatStore.getState()

    const unlistenChunk = listen<ChunkEvent>('chat:chunk', event => {
      // Log chunks that might contain ExitPlanMode
      if (event.payload.content.includes('ExitPlanMode')) {
        console.log(
          '[ChatWindow] Chunk contains ExitPlanMode:',
          event.payload.content
        )
      }
      appendStreamingContent(event.payload.session_id, event.payload.content)
      // Also add to content blocks for inline rendering
      addTextBlock(event.payload.session_id, event.payload.content)
    })

    const unlistenToolUse = listen<ToolUseEvent>('chat:tool_use', event => {
      const { session_id, id, name, input, parent_tool_use_id } = event.payload
      console.log('[ChatWindow] Tool use received:', {
        name,
        id,
        input,
        parent_tool_use_id,
      })
      addToolCall(session_id, { id, name, input, parent_tool_use_id })
    })

    const unlistenToolBlock = listen<ToolBlockEvent>(
      'chat:tool_block',
      event => {
        const { session_id, tool_call_id } = event.payload
        console.log('[ChatWindow] Tool block received:', { tool_call_id })
        addToolBlock(session_id, tool_call_id)
      }
    )

    // Handle thinking content blocks (extended thinking)
    const unlistenThinking = listen<ThinkingEvent>('chat:thinking', event => {
      const { session_id, content } = event.payload
      console.log('[ChatWindow] Thinking block received:', {
        length: content.length,
      })
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
          console.log(
            '[ChatWindow] Cleared executed tool from pending denials:',
            tool_use_id
          )
        }

        // Look up the tool call to get its name
        const toolCalls = activeToolCalls[session_id] ?? []
        const toolCall = toolCalls.find(tc => tc.id === tool_use_id)

        // Skip storing output for Read tool (files can be large, users can click to open)
        if (toolCall?.name === 'Read') {
          console.log('[ChatWindow] Tool result skipped (Read tool):', {
            tool_use_id,
            outputLength: output.length,
          })
          return
        }

        console.log('[ChatWindow] Tool result received:', {
          tool_use_id,
          outputLength: output.length,
        })
        updateToolCallOutput(session_id, tool_use_id, output)
      }
    )

    // Handle permission denied events (tools that require approval)
    const unlistenPermissionDenied = listen<PermissionDeniedEvent>(
      'chat:permission_denied',
      event => {
        const { session_id, denials } = event.payload
        console.log('[ChatWindow] Permission denied:', {
          session_id,
          denials: denials.map(d => ({
            tool_name: d.tool_name,
            tool_use_id: d.tool_use_id,
          })),
        })

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
      const isCurrentlyViewing = isActiveWorktree && isActiveSession

      // Check if session recap is enabled in preferences
      const preferences = queryClient.getQueryData<AppPreferences>(preferencesQueryKeys.preferences())
      const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

      // Only generate digest if status is CHANGING to review (not already reviewing)
      // This prevents generating digests for all restored sessions on app startup
      const wasAlreadyReviewing = useChatStore.getState().reviewingSessions[sessionId] ?? false

      if (!isCurrentlyViewing && sessionRecapEnabled && !wasAlreadyReviewing) {
        // Mark for digest and generate it in the background immediately
        markSessionNeedsDigest(sessionId)
        console.log('[useStreamingEvents] Session completed while not viewing, generating digest:', sessionId)

        // Generate digest in background (fire and forget)
        invoke<SessionDigest>('generate_session_digest', { sessionId })
          .then(digest => {
            useChatStore.getState().setSessionDigest(sessionId, digest)
            console.log('[useStreamingEvents] Digest generated for session:', sessionId)
          })
          .catch(err => {
            console.error('[useStreamingEvents] Failed to generate digest:', err)
          })
      }

      // Capture streaming state to local variables BEFORE clearing
      // This ensures we have the data for the optimistic message
      // For non-streaming providers (Gemini, Codex), content comes in the done event
      // For Claude, content comes from streaming chunks accumulated in store
      const eventContent = (event.payload as { content?: string }).content
      const content = eventContent || streamingContents[sessionId]
      const toolCalls = activeToolCalls[sessionId]
      const contentBlocks = streamingContentBlocks[sessionId]

      // Debug log for non-Claude providers
      if (eventContent) {
        console.log('[useStreamingEvents] Got content from done event:', eventContent.substring(0, 100))
      }

      // Check for unanswered blocking tools BEFORE clearing state
      // This determines whether to show "waiting" status in the UI
      const hasUnansweredBlockingTool = toolCalls?.some(
        tc =>
          (isAskUserQuestion(tc) || isExitPlanMode(tc)) &&
          !isQuestionAnswered(sessionId, tc.id)
      )

      // CRITICAL: Clear streaming/sending state BEFORE adding optimistic message
      // This prevents double-render where both StreamingMessage and persisted message show
      // React Query's setQueryData triggers subscribers immediately, so isSending must be
      // false before the new message appears in the cache
      setError(sessionId, null)
      clearLastSentMessage(sessionId)

      if (hasUnansweredBlockingTool) {
        // Check if there are queued messages AND only ExitPlanMode is blocking (not AskUserQuestion)
        const { messageQueues } = useChatStore.getState()
        const hasQueuedMessages = (messageQueues[sessionId]?.length ?? 0) > 0
        const isOnlyExitPlanMode =
          toolCalls?.every(
            tc => !isAskUserQuestion(tc) || isQuestionAnswered(sessionId, tc.id)
          ) &&
          toolCalls?.some(
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
          console.log(
            '[useStreamingEvents] ExitPlanMode with queued messages - skipping wait state, queue will process'
          )
        } else {
          // Original behavior: show blocking tool UI and wait for user input
          // Keep tool calls and content blocks so UI shows question
          // Clear text content (not blocks) and executing mode
          // Set waiting state and allow user to send messages (answers)
          clearStreamingContent(sessionId)
          clearExecutingMode(sessionId)
          setWaitingForInput(sessionId, true)
          removeSendingSession(sessionId)

          // Play waiting sound if not currently viewing this session
          if (!isCurrentlyViewing) {
            const waitingSound = (preferences?.waiting_sound ?? 'none') as NotificationSound
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

        // Play review sound if not currently viewing this session
        if (!isCurrentlyViewing) {
          const reviewSound = (preferences?.review_sound ?? 'none') as NotificationSound
          playNotificationSound(reviewSound)
        }
      }

      // NOW add optimistic message after streaming state is cleared
      // Add message if there's content OR tool calls (some responses are only tool calls)
      if (content || (toolCalls && toolCalls.length > 0)) {
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old => {
            if (!old) return old
            return {
              ...old,
              messages: [
                ...old.messages,
                {
                  id: crypto.randomUUID(),
                  session_id: sessionId,
                  role: 'assistant' as const,
                  content: content ?? '',
                  timestamp: Math.floor(Date.now() / 1000),
                  tool_calls: toolCalls ?? [],
                  content_blocks: contentBlocks ?? [],
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
          console.log('[ChatWindow] PR created detected:', {
            prNumber,
            prUrl,
            worktreeId,
          })
          // Save PR info to worktree (async, fire and forget)
          saveWorktreePr(worktreeId, prNumber, prUrl)
            .then(() => {
              console.log('[ChatWindow] PR info saved successfully')
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
      const sessionWorktreeId = useChatStore.getState().sessionWorktreeMap[session_id]
      const isActiveWorktree = sessionWorktreeId === activeWorktreeId
      const isActiveSession = sessionWorktreeId
        ? activeSessionIds[sessionWorktreeId] === session_id
        : false
      const isCurrentlyViewing = isActiveWorktree && isActiveSession

      // Check if session recap is enabled in preferences
      const preferences = queryClient.getQueryData<AppPreferences>(preferencesQueryKeys.preferences())
      const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

      // Only generate digest if status is CHANGING to review (not already reviewing)
      const wasAlreadyReviewing = useChatStore.getState().reviewingSessions[session_id] ?? false

      if (!isCurrentlyViewing && sessionRecapEnabled && !wasAlreadyReviewing) {
        // Mark for digest and generate it in the background immediately
        markSessionNeedsDigest(session_id)
        console.log('[useStreamingEvents] Session errored while not viewing, generating digest:', session_id)

        invoke<SessionDigest>('generate_session_digest', { sessionId: session_id })
          .then(digest => {
            useChatStore.getState().setSessionDigest(session_id, digest)
          })
          .catch(err => {
            console.error('[useStreamingEvents] Failed to generate digest:', err)
          })
      }

      // Set error state for inline display
      setError(session_id, error)

      // Restore the input that failed so user can retry
      const lastMessage = lastSentMessages[session_id]
      if (lastMessage) {
        setInputDraft(session_id, lastMessage)
        clearLastSentMessage(session_id)
      }

      // Clear streaming state for this session
      clearStreamingContent(session_id)
      clearToolCalls(session_id)
      removeSendingSession(session_id)

      // Clear waiting state (in case error occurred while waiting for input)
      setWaitingForInput(session_id, false)

      // Clear executing planning mode and set reviewing state
      const { clearExecutingMode, setSessionReviewing } = useChatStore.getState()
      clearExecutingMode(session_id)
      setSessionReviewing(session_id, true)

      // Show error toast with longer duration
      toast.error('Request failed', {
        description: error,
        duration: 10000,
      })
    })

    // Handle cancellation (user pressed Cmd+Option+Backspace / Ctrl+Alt+Backspace)
    // Preserves partial streaming content as an optimistic message (like chat:done)
    // Backend will also persist the partial response; mutation completion will update cache
    const unlistenCancelled = listen<CancelledEvent>(
      'chat:cancelled',
      event => {
        const { session_id, undo_send } = event.payload

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
        const sessionWorktreeId = useChatStore.getState().sessionWorktreeMap[session_id]
        const isActiveWorktree = sessionWorktreeId === activeWorktreeId
        const isActiveSession = sessionWorktreeId
          ? activeSessionIds[sessionWorktreeId] === session_id
          : false
        const isCurrentlyViewing = isActiveWorktree && isActiveSession

        // Check if session recap is enabled in preferences
        const preferences = queryClient.getQueryData<AppPreferences>(preferencesQueryKeys.preferences())
        const sessionRecapEnabled = preferences?.session_recap_enabled ?? false

        // Only generate digest if status is CHANGING to review (not already reviewing)
        const wasAlreadyReviewing = useChatStore.getState().reviewingSessions[session_id] ?? false

        if (!isCurrentlyViewing && sessionRecapEnabled && !wasAlreadyReviewing) {
          // Mark for digest and generate it in the background immediately
          markSessionNeedsDigest(session_id)
          console.log('[useStreamingEvents] Session cancelled while not viewing, generating digest:', session_id)

          invoke<SessionDigest>('generate_session_digest', { sessionId: session_id })
            .then(digest => {
              useChatStore.getState().setSessionDigest(session_id, digest)
            })
            .catch(err => {
              console.error('[useStreamingEvents] Failed to generate digest:', err)
            })
        }

        // Clear streaming state for this session
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
        const hasContent = content || (toolCalls && toolCalls.length > 0)
        const shouldRestoreMessage = undo_send || !hasContent

        if (shouldRestoreMessage) {
          // Restore message to input and remove from chat (no content to preserve)
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
              toast.info('Message restored to input')
            } else {
              toast.info('Request cancelled')
            }
            clearLastSentMessage(session_id)

            // Remove the user message from chat (undo the send)
            queryClient.setQueryData<Session>(
              chatQueryKeys.session(session_id),
              old => {
                if (!old) return old
                // Remove the last user message
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
          }
        } else {
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
                    id: crypto.randomUUID(),
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

        // Invalidate sessions to ensure persisted state is loaded
        // (optimistic update above may differ from what backend persisted)
        if (sessionWorktreeId) {
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(sessionWorktreeId),
          })
        }
      }
    )

    // Handle context compaction events
    const unlistenCompacted = listen<CompactedEvent>(
      'chat:compacted',
      event => {
        const { session_id, metadata } = event.payload
        const { setLastCompaction } = useChatStore.getState()
        setLastCompaction(session_id, metadata.trigger)
        toast.info(
          `Context ${metadata.trigger === 'auto' ? 'auto-' : ''}compacted`
        )
      }
    )

    return () => {
      unlistenChunk.then(f => f())
      unlistenToolUse.then(f => f())
      unlistenToolBlock.then(f => f())
      unlistenThinking.then(f => f())
      unlistenToolResult.then(f => f())
      unlistenPermissionDenied.then(f => f())
      unlistenDone.then(f => f())
      unlistenError.then(f => f())
      unlistenCancelled.then(f => f())
      unlistenCompacted.then(f => f())
    }
  }, [queryClient])
}
