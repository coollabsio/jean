import { useCallback } from 'react'
import { useArchiveSession, useCloseSession } from '@/services/chat'
import type { RemovalBehavior } from '@/types/preferences'

interface UseSessionArchiveParams {
  worktreeId: string
  worktreePath: string
  removalBehavior?: RemovalBehavior
}

/**
 * Provides archive and delete handlers for sessions.
 *
 * When the last session is removed, the backend automatically creates a
 * fallback "Session 1" and the service layer switches to it via query
 * invalidation — no navigation needed.
 *
 * - handleArchiveSession: always archives (context menu "Archive Session")
 * - handleDeleteSession: respects removalBehavior preference (context menu "Delete Session")
 *   - 'archive' (default): archives session
 *   - 'delete': permanently deletes session
 */
export function useSessionArchive({
  worktreeId,
  worktreePath,
  removalBehavior = 'archive',
}: UseSessionArchiveParams) {
  const archiveSession = useArchiveSession()
  const closeSession = useCloseSession()

  // Always archives — used by context menu "Archive Session"
  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      archiveSession.mutate({
        worktreeId,
        worktreePath,
        sessionId,
      })
    },
    [worktreeId, worktreePath, archiveSession]
  )

  // Respects removalBehavior preference — used by context menu "Delete Session"
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
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
    },
    [worktreeId, worktreePath, removalBehavior, closeSession, archiveSession]
  )

  return { handleArchiveSession, handleDeleteSession }
}
