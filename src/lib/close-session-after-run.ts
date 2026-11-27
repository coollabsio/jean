import { toast } from 'sonner'
import { listen } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import type { DoneEvent } from '@/types/chat'
import {
  closeSessionWithUndo,
  type CloseSessionActions,
  type CloseSessionTarget,
} from '@/lib/close-session-toast-action'

/** Sessions that close when their current run ends, with their cleanup. */
const pendingCloses = new Map<string, () => boolean>()

/**
 * Close the session when its current run ends normally (for example "Commit
 * This Session"). An error, a cancel, a plan that waits for approval, or a
 * queued message keeps the session open.
 */
export function closeSessionAfterRun(
  target: CloseSessionTarget,
  actions: CloseSessionActions
): void {
  const { sessionId } = target
  pendingCloses.get(sessionId)?.()

  const unlisteners: Promise<() => void>[] = []
  let unsubscribeStore: (() => void) | null = null
  /** Returns false when this request already ended. */
  const cleanup = () => {
    if (pendingCloses.get(sessionId) !== cleanup) return false
    pendingCloses.delete(sessionId)
    unsubscribeStore?.()
    for (const unlisten of unlisteners) void unlisten.then(fn => fn())
    return true
  }
  pendingCloses.set(sessionId, cleanup)

  const isSending = () =>
    Boolean(useChatStore.getState().sendingSessionIds[sessionId])

  const finish = () => {
    if (!cleanup()) return
    if (useChatStore.getState().messageQueues[sessionId]?.length) {
      toast.info('Queued messages remain. The session stays open.')
      return
    }
    // Reports "Session is busy" when the run waits for an answer.
    closeSessionWithUndo(target, actions)
  }

  unlisteners.push(
    listen<DoneEvent>('chat:done', event => {
      if (event.payload.session_id !== sessionId) return
      if (event.payload.waiting_for_plan) {
        cleanup()
        return
      }
      // Other `chat:done` listeners clear the run state; close after them.
      if (!isSending()) {
        finish()
        return
      }
      unsubscribeStore = useChatStore.subscribe(() => {
        if (!isSending()) finish()
      })
    })
  )
  for (const event of ['chat:error', 'chat:cancelled']) {
    unlisteners.push(
      listen<{ session_id: string }>(event, ({ payload }) => {
        if (payload.session_id === sessionId) cleanup()
      })
    )
  }
}
