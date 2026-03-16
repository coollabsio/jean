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

/**
 * Hook that pushes all non-archived worktrees with open PRs to the backend
 * for background sweep polling. Should be mounted at the app root level.
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

        const baseBranch = project.default_branch ?? 'main'

        for (const w of worktrees) {
          if (w.archived_at) continue

          // All non-archived worktrees for git status sweep
          allWorktrees.push({
            worktreeId: w.id,
            worktreePath: w.path,
            baseBranch,
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
