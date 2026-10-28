import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import {
  cancelChatMessage,
  persistMoveQueuedFront,
  persistRemoveQueued,
  persistUpdateQueued,
  steerCodexTurn,
  steerGrokTurn,
  steerOpencodeTurn,
  steerPiTurn,
  steerClaudeTurn,
} from '@/services/chat'
import { preferencesQueryKeys } from '@/services/preferences'
import { queryClient } from '@/lib/query-client'
import { parseServerResourceKey } from '@/lib/server-resource'
import { isSteerCapableBackend } from '@/lib/backend-auto-steer'
import type { AppPreferences } from '@/types/preferences'
import { buildMessageWithRefs } from '@/components/chat/message-with-refs'
import { useChatStore } from '@/store/chat-store'
import { logger } from '@/lib/logger'
import type { QueuedMessage, QueuedMessageEdit } from '@/types/chat'

function resolveWorktree(sessionId: string) {
  const { sessionWorktreeMap, worktreePaths } = useChatStore.getState()
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : undefined
  return { worktreeId, worktreePath }
}

/**
 * Any attachment kind serializes to a path ref via buildMessageWithRefs, so
 * text-only mid-turn steer (Grok/Pi/OpenCode) can carry all of them. Codex
 * also accepts structured attachment input when present.
 */
function hasAttachments(msg: QueuedMessage): boolean {
  return (
    msg.pendingImages.length > 0 ||
    msg.pendingFiles.length > 0 ||
    msg.pendingSkills.length > 0 ||
    msg.pendingTextFiles.length > 0
  )
}

function clearComposer(sessionId: string) {
  const store = useChatStore.getState()
  store.clearInputDraft(sessionId)
  store.clearPendingImages(sessionId)
  store.clearPendingFiles(sessionId)
  store.clearPendingSkills(sessionId)
  store.clearPendingTextFiles(sessionId)
}

/**
 * Save the composer content into the queued message being edited, keeping its
 * queue position. Returns true when saved; the caller then clears the
 * composer. When the message was already sent, the edit stays in the composer
 * so the user can send it as a new prompt.
 */
export async function saveQueuedMessageEdit(
  sessionId: string,
  messageId: string,
  edit: QueuedMessageEdit
): Promise<boolean> {
  const { worktreeId, worktreePath } = resolveWorktree(sessionId)
  if (!worktreeId || !worktreePath) return false

  const store = useChatStore.getState()
  try {
    const updated = await persistUpdateQueued(
      worktreeId,
      worktreePath,
      sessionId,
      messageId,
      edit
    )
    if (!updated) {
      // Another client or the queue drain already dequeued it.
      store.removeQueuedMessage(sessionId, messageId)
      if (store.editingQueuedMessageIds[sessionId] === messageId) {
        store.stopEditingQueuedMessage(sessionId)
        toast.error(QUEUED_EDIT_LOST_MESSAGE)
      }
      return false
    }
    store.updateQueuedMessage(sessionId, messageId, edit)
    store.stopEditingQueuedMessage(sessionId)
    return true
  } catch (error) {
    logger.error('Failed to persist queued edit', {
      error,
      sessionId,
      messageId,
    })
    toast.error(`Failed to save queued prompt: ${error}`)
    return false
  }
}

const QUEUED_EDIT_LOST_MESSAGE =
  'The queued prompt was sent before you saved. Your edit stays in the input.'

/**
 * Actions for the queued prompts panel: remove a queued prompt, edit it in the
 * composer, or send a specific queued prompt immediately.
 *
 * "Send now" is backend-aware:
 * - Idle session: promote the message to the queue front and let the queue
 *   processor send it (reuses the existing atomic dequeue + send path).
 * - Busy steer-capable session (Codex/OpenCode/Pi/Grok, or Claude when its
 *   steer setting is on): inject the text into the running turn via the
 *   backend steering API. Falls back to cancel+send when steering fails.
 * - Busy other backends: promote to front, cancel the current run — the
 *   queue processor auto-sends the promoted message once the session is idle.
 */
export function useQueuedPromptActions(sessionId: string | null | undefined) {
  // Drop the edit state when the edited prompt leaves the queue (auto-sent,
  // steered, or removed by another client). The composer keeps the edit.
  const editingQueuedId = useChatStore(state =>
    sessionId ? state.editingQueuedMessageIds[sessionId] : undefined
  )
  const isEditingStillQueued = useChatStore(
    state =>
      !sessionId ||
      !editingQueuedId ||
      !!state.messageQueues[sessionId]?.some(m => m.id === editingQueuedId)
  )
  useEffect(() => {
    if (!sessionId || isEditingStillQueued) return
    useChatStore.getState().stopEditingQueuedMessage(sessionId)
    toast.error(QUEUED_EDIT_LOST_MESSAGE)
  }, [sessionId, isEditingStillQueued])

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
    (sessionId: string, messageId: string) => {
      const store = useChatStore.getState()
      const msg = store
        .getQueuedMessages(sessionId)
        .find(m => m.id === messageId)
      if (!msg) return

      const hasComposerContent =
        !!store.inputDrafts[sessionId]?.trim() ||
        store.getPendingImages(sessionId).length > 0 ||
        store.getPendingFiles(sessionId).length > 0 ||
        store.getPendingSkills(sessionId).length > 0 ||
        store.getPendingTextFiles(sessionId).length > 0
      if (hasComposerContent && !store.editingQueuedMessageIds[sessionId]) {
        toast.error(
          'Send or clear the current input before you edit a queued prompt.'
        )
        return
      }

      clearComposer(sessionId)
      store.startEditingQueuedMessage(sessionId, msg)
      window.dispatchEvent(new CustomEvent('command:focus-chat-input'))
    },
    []
  )

  const handleCancelQueuedEdit = useCallback((sessionId: string) => {
    useChatStore.getState().stopEditingQueuedMessage(sessionId)
    clearComposer(sessionId)
  }, [])

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

      // Busy steer-capable session (Codex/OpenCode/Pi/Grok, Claude when its
      // steer setting is on): steer the running turn. All attachments become
      // path refs via buildMessageWithRefs; Codex also gets structured
      // attachment input when present. A prompt queued for a different
      // backend is never steered into this run.
      const backend = store.selectedBackends[sessionId] ?? 'claude'
      const preferences = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences(
          parseServerResourceKey(worktreeId)?.serverId
        )
      )
      const backendMatches = !msg.backend || msg.backend === backend
      if (
        backendMatches &&
        isSteerCapableBackend(backend, preferences) &&
        isSending
      ) {
        try {
          const steerMessage = buildMessageWithRefs(msg)
          if (backend === 'pi') {
            await steerPiTurn(worktreeId, sessionId, steerMessage)
          } else if (backend === 'claude') {
            await steerClaudeTurn(worktreeId, sessionId, steerMessage)
          } else if (backend === 'grok') {
            await steerGrokTurn(worktreeId, sessionId, steerMessage)
          } else if (backend === 'opencode') {
            await steerOpencodeTurn(
              worktreeId,
              worktreePath,
              sessionId,
              steerMessage
            )
          } else if (hasAttachments(msg)) {
            await steerCodexTurn(worktreeId, sessionId, steerMessage, msg)
          } else {
            await steerCodexTurn(worktreeId, sessionId, steerMessage)
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
    handleCancelQueuedEdit,
    handleSendQueuedNow,
  }
}
