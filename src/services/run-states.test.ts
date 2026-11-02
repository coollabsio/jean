import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { refreshRunStates, refreshRunStatesOnFocus } from './run-states'

const {
  mockInvoke,
  mockInvokeForServer,
  mockIsNativeApp,
  mockEnabledConnections,
  snapshot,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockInvokeForServer: vi.fn(),
  mockIsNativeApp: vi.fn(() => false),
  mockEnabledConnections: vi.fn(() => [] as { id: string }[]),
  snapshot: new Map<string, { status: string }>(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  invokeForServer: mockInvokeForServer,
  listen: vi.fn(async () => () => undefined),
}))
vi.mock('@/lib/environment', () => ({ isNativeApp: mockIsNativeApp }))
vi.mock('@/lib/remote-connections', () => ({
  getEnabledServerConnections: mockEnabledConnections,
}))
vi.mock('@/lib/server-connections', () => ({
  serverConnectionManager: { getSnapshot: () => snapshot },
}))
vi.mock('@/hooks/useMainWindowEventListeners', () => ({
  applyCacheInvalidationKeys: vi.fn(),
}))
vi.mock('@/services/chat', () => ({
  chatQueryKeys: {
    session: (sessionId: string) => ['chat', 'session', sessionId] as const,
  },
}))

import { useChatStore } from '@/store/chat-store'

function running(sessionId: string, statusVersion = 1) {
  return {
    sessionId,
    worktreeId: 'wt',
    status: 'running' as const,
    statusVersion,
    activelyManaged: true,
    startedAt: 100,
    waitingForInput: false,
  }
}

describe('refreshRunStates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    snapshot.clear()
    mockIsNativeApp.mockReturnValue(false)
    useChatStore.setState({
      sendingSessionIds: {},
      sendStartedAt: {},
      runStateVersions: {},
      streamingContents: {},
    })
  })

  it('web access asks its origin only and treats absent sessions as idle', async () => {
    useChatStore.getState().addSendingSession('stuck', 1)
    mockInvoke.mockResolvedValue([running('live')])

    await refreshRunStates(new QueryClient())

    expect(mockInvoke).toHaveBeenCalledWith('get_run_states')
    expect(mockInvokeForServer).not.toHaveBeenCalled()
    const state = useChatStore.getState()
    expect(state.sendingSessionIds).toEqual({ live: true })
    expect(state.sendStartedAt.live).toBe(100_000)
  })

  it('native asks the local core and every online remote, each owning its ids', async () => {
    mockIsNativeApp.mockReturnValue(true)
    mockEnabledConnections.mockReturnValue([{ id: 'r1' }, { id: 'r2' }])
    snapshot.set('r1', { status: 'online' })
    snapshot.set('r2', { status: 'connecting' })
    const store = useChatStore.getState()
    store.addSendingSession('local-stuck', 1)
    store.addSendingSession('r1:stuck', 1)
    store.addSendingSession('r2:offline-keeps', 1)
    mockInvokeForServer.mockImplementation(async (serverId: string) =>
      serverId === 'local' ? [running('local-live')] : [running('r1:live')]
    )

    await refreshRunStates(new QueryClient())

    expect(mockInvokeForServer.mock.calls.map(call => call[0])).toEqual([
      'local',
      'r1',
    ])
    expect(useChatStore.getState().sendingSessionIds).toEqual({
      'local-live': true,
      'r1:live': true,
      'r2:offline-keeps': true,
    })
  })

  it('refreshes one server after its socket reconnects', async () => {
    mockIsNativeApp.mockReturnValue(true)
    useChatStore.getState().addSendingSession('local-busy', 1)
    useChatStore.getState().addSendingSession('r1:done', 1)
    mockInvokeForServer.mockResolvedValue([])

    await refreshRunStates(new QueryClient(), { serverId: 'r1' })

    expect(mockInvokeForServer).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sendingSessionIds).toEqual({
      'local-busy': true,
    })
  })

  it('applies a single-session refresh without clearing other sessions', async () => {
    useChatStore.getState().addSendingSession('other', 1)
    mockInvoke.mockResolvedValue([running('opened', 9)])

    await refreshRunStates(new QueryClient(), { sessionIds: ['opened'] })

    expect(mockInvoke).toHaveBeenCalledWith('get_run_states', {
      sessionIds: ['opened'],
    })
    const state = useChatStore.getState()
    expect(state.sendingSessionIds).toEqual({ other: true, opened: true })
    expect(state.runStateVersions.opened).toBe(9)
  })

  it('refetches a session whose streamed run the snapshot ended', async () => {
    const store = useChatStore.getState()
    store.addSendingSession('missed-done', 1)
    store.setStreamingContent('missed-done', 'partial reply')
    store.addSendingSession('silent', 1)
    mockInvoke.mockResolvedValue([])
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await refreshRunStates(queryClient)

    expect(useChatStore.getState().sendingSessionIds).toEqual({})
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['chat', 'session', 'missed-done'],
    })
  })

  it('throttles focus refreshes', async () => {
    mockInvoke.mockResolvedValue([])
    const queryClient = new QueryClient()
    refreshRunStatesOnFocus(queryClient)
    refreshRunStatesOnFocus(queryClient)
    await Promise.resolve()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})
