import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/store/chat-store'
import {
  useSendMessage,
  persistDequeue,
  persistRequeueFront,
  isDuplicateSendError,
} from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { DEFAULT_PARALLEL_EXECUTION_PROMPT } from '@/types/preferences'
import { isTauri } from '@/services/projects'
import { isLocalBackend } from '@/lib/environment'
import { useWsConnectionStatus } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { buildMessageWithRefs } from '@/components/chat/message-with-refs'

// GIT_ALLOWED_TOOLS duplicated from ChatWindow - tools always allowed for git operations
const GIT_ALLOWED_TOOLS = ['Bash', 'Read', 'Glob', 'Grep']

/**
 * Global queue processor hook - must be at App level so it stays active
 * even when ChatWindow is unmounted (e.g., when viewing a different worktree)
 *
 * Processes queued messages for ALL sessions, not just the active one.
 * This fixes the bug where queued prompts don't execute when the worktree is unfocused.
 *
 * Uses atomic backend dequeue to prevent double-processing when both native
 * and web clients are running simultaneously.
 */
export function useQueueProcessor(): void {
  const sendMessage = useSendMessage()
  const { data: preferences } = usePreferences()
  // Re-run effect when WS connects so queue processing works in web mode
  const wsConnected = useWsConnectionStatus()

  // Track which sessions we're currently processing to prevent race conditions
  const processingRef = useRef<Set<string>>(new Set())

  // Counter to force effect re-evaluation after a mutation settles.
  // Without this, clearing processingRef in onSettled doesn't re-trigger
  // the effect because hasProcessableQueue (boolean) hasn't changed.
  const [settleTrigger, setSettleTrigger] = useState(0)

  // PERFORMANCE: Derived boolean selector — only re-renders when the answer changes,
  // not on every mutation to any key in the underlying records.
  const hasProcessableQueue = useChatStore(state => {
    for (const [sessionId, queue] of Object.entries(state.messageQueues)) {
      if (
        queue &&
        queue.length > 0 &&
        !state.sendingSessionIds[sessionId] &&
        !state.waitingForInputSessionIds[sessionId]
      ) {
        return true
      }
    }
    return false
  })

  useEffect(() => {
    if (!hasProcessableQueue || !isTauri()) return

    // In web access, Rust owns queued-message draining. A browser client can
    // disconnect between an atomic dequeue and the follow-up send request,
    // making the prompt disappear without executing. Native app processing is
    // kept for desktop-local queues; web clients only mirror queue updates.
    if (!isLocalBackend()) return

    // Read fresh state inside effect to avoid subscribing to full records.
    // Store actions are accessed via getState() inside the async callback
    // to ensure fresh references after the await.
    const {
      messageQueues,
      sendingSessionIds,
      waitingForInputSessionIds,
      sessionWorktreeMap,
      worktreePaths,
    } = useChatStore.getState()

    // Process each session's queue
    for (const [sessionId, queue] of Object.entries(messageQueues)) {
      // Skip if queue is empty
      if (!queue || queue.length === 0) continue

      // Skip if already processing this session
      if (processingRef.current.has(sessionId)) continue

      // Skip if session is currently sending
      if (sendingSessionIds[sessionId]) continue

      // Skip if session is waiting for user input (AskUserQuestion/ExitPlanMode)
      if (waitingForInputSessionIds[sessionId]) continue

      const worktreeId = sessionWorktreeMap[sessionId]
      const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined

      // Skip if we can't find the worktree for this session
      if (!worktreeId || !worktreePath) {
        logger.warn('Queue processor: Cannot find worktree for session', {
          sessionId,
        })
        continue
      }

      // Mark as processing to prevent duplicate processing within this client
      processingRef.current.add(sessionId)

      // Atomically dequeue from backend — only ONE client wins each message.
      // The backend uses per-session locking, so concurrent dequeue calls from
      // native and web clients are serialized. The loser gets null.
      const capturedSessionId = sessionId
      const capturedWorktreeId = worktreeId
      const capturedWorktreePath = worktreePath
      persistDequeue(worktreeId, worktreePath, sessionId)
        .then(msg => {
          if (!msg) {
            // Another client already dequeued this message, or the backend
            // queue was empty. Clear local Zustand queue to prevent phantom
            // entries from lingering (defense against stale state).
            useChatStore.getState().clearQueue(capturedSessionId)
            processingRef.current.delete(capturedSessionId)
            return
          }

          // Remove the specific dequeued message from local Zustand by ID.
          // This is idempotent: if the queue:updated event already synced,
          // the message won't be found and this is a no-op.
          useChatStore.getState().removeQueuedMessage(capturedSessionId, msg.id)

          logger.info('Queue processor: Processing queued message', {
            sessionId: capturedSessionId,
            worktreeId: capturedWorktreeId,
            messageId: msg.id,
          })

          const store = useChatStore.getState()

          // Clear stale streaming state before starting new message
          store.clearStreamingContent(capturedSessionId)
          store.clearToolCalls(capturedSessionId)
          store.clearStreamingContentBlocks(capturedSessionId)

          // Set up session state
          store.setLastSentMessage(capturedSessionId, msg.message)
          store.setError(capturedSessionId, null)
          store.addSendingSession(capturedSessionId)
          store.setSessionReviewing(capturedSessionId, false)
          store.setExecutingMode(capturedSessionId, msg.executionMode)
          store.setSelectedModel(capturedSessionId, msg.model)

          // Get session-approved tools
          const sessionApprovedTools = store.getApprovedTools(capturedSessionId)
          const allowedTools =
            sessionApprovedTools.length > 0
              ? [...GIT_ALLOWED_TOOLS, ...sessionApprovedTools]
              : undefined

          // Build full message with attachment refs
          const fullMessage = buildMessageWithRefs(msg)

          // Send the message
          sendMessage.mutate(
            {
              sessionId: capturedSessionId,
              worktreeId: capturedWorktreeId,
              worktreePath: capturedWorktreePath,
              message: fullMessage,
              model: msg.model,
              executionMode: msg.executionMode,
              thinkingLevel: msg.thinkingLevel,
              effortLevel: msg.effortLevel,
              mcpConfig: msg.mcpConfig,
              customProfileName: msg.provider ?? undefined,
              parallelExecutionPrompt:
                preferences?.parallel_execution_prompt_enabled
                  ? (preferences.magic_prompts?.parallel_execution ??
                    DEFAULT_PARALLEL_EXECUTION_PROMPT)
                  : undefined,
              chromeEnabled: preferences?.chrome_enabled ?? false,
              allowedTools,
              fromQueue: true,
            },
            {
              onError: error => {
                // Lost the send race against the backend queue drain (or
                // another client). Requeue the original message at the front
                // so it retries when the active run completes — never drop it.
                if (!isDuplicateSendError(error)) return
                logger.warn(
                  'Queue processor: send race lost, requeueing message',
                  { sessionId: capturedSessionId, messageId: msg.id }
                )
                const st = useChatStore.getState()
                st.enqueueMessage(capturedSessionId, msg)
                st.moveQueuedMessageFront(capturedSessionId, msg.id)
                persistRequeueFront(
                  capturedWorktreeId,
                  capturedWorktreePath,
                  capturedSessionId,
                  msg
                ).catch(err => {
                  logger.error('Queue processor: failed to requeue message', {
                    sessionId: capturedSessionId,
                    messageId: msg.id,
                    err,
                  })
                })
              },
              onSettled: () => {
                processingRef.current.delete(capturedSessionId)
                setSettleTrigger(t => t + 1)
              },
            }
          )
        })
        .catch(err => {
          logger.error('Queue processor: backend dequeue failed', {
            sessionId: capturedSessionId,
            err,
          })
          processingRef.current.delete(capturedSessionId)
          setSettleTrigger(t => t + 1)
        })
    }
  }, [
    hasProcessableQueue,
    settleTrigger,
    sendMessage,
    preferences?.parallel_execution_prompt_enabled,
    preferences?.magic_prompts?.parallel_execution,
    preferences?.chrome_enabled,
    wsConnected,
  ])
}
