import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { removeWorktreeFromRecentCaches } from './recent-worktree-cache'

describe('removeWorktreeFromRecentCaches', () => {
  it('removes the deleted worktree from every recent page', () => {
    const queryClient = new QueryClient()
    const firstKey = ['recent-worktrees', 'projects', 10]
    const secondKey = ['recent-worktrees', 'projects', 25]
    const item = (worktreeId: string) => ({
      worktree: { id: worktreeId },
      session: { id: `session-${worktreeId}` },
    })
    queryClient.setQueryData(firstKey, {
      items: [item('deleted'), item('kept')],
      total: 2,
    })
    queryClient.setQueryData(secondKey, {
      items: [item('deleted')],
      total: 1,
    })

    removeWorktreeFromRecentCaches(queryClient, 'deleted')

    expect(
      queryClient.getQueryData<{
        items: ReturnType<typeof item>[]
        total: number
      }>(firstKey)
    ).toEqual({ items: [item('kept')], total: 1 })
    expect(queryClient.getQueryData(secondKey)).toEqual({ items: [], total: 0 })
  })

  it('preserves an unchanged cache value', () => {
    const queryClient = new QueryClient()
    const key = ['recent-worktrees', 'projects', 10]
    const cached = { items: [], total: 0 }
    queryClient.setQueryData(key, cached)

    removeWorktreeFromRecentCaches(queryClient, 'missing')

    expect(queryClient.getQueryData(key)).toBe(cached)
  })
})
