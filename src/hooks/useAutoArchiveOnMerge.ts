/**
 * Auto-archive worktrees when their PR is merged.
 *
 * Listens for PR status updates and archives worktrees automatically
 * when their associated PR is merged, if the preference is enabled.
 */

import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { usePreferences } from '@/services/preferences'
import { usePrStatusEvents } from '@/services/pr-status'
import { projectsQueryKeys, isTauri } from '@/services/projects'
import type { PrStatusEvent } from '@/types/pr-status'
import type { Worktree } from '@/types/projects'

/**
 * Hook that auto-archives worktrees when their PR is merged.
 *
 * Must be mounted at the app root level to listen for all PR status events.
 */
export function useAutoArchiveOnMerge() {
  const { data: preferences } = usePreferences()
  const queryClient = useQueryClient()

  // Track which worktrees we've already processed to avoid duplicate archives
  const processedWorktrees = useRef(new Set<string>())

  const handlePrStatusUpdate = useCallback(
    async (status: PrStatusEvent) => {
      // Check if the feature is enabled
      if (!preferences?.auto_archive_on_pr_merged) {
        return
      }

      // Only act on merged PRs
      if (status.display_status !== 'merged') {
        return
      }

      // Avoid processing the same worktree multiple times
      if (processedWorktrees.current.has(status.worktree_id)) {
        return
      }

      // Mark as processed immediately to prevent race conditions
      processedWorktrees.current.add(status.worktree_id)

      try {
        // Check if worktree is already archived by looking at cached data
        // We need to find the project ID first
        const projectsData = queryClient.getQueryData<
          { id: string; path: string }[]
        >(projectsQueryKeys.list())

        if (!projectsData) {
          return
        }

        // Locate the worktree in cached project data (sync scan only)
        let match:
          | { projectId: string; projectPath: string; worktree: Worktree }
          | undefined
        for (const project of projectsData) {
          const worktrees = queryClient.getQueryData<Worktree[]>(
            projectsQueryKeys.worktrees(project.id)
          )
          const worktree = worktrees?.find(w => w.id === status.worktree_id)
          if (worktree) {
            match = {
              projectId: project.id,
              projectPath: project.path,
              worktree,
            }
            break
          }
        }

        if (!match) {
          return
        }

        const { projectId, projectPath, worktree } = match

        // Skip if already archived
        if (worktree.archived_at) {
          logger.debug('Worktree already archived, skipping auto-archive', {
            worktreeId: status.worktree_id,
          })
          return
        }

        // Base sessions use the project path directly. When a linked PR is
        // merged, clean up only the PR association so the base session stays open.
        if (worktree.session_type === 'base' || worktree.path === projectPath) {
          logger.info('Clearing merged PR from base session', {
            worktreeId: status.worktree_id,
            prNumber: status.pr_number,
          })

          await invoke('clear_worktree_pr', {
            worktreeId: status.worktree_id,
          })

          queryClient.invalidateQueries({
            queryKey: projectsQueryKeys.worktrees(projectId),
          })

          toast.success(
            `Cleaned up PR #${status.pr_number} from base session "${worktree.name}"`
          )

          return
        }

        // Archive or delete the worktree based on removal_behavior preference
        const shouldDelete = preferences?.removal_behavior === 'delete'
        const action = shouldDelete ? 'Deleting' : 'Archiving'
        logger.info(`Auto-${action.toLowerCase()} worktree (PR merged)`, {
          worktreeId: status.worktree_id,
          prNumber: status.pr_number,
        })

        await invoke(shouldDelete ? 'delete_worktree' : 'archive_worktree', {
          worktreeId: status.worktree_id,
        })

        // Invalidate worktrees query to refresh the list
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })

        // Show toast notification
        const pastAction = shouldDelete ? 'Deleted' : 'Archived'
        toast.success(
          `${pastAction} "${worktree.name}" (PR #${status.pr_number} merged)`
        )
      } catch (error) {
        logger.error('Failed to auto-archive worktree', {
          worktreeId: status.worktree_id,
          error,
        })
        // Remove from processed set so we can retry
        processedWorktrees.current.delete(status.worktree_id)
      }
    },
    [
      preferences?.auto_archive_on_pr_merged,
      preferences?.removal_behavior,
      queryClient,
    ]
  )

  // Listen for PR status updates
  usePrStatusEvents(isTauri() ? handlePrStatusUpdate : undefined)
}
