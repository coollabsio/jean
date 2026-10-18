import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Worktree } from '@/types/projects'
import type { PrStatusEvent } from '@/types/pr-status'
import { projectsQueryKeys } from './projects'
import { usePrStatusEvents } from './pr-status'

const mockListen = vi.fn()
const mockUpdateWorktreeCachedStatus = vi.fn()

vi.mock('@/lib/transport', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
  useWsConnectionStatus: () => true,
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  projectsQueryKeys: {
    all: ['projects'],
    worktrees: (projectId: string) => ['projects', 'worktrees', projectId],
  },
  updateWorktreeCachedStatus: (...args: unknown[]) =>
    mockUpdateWorktreeCachedStatus(...args),
}))

describe('PR status events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListen.mockResolvedValue(() => undefined)
    mockUpdateWorktreeCachedStatus.mockResolvedValue(undefined)
  })

  it('syncs a changed GitHub PR base branch to the linked worktree', async () => {
    const queryClient = new QueryClient()
    const worktree = {
      id: 'wt-1',
      project_id: 'project-1',
      base_branch: 'next',
    } as Worktree
    queryClient.setQueryData(projectsQueryKeys.worktrees('project-1'), [worktree])

    renderHook(() => usePrStatusEvents(), {
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    })

    await waitFor(() => expect(mockListen).toHaveBeenCalled())
    const listener = mockListen.mock.calls[0]?.[1] as (event: {
      payload: PrStatusEvent
    }) => void

    act(() => {
      listener({
        payload: {
          worktree_id: 'wt-1',
          pr_number: 42,
          pr_url: 'https://github.com/acme/repo/pull/42',
          base_branch: 'main',
          state: 'open',
          is_draft: false,
          review_decision: null,
          check_status: null,
          display_status: 'open',
          mergeable: 'mergeable',
          checked_at: 1,
        },
      })
    })

    expect(
      queryClient.getQueryData<Worktree[]>(
        projectsQueryKeys.worktrees('project-1')
      )?.[0]?.base_branch
    ).toBe('main')
    expect(mockUpdateWorktreeCachedStatus).toHaveBeenCalledWith(
      'wt-1',
      null,
      'open',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'main'
    )
  })
})
