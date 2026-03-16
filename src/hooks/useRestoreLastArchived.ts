import { useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useUnarchiveWorktree } from '@/services/projects'
import { useUnarchiveSession, chatQueryKeys } from '@/services/chat'
import { invoke } from '@/lib/transport'
import { isTauri } from '@/services/projects'
import { logger } from '@/lib/logger'
import {
  isOnCanvasView,
  navigateToRestoredItem,
} from '@/lib/restore-navigation'
import type { Worktree } from '@/types/projects'
import type { ArchivedSessionEntry } from '@/types/chat'

type ArchivedItem =
  | { type: 'worktree'; worktree: Worktree }
  | { type: 'session'; entry: ArchivedSessionEntry }

/**
 * Hook to handle CMD+SHIFT+T keybinding for restoring the most recently archived item.
 * Similar to browser tab restore functionality.
 *
 * Fetches fresh archived data on each invocation (not from stale closure) to ensure
 * recently archived items are always found.
 */
export function useRestoreLastArchived() {
  const queryClient = useQueryClient()

  // Mutations
  const unarchiveWorktree = useUnarchiveWorktree()
  const unarchiveSession = useUnarchiveSession()

  const restoreLastArchived = useCallback(async () => {
    if (!isTauri()) return

    // Block restore from chat view — only allowed from canvas views
    if (!isOnCanvasView()) {
      toast.info('Switch to canvas view to restore')
      return
    }

    // Fetch fresh data at invocation time to avoid stale closure issues
    const [archivedWorktrees, archivedSessions] = await Promise.all([
      queryClient.fetchQuery({
        queryKey: ['archived-worktrees'],
        queryFn: () => invoke<Worktree[]>('list_archived_worktrees'),
        staleTime: 0,
      }),
      queryClient.fetchQuery({
        queryKey: ['all-archived-sessions'],
        queryFn: () =>
          invoke<ArchivedSessionEntry[]>('list_all_archived_sessions'),
        staleTime: 0,
      }),
    ])

    // Combine all archived items and sort by archived_at descending
    const items: ArchivedItem[] = []

    for (const worktree of archivedWorktrees) {
      items.push({ type: 'worktree', worktree })
    }
    for (const entry of archivedSessions) {
      items.push({ type: 'session', entry })
    }

    if (items.length === 0) {
      toast.info('No archived items to restore')
      return
    }

    // Sort by archived_at descending (most recent first)
    items.sort((a, b) => {
      const aTime =
        a.type === 'worktree'
          ? a.worktree.archived_at
          : a.entry.session.archived_at
      const bTime =
        b.type === 'worktree'
          ? b.worktree.archived_at
          : b.entry.session.archived_at
      return (bTime ?? 0) - (aTime ?? 0)
    })

    const mostRecent = items[0]
    if (!mostRecent) {
      toast.info('No archived items to restore')
      return
    }

    if (mostRecent.type === 'worktree') {
      const { worktree } = mostRecent
      logger.info('Restoring last archived worktree', {
        worktreeId: worktree.id,
      })

      unarchiveWorktree.mutate(worktree.id, {
        onSuccess: () => {
          navigateToRestoredItem(worktree.id, worktree.path)
          toast.success(`Restored worktree: ${worktree.name}`)
          logger.info('Restored worktree via CMD+SHIFT+T', {
            worktree: worktree.name,
          })
        },
      })
    } else {
      const { entry } = mostRecent
      logger.info('Restoring last archived session', {
        sessionId: entry.session.id,
        worktreeId: entry.worktree_id,
      })

      // Check if the worktree is also archived - if so, restore it first
      const worktreeIsArchived = archivedWorktrees.some(
        w => w.id === entry.worktree_id
      )

      const restoreSessionOnly = () => {
        unarchiveSession.mutate(
          {
            worktreeId: entry.worktree_id,
            worktreePath: entry.worktree_path,
            sessionId: entry.session.id,
          },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({
                queryKey: ['all-archived-sessions'],
              })
              queryClient.invalidateQueries({
                queryKey: chatQueryKeys.sessions(entry.worktree_id),
              })

              navigateToRestoredItem(
                entry.worktree_id,
                entry.worktree_path,
                entry.session.id
              )
              toast.success(`Restored session: ${entry.session.name}`)
              logger.info('Restored session via CMD+SHIFT+T', {
                session: entry.session.name,
              })
            },
          }
        )
      }

      if (worktreeIsArchived) {
        unarchiveWorktree.mutate(entry.worktree_id, {
          onSuccess: () => {
            restoreSessionOnly()
          },
        })
      } else {
        restoreSessionOnly()
      }
    }
  }, [queryClient, unarchiveWorktree, unarchiveSession])

  useEffect(() => {
    const handleRestoreLastArchived = () => {
      restoreLastArchived()
    }

    window.addEventListener('restore-last-archived', handleRestoreLastArchived)

    return () => {
      window.removeEventListener(
        'restore-last-archived',
        handleRestoreLastArchived
      )
    }
  }, [restoreLastArchived])
}
