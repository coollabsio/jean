import type { QueryClient } from '@tanstack/react-query'
import type { RecentWorktreeItem } from '@/types/projects'

interface RecentWorktreesCache {
  items: RecentWorktreeItem[]
  total: number
}

/** Remove a worktree from every cached recent-session page immediately. */
export function removeWorktreeFromRecentCaches(
  queryClient: QueryClient,
  worktreeId: string
): void {
  queryClient.setQueriesData<RecentWorktreesCache>(
    { queryKey: ['recent-worktrees'] },
    old => {
      if (!old) return old
      const items = old.items.filter(item => item.worktree.id !== worktreeId)
      const removedCount = old.items.length - items.length
      if (removedCount === 0) return old
      return {
        ...old,
        items,
        total: Math.max(0, old.total - removedCount),
      }
    }
  )
}
