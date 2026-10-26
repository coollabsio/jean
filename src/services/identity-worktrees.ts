import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import type { Project, ProjectHostCheckout, Worktree } from '@/types/projects'
import { projectsQueryKeys, useWorktrees } from '@/services/projects'

export function mergeHostWorktrees(
  checkouts: Pick<ProjectHostCheckout, 'serverId' | 'serverName'>[],
  groups: Worktree[][]
): Worktree[] {
  const labelHosts = checkouts.length > 1
  const merged: Worktree[] = []
  const seen = new Set<string>()
  checkouts.forEach((checkout, index) => {
    for (const worktree of groups[index] ?? []) {
      if (seen.has(worktree.id)) continue
      seen.add(worktree.id)
      merged.push(
        labelHosts
          ? {
              ...worktree,
              serverId: worktree.serverId ?? checkout.serverId,
              serverName: worktree.serverName ?? checkout.serverName,
            }
          : worktree
      )
    }
  })
  return merged
}

/** Worktrees for every host checkout of one project identity. */
export function useIdentityWorktrees(project: Project, enabled: boolean) {
  const checkouts = project.hostCheckouts
  const multi = (checkouts?.length ?? 0) > 1
  const primary = useWorktrees(multi ? null : project.id, {
    enabled: enabled && !multi,
  })
  const queries = useQueries({
    queries:
      multi && checkouts
        ? checkouts.map(checkout => ({
            queryKey: projectsQueryKeys.worktrees(checkout.projectId),
            enabled: enabled && !checkout.offline,
            staleTime: 1000 * 60 * 5,
            queryFn: () =>
              invoke<Worktree[]>('list_worktrees', {
                projectId: checkout.projectId,
              }),
          }))
        : [],
  })

  return useMemo(() => {
    if (!multi || !checkouts) {
      return { data: primary.data, isLoading: primary.isLoading }
    }
    const groups = queries.map(query => query.data ?? [])
    const isLoading =
      queries.some(query => query.isLoading) &&
      groups.every(group => group.length === 0)
    return {
      data: isLoading ? undefined : mergeHostWorktrees(checkouts, groups),
      isLoading,
    }
  }, [checkouts, multi, primary.data, primary.isLoading, queries])
}
