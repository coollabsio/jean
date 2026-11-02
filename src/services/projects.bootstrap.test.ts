import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const invoke = vi.fn()
const applyRunStateSnapshot = vi.fn()

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
  useChatStore: {
    getState: () => ({
      applyRunStateSnapshot: (...args: unknown[]) =>
        applyRunStateSnapshot(...args),
    }),
  },
}))

describe('fetchAndSeedProjectBootstrap', () => {
  beforeEach(() => {
    invoke.mockReset()
    applyRunStateSnapshot.mockReset()
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
      runStates: [
        {
          sessionId: 's-1',
          worktreeId: 'wt-1',
          status: 'running',
          statusVersion: 3,
          activelyManaged: true,
          startedAt: 100,
          waitingForInput: false,
        },
      ],
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
    const [states, options] = applyRunStateSnapshot.mock.calls[0] ?? []
    expect(states).toEqual([
      expect.objectContaining({ sessionId: 's-1', status: 'running' }),
    ])
    expect(options.ownsSession('s-1')).toBe(true)
    expect(options.ownsSession('stale')).toBe(false)
  })

  it('scopes the run-state snapshot to sessions in the bootstrapped project', async () => {
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
      runStates: [],
    })

    await fetchAndSeedProjectBootstrap('proj-1', new QueryClient())

    const [states, options] = applyRunStateSnapshot.mock.calls[0] ?? []
    expect(states).toEqual([])
    // 's-1' is in the project and absent from the snapshot: idle. 'other'
    // belongs to another project and must be left alone.
    expect(options.ownsSession('s-1')).toBe(true)
    expect(options.ownsSession('other')).toBe(false)
    expect(options.requestedAt).toBeTypeOf('number')
  })
})
