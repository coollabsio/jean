import { useCallback } from 'react'
import { useArchiveSession, useCloseSession } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import type { Session } from '@/types/chat'
import type { RemovalBehavior } from '@/types/preferences'

interface UseSessionArchiveParams {
  worktreeId: string
  worktreePath: string
  sessions: Session[] | undefined
  removalBehavior?: RemovalBehavior
  /** Called when the last session is deleted/archived.
   *  When provided, the worktree is closed instead of creating a fresh fallback session.
   *  The individual session mutation is skipped — the worktree close handles cleanup. */
  onLastSessionDeleted?: () => void
}

/**
 * Provides archive and delete handlers for sessions.
 *
 * When `onLastSessionDeleted` is provided and the last session is removed,
 * the callback fires (typically closing the worktree) instead of navigating
 * to canvas and letting Rust auto-create a fallback session.
 *
 * - handleArchiveSession: always archives (context menu "Archive Session")
 * - handleDeleteSession: respects removalBehavior preference (context menu "Delete Session")
 *   - 'archive' (default): archives session
 *   - 'delete': permanently deletes session
 */
export function useSessionArchive({
  worktreeId,
  worktreePath,
  sessions,
  removalBehavior = 'archive',
  onLastSessionDeleted,
}: UseSessionArchiveParams) {
  const archiveSession = useArchiveSession()
  const closeSession = useCloseSession()

  const navigateToCanvas = useCallback(() => {
    useChatStore.getState().clearActiveWorktree()
  }, [])

  // Always archives — used by context menu "Archive Session"
  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      const activeSessions = sessions?.filter(s => !s.archived_at) ?? []
      const isLastSession = activeSessions.length <= 1

      if (isLastSession && onLastSessionDeleted) {
        onLastSessionDeleted()
        return
      }

      archiveSession.mutate({
        worktreeId,
        worktreePath,
        sessionId,
      })

      if (isLastSession) {
        navigateToCanvas()
      }
    },
    [sessions, worktreeId, worktreePath, archiveSession, navigateToCanvas, onLastSessionDeleted]
  )

  // Respects removalBehavior preference — used by context menu "Delete Session"
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const activeSessions = sessions?.filter(s => !s.archived_at) ?? []
      const isLastSession = activeSessions.length <= 1

      if (isLastSession && onLastSessionDeleted) {
        onLastSessionDeleted()
        return
      }

      if (removalBehavior === 'delete') {
        closeSession.mutate({
          worktreeId,
          worktreePath,
          sessionId,
        })
      } else {
        archiveSession.mutate({
          worktreeId,
          worktreePath,
          sessionId,
        })
      }

      if (isLastSession) {
        navigateToCanvas()
      }
    },
    [
      sessions,
      worktreeId,
      worktreePath,
      removalBehavior,
      closeSession,
      archiveSession,
      navigateToCanvas,
      onLastSessionDeleted,
    ]
  )

  return { handleArchiveSession, handleDeleteSession }
}
