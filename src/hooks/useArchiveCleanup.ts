import { useEffect, useRef } from 'react'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { usePreferences } from '@/services/preferences'
import { logger } from '@/lib/logger'
import { isTauri } from '@/services/projects'

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
  deleted_contexts?: number
}

/**
 * Hook to automatically clean up old archived items on app startup.
 *
 * Runs cleanup based on the archive_retention_days preference.
 * Set to 0 to disable automatic cleanup.
 */
export function useArchiveCleanup() {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const hasRunRef = useRef(false)

  useEffect(() => {
    // Only run once on startup, and only when preferences are loaded
    if (!preferences || hasRunRef.current || !isTauri()) {
      return
    }

    // Mark as run to prevent re-running
    hasRunRef.current = true

    // If retention is 0, cleanup is disabled
    if (preferences.archive_retention_days === 0) {
      logger.debug('Archive cleanup is disabled (retention_days = 0)')
      return
    }

    const runCleanup = async () => {
      try {
        logger.info('Running archive cleanup', {
          retentionDays: preferences.archive_retention_days,
        })

        const result = await invoke<CleanupResult>('cleanup_old_archives', {
          retentionDays: preferences.archive_retention_days,
        })

        const deletedContexts = result.deleted_contexts ?? 0

        if (
          result.deleted_worktrees > 0 ||
          result.deleted_sessions > 0 ||
          deletedContexts > 0
        ) {
          // Invalidate archive queries to refresh UI
          queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
          queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

          // Show toast notification
          const parts: string[] = []
          if (result.deleted_worktrees > 0) {
            parts.push(
              `${result.deleted_worktrees} worktree${result.deleted_worktrees === 1 ? '' : 's'}`
            )
          }
          if (result.deleted_sessions > 0) {
            parts.push(
              `${result.deleted_sessions} session${result.deleted_sessions === 1 ? '' : 's'}`
            )
          }
          if (deletedContexts > 0) {
            parts.push(
              `${deletedContexts} context${deletedContexts === 1 ? '' : 's'}`
            )
          }

          toast.info(`Cleaned up ${parts.join(' and ')} from archive`, {
            description: `Archives older than ${preferences.archive_retention_days} days`,
          })

          logger.info('Archive cleanup complete', {
            deleted_worktrees: result.deleted_worktrees,
            deleted_sessions: result.deleted_sessions,
            deleted_contexts: deletedContexts,
          })
        } else {
          logger.debug('No old archives to clean up')
        }
      } catch (error) {
        logger.error('Archive cleanup failed', { error: String(error) })
        // Don't show error toast - cleanup failure is not critical
      }
    }

    runCleanup()
  }, [preferences, queryClient])
}
