import { createElement, type PropsWithChildren } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useStreamingEvents from './useStreamingEvents'
import { useChatStore } from '@/store/chat-store'

const { mockInvoke, mockListen, mockSaveWorktreePr, registeredListeners } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn().mockResolvedValue(undefined),
    mockListen: vi.fn(),
    mockSaveWorktreePr: vi.fn(),
    registeredListeners: new Map<
      string,
      (event: { payload: unknown }) => void
    >(),
  }))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  listen: mockListen,
  useWsConnectionStatus: () => true,
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  saveWorktreePr: mockSaveWorktreePr,
  projectsQueryKeys: {
    all: ['projects'],
    list: () => ['projects'],
  },
}))

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('useStreamingEvents Codex MCP elicitation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()

    mockListen.mockImplementation(
      (eventName: string, callback: (event: { payload: unknown }) => void) => {
        registeredListeners.set(eventName, callback)
        return Promise.resolve(() => {
          registeredListeners.delete(eventName)
        })
      }
    )

    useChatStore.setState({
      enabledMcpServers: {},
      pendingCodexMcpElicitationRequests: {},
      waitingForInputSessionIds: {},
      worktreePaths: {},
    })
  })

  it('auto-accepts Codex MCP elicitation when server is enabled for the session', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    useChatStore.setState({
      enabledMcpServers: {
        'session-1': ['notion'],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 42,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('respond_codex_mcp_elicitation', {
        sessionId: 'session-1',
        rpcId: 42,
        action: 'accept',
      })
    )

    expect(
      useChatStore.getState().pendingCodexMcpElicitationRequests['session-1'] ??
        []
    ).toEqual([])
    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      undefined
    )
  })

  it('queues Codex MCP elicitation when server is not enabled for the session', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 99,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(
        useChatStore.getState().pendingCodexMcpElicitationRequests['session-1']
      ).toEqual([
        {
          rpc_id: 99,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      ])
    )

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'respond_codex_mcp_elicitation',
      expect.anything()
    )
    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      true
    )
  })
})
