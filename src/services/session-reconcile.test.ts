import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { reconcileSessionsAfterReconnect } from './session-reconcile'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => undefined),
}))

const mockInvoke = vi.mocked(invoke)

function session(id: string, lastRunStatus: string, role: string) {
  return {
    id,
    last_run_status: lastRunStatus,
    messages: [{ id: `${id}-msg`, role }],
  }
}

describe('reconcileSessionsAfterReconnect', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient()
    useChatStore.setState({
      sendingSessionIds: { 'r1:done': true, 'r1:live': true, local: true },
      sendStartedAt: {},
      sessionWorktreeMap: { 'r1:done': 'r1:wt', local: 'wt-local' },
      worktreePaths: { 'r1:wt': '/repo/wt', 'wt-local': '/repo/local' },
    })
    // 'r1:live' is only known from another client's run: find it in Recent.
    queryClient.setQueryData(['recent-worktrees', 'k', 10, []], {
      items: [
        {
          session: { id: 'r1:live' },
          worktree: { id: 'r1:wt2', path: '/repo/wt2' },
        },
      ],
      total: 1,
    })
    mockInvoke.mockImplementation(async (_command, args) => {
      const sessionId = (args as { sessionId: string }).sessionId
      return sessionId === 'r1:live'
        ? session(sessionId, 'running', 'assistant')
        : session(sessionId, 'completed', 'assistant')
    })
  })

  it('clears only finished runs owned by the reconnected server', async () => {
    await reconcileSessionsAfterReconnect(queryClient, id =>
      id.startsWith('r1:')
    )

    expect(mockInvoke).toHaveBeenCalledWith('get_session', {
      worktreeId: 'r1:wt',
      worktreePath: '/repo/wt',
      sessionId: 'r1:done',
      limit: 1,
    })
    expect(mockInvoke).toHaveBeenCalledWith('get_session', {
      worktreeId: 'r1:wt2',
      worktreePath: '/repo/wt2',
      sessionId: 'r1:live',
      limit: 1,
    })
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'get_session',
      expect.objectContaining({ sessionId: 'local' })
    )
    expect(useChatStore.getState().sendingSessionIds).toEqual({
      'r1:live': true,
      local: true,
    })
  })

  it('keeps sending when the last message is still the user prompt', async () => {
    mockInvoke.mockResolvedValue(session('r1:done', 'completed', 'user'))

    await reconcileSessionsAfterReconnect(queryClient, id => id === 'r1:done')

    expect(useChatStore.getState().sendingSessionIds['r1:done']).toBe(true)
  })
})
