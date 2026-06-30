import { useCallback } from 'react'
import {
  cancelChatMessage,
  persistMoveQueuedFront,
  persistRemoveQueued,
  persistUpdateQueued,
  steerCodexTurn,
  steerOpencodeTurn,
  steerPiTurn,
} from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { logger } from '@/lib/logger'
import type { QueuedMessage } from '@/types/chat'

function resolveWorktree(sessionId: string) {
  const { sessionWorktreeMap, worktreePaths } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined
  return { worktreeId, worktreePath }
}

function hasAttachments(msg: QueuedMessage): boolean {
  return (
    msg.pendingImages.length > 0 ||
    msg.pendingFiles.length > 0 ||
    msg.pendingSkills.length > 0 ||
    msg.pendingTextFiles.length > 0
  )
}

function supportsSteering(msg: QueuedMessage): boolean {
  const backend = msg.backend ?? 'claude'
  if (backend === 'codex') return true
  return (backend === 'opencode' || backend === 'pi') && !hasAttachments(msg)
}

/**
 * Actions for the queued prompts panel: remove a queued prompt, or send a
 * specific queued prompt immediately.
 *
 * "Send now" is backend-aware:
 * - Idle session: promote the message to the queue front and let the queue
 *   processor send it (reuses the existing atomic dequeue + send path).
 * - Busy Codex/Pi session: inject the text into the running turn via the
 *   backend steering API. Falls back to cancel+send when the turn already
 *   ended or the message has attachments.
 * - Busy other backends: promote to front, cancel the current run — the
 *   queue processor auto-sends the promoted message once the session is idle.
 */
export function useQueuedPromptActions() {
  const handleRemoveQueuedMessage = useCallback(
    (sessionId: string, messageId: string) => {
      useChatStore.getState().removeQueuedMessage(sessionId, messageId)
      // Persist removal to backend for cross-client sync
      const { worktreeId, worktreePath } = resolveWorktree(sessionId)
      if (worktreeId && worktreePath) {
        persistRemoveQueued(worktreeId, worktreePath, sessionId, messageId)
      }
    },
    []
  )

  const handleEditQueuedMessage = useCallback(
    async (sessionId: string, messageId: string, message: string) => {
      const trimmed = message.trim()
      if (!trimmed) return

      const store = useChatStore.getState()
      const msg = store
        .getQueuedMessages(sessionId)
        .find(m => m.id === messageId)
      if (!msg || supportsSteering(msg)) return

      const { worktreeId, worktreePath } = resolveWorktree(sessionId)
      if (!worktreeId || !worktreePath) return

      try {
        const updated = await persistUpdateQueued(
          worktreeId,
          worktreePath,
          sessionId,
          messageId,
          trimmed
        )
        if (!updated) {
          // Another client already dequeued it — drop the stale local copy.
          store.removeQueuedMessage(sessionId, messageId)
          return
        }
        store.updateQueuedMessage(sessionId, messageId, trimmed)
      } catch (error) {
        logger.error('Failed to persist queued edit', {
          error,
          sessionId,
          messageId,
        })
      }
    },
    []
  )

  const handleSendQueuedNow = useCallback(
    async (sessionId: string, messageId: string) => {
      const store = useChatStore.getState()
      const { worktreeId, worktreePath } = resolveWorktree(sessionId)
      if (!worktreeId || !worktreePath) return

      const msg = store
        .getQueuedMessages(sessionId)
        .find(m => m.id === messageId)
      if (!msg) return

      const isSending = !!store.sendingSessionIds[sessionId]
      const isWaiting = !!store.waitingForInputSessionIds[sessionId]

      // Idle session: promote + force-process so the queue processor sends it.
      if (!isSending && !isWaiting) {
        const moved = await persistMoveQueuedFront(
          worktreeId,
          worktreePath,
          sessionId,
          messageId
        )
        if (moved) {
          store.moveQueuedMessageFront(sessionId, messageId)
          store.forceProcessQueue(sessionId)
        }
        return
      }

      // Busy Codex/OpenCode/Pi session: steer the running turn. Codex accepts
      // structured attachment input; other backends still use text-only steer.
      const backend = store.selectedBackends[sessionId] ?? 'claude'
      if (
        (backend === 'codex' || backend === 'opencode' || backend === 'pi') &&
        isSending &&
        (backend === 'codex' || !hasAttachments(msg))
      ) {
        try {
          if (backend === 'pi') {
            await steerPiTurn(worktreeId, sessionId, msg.message)
          } else if (backend === 'opencode') {
            await steerOpencodeTurn(
              worktreeId,
              worktreePath,
              sessionId,
              msg.message
            )
          } else if (hasAttachments(msg)) {
            await steerCodexTurn(worktreeId, sessionId, msg.message, msg)
          } else {
            await steerCodexTurn(worktreeId, sessionId, msg.message)
          }
          handleRemoveQueuedMessage(sessionId, messageId)
          return
        } catch (error) {
          // Turn ended / not started yet — fall through to cancel+send
          logger.debug(`${backend} steer failed, falling back to cancel+send`, {
            error,
            sessionId,
          })
        }
      }

      // Busy (other backends / steer failed): promote, then cancel. The queue
      // processor picks up the promoted head once the cancellation clears the
      // sending state. Abort if another client already dequeued the message.
      const moved = await persistMoveQueuedFront(
        worktreeId,
        worktreePath,
        sessionId,
        messageId
      )
      if (!moved) return
      useChatStore.getState().moveQueuedMessageFront(sessionId, messageId)

      if (useChatStore.getState().sendingSessionIds[sessionId]) {
        await cancelChatMessage(sessionId, worktreeId)
      } else {
        // Only waiting for input (plan approval / question) — skip the wait.
        useChatStore.getState().forceProcessQueue(sessionId)
      }
    },
    [handleRemoveQueuedMessage]
  )

  return {
    handleRemoveQueuedMessage,
    handleEditQueuedMessage,
    handleSendQueuedNow,
  }
}
