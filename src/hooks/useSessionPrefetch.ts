import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { prefetchSessions } from '@/services/chat'
import { useProjectsStore } from '@/store/projects-store'
import type { Project, Worktree } from '@/types/projects'
import { isNativeApp } from '@/lib/environment'
import { scheduleIdleWork } from '@/lib/idle'

/**
 * Prefetch sessions for the most relevant startup projects after the initial
 * paint. This keeps the first render path light while still warming the cache
 * for the currently selected project or expanded sidebar items.
 */
export function useSessionPrefetch(projects: Project[] | undefined) {
  const queryClient = useQueryClient()
  const hasFetchedRef = useRef(false)

  useEffect(() => {
    if (!isNativeApp()) return
    if (hasFetchedRef.current || !projects || projects.length === 0) return

    // Filter to only actual projects (not folders)
    const actualProjects = projects.filter(p => !p.is_folder)
    if (actualProjects.length === 0) return

    const { expandedProjectIds, selectedProjectId } =
      useProjectsStore.getState()
    const prioritizedProjectIds = new Set<string>(expandedProjectIds)
    if (selectedProjectId) {
      prioritizedProjectIds.add(selectedProjectId)
    }

    const prioritizedProjects = actualProjects.filter(p =>
      prioritizedProjectIds.has(p.id)
    )
    if (prioritizedProjects.length === 0) return

    hasFetchedRef.current = true

    // Fetch sessions for all worktrees in a project
    const fetchSessionsForProject = async (projectId: string) => {
      try {
        const worktrees = await invoke<Worktree[]>('list_worktrees', {
          projectId,
        })
        await Promise.all(
          worktrees.map(w =>
            prefetchSessions(queryClient, w.id, w.path).catch(() => {
              /* silent */
            })
          )
        )
      } catch {
        // Silently ignore — worktrees may not be available yet
      }
    }

    const cancelIdleWork = scheduleIdleWork(() => {
      const fetchAll = async () => {
        const concurrencyLimit = 2

        for (let i = 0; i < prioritizedProjects.length; i += concurrencyLimit) {
          const batch = prioritizedProjects.slice(i, i + concurrencyLimit)
          await Promise.all(batch.map(p => fetchSessionsForProject(p.id)))
        }
      }

      void fetchAll()
    }, 2000)

    return () => {
      cancelIdleWork()
    }
  }, [projects, queryClient])
}
