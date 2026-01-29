import { useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useSendMessage } from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { isTauri } from '@/services/projects'
import type { QueuedMessage } from '@/types/chat'
import { logger } from '@/lib/logger'

// GIT_ALLOWED_TOOLS duplicated from ChatWindow - tools always allowed for git operations
const GIT_ALLOWED_TOOLS = ['Bash', 'Read', 'Glob', 'Grep']

/**
 * Build full message with attachment references for backend
 * Pure function extracted from ChatWindow
 */
function buildMessageWithRefs(queuedMsg: QueuedMessage): string {
  let message = queuedMsg.message

  // Add file references (from @ mentions)
  if (queuedMsg.pendingFiles.length > 0) {
    const fileRefs = queuedMsg.pendingFiles
      .map(f => `[File: ${f.relativePath} - Use the Read tool to view this file]`)
      .join('\n')
    message = message ? `${message}\n\n${fileRefs}` : fileRefs
  }

  // Add skill references (from / mentions)
  if (queuedMsg.pendingSkills.length > 0) {
    const skillRefs = queuedMsg.pendingSkills
      .map(s => `[Skill: ${s.path} - Read and use this skill to guide your response]`)
      .join('\n')
    message = message ? `${message}\n\n${skillRefs}` : skillRefs
  }

  // Add image references
  if (queuedMsg.pendingImages.length > 0) {
    const imageRefs = queuedMsg.pendingImages
      .map(img => `[Image attached: ${img.path} - Use the Read tool to view this image]`)
      .join('\n')
    message = message ? `${message}\n\n${imageRefs}` : imageRefs
  }

  // Add text file references
  if (queuedMsg.pendingTextFiles.length > 0) {
    const textFileRefs = queuedMsg.pendingTextFiles
      .map(tf => `[Text file attached: ${tf.path} - Use the Read tool to view this file]`)
      .join('\n')
    message = message ? `${message}\n\n${textFileRefs}` : textFileRefs
  }

  return message
}

/**
 * Global queue processor hook - must be at App level so it stays active
 * even when ChatWindow is unmounted (e.g., when viewing session board or different worktree)
 *
 * Processes queued messages for ALL sessions, not just the active one.
 * This fixes the bug where queued prompts don't execute when the worktree is unfocused.
 */
export function useQueueProcessor(): void {
  const sendMessage = useSendMessage()
  const { data: preferences } = usePreferences()

  // Track which sessions we're currently processing to prevent race conditions
  const processingRef = useRef<Set<string>>(new Set())

  // Subscribe to queue-related state changes
  const messageQueues = useChatStore(state => state.messageQueues)
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const waitingForInputSessionIds = useChatStore(
    state => state.waitingForInputSessionIds
  )

  useEffect(() => {
    if (!isTauri()) return

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

      // Get worktree info for this session
      const {
        sessionWorktreeMap,
        worktreePaths,
        dequeueMessage,
        addSendingSession,
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSelectedModel,
        getApprovedTools,
        clearStreamingContent,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()

      const worktreeId = sessionWorktreeMap[sessionId]
      const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined

      // Skip if we can't find the worktree for this session
      if (!worktreeId || !worktreePath) {
        logger.warn('Queue processor: Cannot find worktree for session', {
          sessionId,
        })
        continue
      }

      // Mark as processing to prevent duplicate processing
      processingRef.current.add(sessionId)

      // Dequeue the message
      const queuedMsg = dequeueMessage(sessionId)
      if (!queuedMsg) {
        processingRef.current.delete(sessionId)
        continue
      }

      logger.info('Queue processor: Processing queued message', {
        sessionId,
        worktreeId,
        messageId: queuedMsg.id,
      })

      // Clear stale streaming state before starting new message
      clearStreamingContent(sessionId)
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)

      // Set up session state
      setLastSentMessage(sessionId, queuedMsg.message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setExecutingMode(sessionId, queuedMsg.executionMode)
      setSelectedModel(sessionId, queuedMsg.model)

      // Get session-approved tools
      const sessionApprovedTools = getApprovedTools(sessionId)
      const allowedTools =
        sessionApprovedTools.length > 0
          ? [...GIT_ALLOWED_TOOLS, ...sessionApprovedTools]
          : undefined

      // Build full message with attachment refs
      const fullMessage = buildMessageWithRefs(queuedMsg)

      // Send the message
      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message: fullMessage,
          provider: queuedMsg.provider,
          model: queuedMsg.model,
          executionMode: queuedMsg.executionMode,
          thinkingLevel: queuedMsg.thinkingLevel,
          disableThinkingForMode: queuedMsg.disableThinkingForMode,
          parallelExecutionPromptEnabled:
            preferences?.parallel_execution_prompt_enabled ?? false,
          allowedTools,
        },
        {
          onSettled: () => {
            // Clear processing flag when done
            processingRef.current.delete(sessionId)
          },
        }
      )
    }
  }, [
    messageQueues,
    sendingSessionIds,
    waitingForInputSessionIds,
    sendMessage,
    preferences?.parallel_execution_prompt_enabled,
  ])
}
