import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const invoke = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/services/chat', () => ({
  chatQueryKeys: {
    sessions: (worktreeId: string) => ['chat', 'sessions', worktreeId] as const,
  },
}))

describe('fetchAndSeedProjectBootstrap', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('seeds worktrees and session list caches from one bootstrap_project call', async () => {
    const { fetchAndSeedProjectBootstrap, projectsQueryKeys } =
      await import('./projects')

    const queryClient = new QueryClient()
    invoke.mockResolvedValueOnce({
      worktrees: [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          path: '/tmp/wt-1',
          name: 'main',
          branch: 'main',
        },
      ],
      sessionsByWorktree: {
        'wt-1': {
          worktree_id: 'wt-1',
          sessions: [{ id: 's-1', name: 'Chat' }],
          active_session_id: 's-1',
          version: 2,
        },
      },
    })

    const worktrees = await fetchAndSeedProjectBootstrap('proj-1', queryClient)

    expect(invoke).toHaveBeenCalledWith('bootstrap_project', {
      projectId: 'proj-1',
    })
    expect(worktrees).toHaveLength(1)
    expect(queryClient.getQueryData(projectsQueryKeys.worktrees('proj-1'))).toEqual(
      worktrees
    )
    expect(
      queryClient.getQueryData(['chat', 'sessions', 'wt-1', 'with-counts'])
    ).toMatchObject({
      worktree_id: 'wt-1',
      sessions: [{ id: 's-1', name: 'Chat' }],
    })
  })
})
