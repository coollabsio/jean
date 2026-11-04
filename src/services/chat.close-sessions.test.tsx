import { createElement, type PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCloseSessions } from './chat'
import { useChatStore } from '@/store/chat-store'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))

vi.mock('@/lib/transport', () => ({ invoke: mockInvoke }))
vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  projectsQueryKeys: { all: ['projects'] },
}))

function closedIds() {
  return mockInvoke.mock.calls
    .filter(([command]) => command === 'close_session')
    .map(([, args]) => (args as { sessionId: string }).sessionId)
}

describe('useCloseSessions', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(null)
    useChatStore.setState({
      sendingSessionIds: {},
      waitingForInputSessionIds: {},
    })
  })

  it('closes the lead and keeps a sub-session that started working after the dialog opened', async () => {
    useChatStore.setState({
      sendingSessionIds: { 'child-running': true },
      waitingForInputSessionIds: { 'child-waiting': true },
    })
    const queryClient = new QueryClient()
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result } = renderHook(() => useCloseSessions(), { wrapper })

    await act(() =>
      result.current('wt', '/wt', 'lead', [
        'child-done',
        'child-running',
        'child-waiting',
      ])
    )

    expect(closedIds()).toEqual(['lead', 'child-done'])
  })
})
