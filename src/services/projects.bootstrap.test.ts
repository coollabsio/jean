import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const invoke = vi.fn()
const setChatState = vi.fn()

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

vi.mock('@/store/chat-store', () => ({
  useChatStore: { setState: (...args: unknown[]) => setChatState(...args) },
}))

describe('fetchAndSeedProjectBootstrap', () => {
  beforeEach(() => {
    invoke.mockReset()
    setChatState.mockReset()
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
          sessions: [{ id: 's-1', name: 'Chat', last_run_started_at: 100 }],
          active_session_id: 's-1',
          version: 2,
        },
      },
      runningSessions: ['s-1'],
    })

    const worktrees = await fetchAndSeedProjectBootstrap('proj-1', queryClient)

    expect(invoke).toHaveBeenCalledWith('bootstrap_project', {
      projectId: 'proj-1',
    })
    expect(worktrees).toHaveLength(1)
    expect(
      queryClient.getQueryData(projectsQueryKeys.worktrees('proj-1'))
    ).toEqual(worktrees)
    expect(
      queryClient.getQueryData(['projects', 'worktree', 'wt-1'])
    ).toMatchObject({
      id: 'wt-1',
      name: 'main',
      status: 'ready',
    })
    expect(
      queryClient.getQueryData(['chat', 'sessions', 'wt-1', 'with-counts'])
    ).toMatchObject({
      worktree_id: 'wt-1',
      sessions: [{ id: 's-1', name: 'Chat', last_run_started_at: 100 }],
    })
    const updateSending = setChatState.mock.calls[0]?.[0]
    expect(
      updateSending({
        sendingSessionIds: { stale: true },
        sendStartedAt: { stale: 50_000 },
      })
    ).toEqual({
      sendingSessionIds: { stale: true, 's-1': true },
      sendStartedAt: { stale: 50_000, 's-1': 100_000 },
    })
  })

  it('clears stale running state only for sessions in the bootstrapped project', async () => {
    const { fetchAndSeedProjectBootstrap } = await import('./projects')
    invoke.mockResolvedValueOnce({
      worktrees: [],
      sessionsByWorktree: {
        'wt-1': {
          worktree_id: 'wt-1',
          sessions: [{ id: 's-1', name: 'Chat', last_run_started_at: 100 }],
          version: 2,
        },
      },
      runningSessions: [],
    })

    await fetchAndSeedProjectBootstrap('proj-1', new QueryClient())

    const updateSending = setChatState.mock.calls[0]?.[0]
    expect(
      updateSending({
        sendingSessionIds: { 's-1': true, other: true },
        sendStartedAt: { 's-1': 100_000, other: 50_000 },
      })
    ).toEqual({
      sendingSessionIds: { other: true },
      sendStartedAt: { other: 50_000 },
    })
  })
})
