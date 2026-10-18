import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as EnvironmentModule from '@/lib/environment'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Project } from '@/types/projects'
import type { UIState } from '@/types/ui-state'
import {
  recentSessionPinsQueryKey,
  setRecentSessionPinned,
  useRecentSessionPins,
} from './recent-session-pins'

let nativeApp = true
const invokeForServer = vi.fn()
const toastError = vi.fn()

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => nativeApp,
}))
vi.mock('@/lib/transport', () => ({
  invokeForServer: (...args: unknown[]) => invokeForServer(...args),
}))
vi.mock('@/lib/server-connections', () => ({
  listenOnRemoteServers: () => () => undefined,
}))
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}))

/** In-memory pins per server, answering the pin commands like the backend. */
function mockServers(pins: Record<string, string[] | 'legacy'>) {
  invokeForServer.mockImplementation(
    async (
      serverId: string,
      command: string,
      args?: { sessionId: string; pinned: boolean }
    ) => {
      const current = pins[serverId] ?? []
      if (current === 'legacy') throw new Error(`Unknown command: ${command}`)
      if (command === 'get_pinned_recent_session_ids') return current
      if (command === 'set_recent_session_pinned' && args) {
        const others = current.filter(id => id !== args.sessionId)
        pins[serverId] = args.pinned ? [...others, args.sessionId] : others
        return pins[serverId]
      }
      throw new Error(`Unexpected command: ${command}`)
    }
  )
  return pins
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function project(id: string, serverId?: string): Project {
  return { id, serverId } as Project
}

describe('recent session pins', () => {
  beforeEach(() => {
    nativeApp = true
    invokeForServer.mockReset()
    toastError.mockReset()
    useProjectsStore.setState({ pinnedRecentSessionIds: [] })
    useUIStore.setState({ uiStateInitialized: true })
  })

  it('pins a local or Web Access session in the loaded UI state', async () => {
    nativeApp = false
    const servers = mockServers({ local: ['session-a'] })
    const queryClient = createQueryClient()
    queryClient.setQueryData<UIState>(['ui-state'], {
      pinned_recent_session_ids: ['session-a'],
    } as UIState)

    await setRecentSessionPinned(queryClient, 'session-b', true)

    expect(servers.local).toEqual(['session-a', 'session-b'])
    expect(useProjectsStore.getState().pinnedRecentSessionIds).toEqual([
      'session-a',
      'session-b',
    ])
    expect(
      queryClient.getQueryData<UIState>(['ui-state'])?.pinned_recent_session_ids
    ).toEqual(['session-a', 'session-b'])
  })

  it('pins a remote session on the server that owns it', async () => {
    const servers = mockServers({ local: [], 'server-1': [] })
    const queryClient = createQueryClient()
    queryClient.setQueryData(recentSessionPinsQueryKey('server-1'), [])

    await setRecentSessionPinned(queryClient, 'server-1:session-r', true)

    expect(servers['server-1']).toEqual(['session-r'])
    expect(servers.local).toEqual([])
    expect(
      queryClient.getQueryData(recentSessionPinsQueryKey('server-1'))
    ).toEqual(['server-1:session-r'])
  })

  it('keeps pins of an old remote server in the local UI state', async () => {
    const servers = mockServers({ local: [], 'server-1': 'legacy' })
    const queryClient = createQueryClient()
    queryClient.setQueryData(recentSessionPinsQueryKey('server-1'), null)

    await setRecentSessionPinned(queryClient, 'server-1:session-r', true)

    expect(servers.local).toEqual(['server-1:session-r'])
    expect(useProjectsStore.getState().pinnedRecentSessionIds).toEqual([
      'server-1:session-r',
    ])
  })

  it('unpins a remote session on its server and in the local UI state', async () => {
    const servers = mockServers({
      local: ['server-1:session-r'],
      'server-1': ['session-r'],
    })
    useProjectsStore.setState({
      pinnedRecentSessionIds: ['server-1:session-r'],
    })
    const queryClient = createQueryClient()
    queryClient.setQueryData(recentSessionPinsQueryKey('server-1'), [
      'server-1:session-r',
    ])

    await setRecentSessionPinned(queryClient, 'server-1:session-r', false)

    expect(servers['server-1']).toEqual([])
    expect(servers.local).toEqual([])
    expect(useProjectsStore.getState().pinnedRecentSessionIds).toEqual([])
  })

  it('restores the pins and reports an error when the pin command fails', async () => {
    invokeForServer.mockRejectedValue(new Error('disconnected'))
    useProjectsStore.setState({ pinnedRecentSessionIds: ['session-a'] })
    const queryClient = createQueryClient()

    await setRecentSessionPinned(queryClient, 'session-b', true)

    expect(useProjectsStore.getState().pinnedRecentSessionIds).toEqual([
      'session-a',
    ])
    expect(toastError).toHaveBeenCalledWith(
      'Failed to pin session: Error: disconnected'
    )
  })

  it('merges local pins with remote pins and moves old local pins to the server', async () => {
    const servers = mockServers({
      local: ['session-local', 'server-1:session-old'],
      'server-1': ['session-phone', 'remote-2:nested'],
    })
    useProjectsStore.setState({
      pinnedRecentSessionIds: ['session-local', 'server-1:session-old'],
    })
    const queryClient = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(
      () =>
        useRecentSessionPins([
          project('project-local'),
          project('server-1:project-1', 'server-1'),
        ]),
      { wrapper }
    )

    await waitFor(() => {
      expect([...result.current].sort()).toEqual([
        'server-1:session-old',
        'server-1:session-phone',
        'session-local',
      ])
    })
    expect(servers['server-1']).toEqual([
      'session-phone',
      'remote-2:nested',
      'session-old',
    ])
    expect(servers.local).toEqual(['session-local'])
  })

  it('uses only local pins for an old remote server', async () => {
    mockServers({ 'server-1': 'legacy' })
    useProjectsStore.setState({
      pinnedRecentSessionIds: ['server-1:session-old'],
    })
    const queryClient = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(
      () => useRecentSessionPins([project('server-1:project-1', 'server-1')]),
      { wrapper }
    )

    await waitFor(() => {
      expect(
        queryClient.getQueryData(recentSessionPinsQueryKey('server-1'))
      ).toBeNull()
    })
    expect(result.current).toEqual(['server-1:session-old'])
  })
})
