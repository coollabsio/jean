import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { chatQueryKeys } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import type { WorktreeSessions } from '@/types/chat'

/**
 * Clear transient streaming/approval state before sending an execution turn.
 *
 * The approved plan remains visible in the persisted assistant message. Keeping
 * the in-memory plan tool/content blocks here causes the next build/yolo tool
 * stream to append into the previous planning timeline.
 */
export function clearPlanApprovalTransientState(sessionId: string) {
  const store = useChatStore.getState()
  store.clearToolCalls(sessionId)
  store.clearStreamingContentBlocks(sessionId)
  store.setSessionReviewing(sessionId, false)
  store.setWaitingForInput(sessionId, false)
  store.setPendingPlanMessageId(sessionId, null)
}

/**
 * Close the original planning session after its plan was forwarded to a new
 * session (Clear context / new worktree approval). `close_session` soft-deletes
 * it; the backend purges deleted sessions after 30 days.
 */
export function closeOriginalPlanSession({
  queryClient,
  worktreeId,
  worktreePath,
  sessionId,
  replacementSessionId,
}: {
  queryClient: QueryClient
  worktreeId: string
  worktreePath: string
  sessionId: string
  /** New active session when the original was active in the same worktree. */
  replacementSessionId?: string
}) {
  // Optimistically remove from UI immediately
  queryClient.setQueryData<WorktreeSessions>(
    chatQueryKeys.sessions(worktreeId),
    old => {
      if (!old) return old
      return {
        ...old,
        sessions: old.sessions.filter(s => s.id !== sessionId),
        active_session_id:
          replacementSessionId && old.active_session_id === sessionId
            ? replacementSessionId
            : old.active_session_id,
      }
    }
  )

  invoke('close_session', { worktreeId, worktreePath, sessionId })
    .then(() => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })
      toast('Planning session closed')
    })
    .catch(err =>
      console.error('[plan-approval] Failed to close original session:', err)
    )
}
