/**
 * Syncs all worktrees with open PRs to the backend for sweep polling.
 *
 * The backend polls these worktrees round-robin at a slow interval (5 min)
 * to detect PR merges even when the worktree isn't actively selected on the canvas.
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  setPrWorktreesForPolling,
  setAllWorktreesForPolling,
} from '@/services/git-status'
import { projectsQueryKeys, isTauri } from '@/services/projects'
import type { Project, Worktree } from '@/types/projects'

/** Keep local Git polling useful for recently used worktrees without waking
 * every clean inactive repository on the normal sweep cadence. */
export const RECENT_WORKTREE_ACTIVITY_SECS = 24 * 60 * 60

function hasPositiveCachedCount(value: number | undefined): boolean {
  return (value ?? 0) > 0
}

/** Decide whether an inactive worktree still needs the global Git sweep. */
export function shouldIncludeInGitSweep(
  worktree: Pick<
    Worktree,
    | 'pr_number'
    | 'pr_url'
    | 'cached_status_at'
    | 'cached_uncommitted_added'
    | 'cached_uncommitted_removed'
    | 'cached_unpushed_count'
    | 'cached_worktree_ahead_count'
    | 'last_opened_at'
  >,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (worktree.pr_number && worktree.pr_url) return true
  if (worktree.cached_status_at == null) return true

  const recentlyOpened =
    worktree.last_opened_at != null &&
    now - worktree.last_opened_at <= RECENT_WORKTREE_ACTIVITY_SECS
  const hasLocalChanges =
    hasPositiveCachedCount(worktree.cached_uncommitted_added) ||
    hasPositiveCachedCount(worktree.cached_uncommitted_removed) ||
    hasPositiveCachedCount(worktree.cached_unpushed_count) ||
    hasPositiveCachedCount(worktree.cached_worktree_ahead_count)

  return recentlyOpened || hasLocalChanges
}

/** Resolve the base branch used for git status sweep of one worktree. */
export function resolveSweepBaseBranch(
  worktree: Pick<Worktree, 'base_branch'>,
  project: Pick<Project, 'default_branch'>
): string {
  return worktree.base_branch || project.default_branch || 'main'
}

/**
 * Hook that pushes open-PR and locally relevant worktrees to the backend for
 * background sweep polling. Should be mounted at the app root level.
 *
 * Subscribes to query cache changes so the list updates when worktrees
 * are created, archived, or get new PRs.
 */
export function usePrWorktreeSweep(projects: Project[] | undefined) {
  const queryClient = useQueryClient()
  const lastJsonRef = useRef<string>('')

  useEffect(() => {
    if (!isTauri() || !projects || projects.length === 0) return

    const sync = () => {
      const prWorktrees: {
        worktreeId: string
        worktreePath: string
        baseBranch: string
        prNumber: number
        prUrl: string
      }[] = []

      const allWorktrees: {
        worktreeId: string
        worktreePath: string
        baseBranch: string
      }[] = []

      for (const project of projects) {
        if (project.is_folder) continue

        const worktrees = queryClient.getQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project.id)
        )
        if (!worktrees) continue

        const projectDefault = project.default_branch ?? 'main'

        for (const w of worktrees) {
          if (w.archived_at) continue

          const baseBranch = resolveSweepBaseBranch(w, {
            default_branch: projectDefault,
          })

          // PR worktrees for PR status sweep
          if (w.pr_number && w.pr_url) {
            prWorktrees.push({
              worktreeId: w.id,
              worktreePath: w.path,
              baseBranch,
              prNumber: w.pr_number,
              prUrl: w.pr_url,
            })
          }

          // Clean, inactive worktrees are refreshed when their project is
          // opened (or when they become relevant again), not every sweep.
          if (shouldIncludeInGitSweep(w)) {
            allWorktrees.push({
              worktreeId: w.id,
              worktreePath: w.path,
              baseBranch,
            })
          }
        }
      }

      // Only send if the list actually changed
      const json = JSON.stringify({ prWorktrees, allWorktrees })
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json
        setPrWorktreesForPolling(prWorktrees).catch(() => {
          /* silent */
        })
        setAllWorktreesForPolling(allWorktrees).catch(() => {
          /* silent */
        })
      }
    }

    sync()
  }, [projects, queryClient])
}
