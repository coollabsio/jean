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
 * Hide the original planning session after its plan was forwarded to a new
 * session (Clear context / new worktree approval).
 *
 * Always archives instead of honoring `removal_behavior: 'delete'`: the
 * planning conversation is still useful history and must stay restorable
 * from archived sessions (issue #795). A toast with a Restore action tells
 * the user where the planning conversation went.
 */
export function archiveOriginalPlanSession({
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

  // cancel_process_if_running (used by archive) safely skips idle sessions,
  // and with_sessions_mut uses a per-worktree mutex so there's no file-level race.
  const invalidateSessions = () =>
    queryClient.invalidateQueries({
      queryKey: chatQueryKeys.sessions(worktreeId),
    })

  invoke('archive_session', { worktreeId, worktreePath, sessionId })
    .then(() => {
      invalidateSessions()
      toast('Planning session archived', {
        action: {
          label: 'Restore',
          onClick: () => {
            invoke('unarchive_session', { worktreeId, worktreePath, sessionId })
              .then(() => {
                invalidateSessions()
                toast.success('Session restored')
              })
              .catch(err =>
                toast.error('Failed to restore session', {
                  description: String(err),
                })
              )
          },
        },
      })
    })
    .catch(err =>
      console.error('[plan-approval] Failed to archive original session:', err)
    )
}
