import { createElement, type PropsWithChildren } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TransportNamespace from '@/lib/transport'
import type { useChatStore as ChatStoreHook } from '@/store/chat-store'

type Transport = typeof TransportNamespace
type ChatStore = typeof ChatStoreHook

vi.mock('@/lib/sounds', () => ({ playNotificationSound: vi.fn() }))

type CommandReply = (args: Record<string, unknown>) => unknown

/** A Jean server as the browser sees it: one socket per connection. */
class FakeServerSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static sockets: FakeServerSocket[] = []
  static replies: Record<string, CommandReply> = {}
  /** Sent by the server as soon as a command arrives, before its reply. */
  static pushOnCommand: Record<string, (socket: FakeServerSocket) => void> = {}
  static commands: string[] = []

  readyState = FakeServerSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public url: string) {
    FakeServerSocket.sockets.push(this)
    queueMicrotask(() => {
      this.readyState = FakeServerSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: string) {
    const message = JSON.parse(data) as {
      type: string
      id: string
      command: string
      args: Record<string, unknown>
    }
    if (message.type !== 'invoke') return
    FakeServerSocket.commands.push(message.command)
    FakeServerSocket.pushOnCommand[message.command]?.(this)
    const reply = FakeServerSocket.replies[message.command]
    queueMicrotask(() =>
      this.push({
        type: 'response',
        id: message.id,
        data: reply ? reply(message.args) : null,
      })
    )
  }

  push(message: unknown) {
    if (this.readyState !== FakeServerSocket.OPEN) return
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  chunk(seq: number, content: string) {
    this.push({
      type: 'event',
      event: 'chat:chunk',
      payload: { session_id: 's1', worktree_id: 'wt1', content },
      seq,
    })
  }

  /** The network path died: the browser reports the socket closed. */
  close() {
    this.readyState = FakeServerSocket.CLOSED
    this.onclose?.()
  }
}

function latestSocket(): FakeServerSocket {
  const socket = FakeServerSocket.sockets.at(-1)
  if (!socket) throw new Error('No socket was opened')
  return socket
}

function runningState(sessionId: string) {
  return {
    sessionId,
    worktreeId: 'wt1',
    status: 'running',
    statusVersion: 2,
    activelyManaged: true,
    startedAt: 100,
    waitingForInput: false,
  }
}

describe('web access reconnect resync', () => {
  let queryClient: QueryClient
  let overlay: boolean
  let wrapper: (props: PropsWithChildren) => ReturnType<typeof createElement>
  let transport: Transport
  let useChatStore: ChatStore

  const isTransportConnected = () => transport.isTransportConnected()
  const streamedText = (sessionId: string) =>
    (useChatStore.getState().streamingContentBlocks[sessionId] ?? [])
      .map(block => (block.type === 'text' ? block.text : `<${block.type}>`))
      .join('|')

  beforeEach(async () => {
    // The transport is a module singleton: each test gets its own page.
    vi.resetModules()
    transport = await import('@/lib/transport')
    useChatStore = (await import('@/store/chat-store')).useChatStore
    const { default: useStreamingEvents } =
      await import('@/components/chat/hooks/useStreamingEvents')
    const { resyncAfterReconnect } = await import('./reconnect-resync')
    FakeServerSocket.sockets = []
    FakeServerSocket.replies = {
      list_pending_wakeups: () => [],
      get_run_states: () => [runningState('s1')],
      get_session: () => ({ id: 's1', messages: [] }),
    }
    FakeServerSocket.pushOnCommand = {}
    FakeServerSocket.commands = []
    vi.stubGlobal('WebSocket', FakeServerSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    )
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    overlay = false

    // The wiring App.tsx sets up for Web Access.
    transport.onWsRecovery({
      disconnected: () => {
        overlay = true
      },
      reconnected: async () => {
        await resyncAfterReconnect(queryClient)
        if (isTransportConnected()) overlay = false
      },
    })
    wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })
    transport.connectTransport()
    await waitFor(() => expect(isTransportConnected()).toBe(true))

    useChatStore.setState({
      sendingSessionIds: {},
      sendStartedAt: {},
      localSendIds: {},
      runStateVersions: {},
      streamingContents: {},
      streamingContentBlocks: {},
      streamingReplayContentBlocks: {},
      activeToolCalls: {},
      sessionWorktreeMap: { s1: 'wt1' },
      worktreePaths: { wt1: '/repo/wt1' },
    })
    useChatStore.getState().addSendingSession('s1', 100_000, false)
  })

  afterEach(() => {
    transport.getLegacyWsTransport().dispose()
    queryClient.clear()
    vi.unstubAllGlobals()
  })

  it('shows a running reply exactly once after the socket drops mid-stream', async () => {
    latestSocket().chunk(1, 'Hello ')
    await waitFor(() => expect(streamedText('s1')).toBe('Hello '))

    // While disconnected the server streamed "brave new world". After the
    // reconnect it streams " end" before it reads the snapshot, and "!"
    // after it.
    FakeServerSocket.replies.get_session = () => ({
      id: 's1',
      messages: [
        { id: 'u1', role: 'user', content: 'hi', tool_calls: [] },
        {
          id: 'running-r1',
          role: 'assistant',
          content: '',
          tool_calls: [],
          content_blocks: [{ type: 'text', text: 'Hello brave new world end' }],
        },
      ],
    })
    FakeServerSocket.pushOnCommand.get_run_states = socket => {
      socket.chunk(7, ' end')
    }
    FakeServerSocket.pushOnCommand.get_session = socket => {
      socket.chunk(8, '!')
    }

    latestSocket().close()
    expect(overlay).toBe(true)
    expect(isTransportConnected()).toBe(false)
    // The send mutation lost its response with the socket and gives up.
    useChatStore.getState().removeSendingSession('s1')

    await waitFor(() => expect(overlay).toBe(false), { timeout: 3_000 })
    expect(FakeServerSocket.sockets).toHaveLength(2)
    await waitFor(() =>
      expect(streamedText('s1')).toBe('Hello brave new world end!')
    )
    expect(useChatStore.getState().sendingSessionIds.s1).toBe(true)

    // The stream continues on the new socket.
    latestSocket().chunk(9, ' Bye.')
    await waitFor(() =>
      expect(streamedText('s1')).toBe('Hello brave new world end! Bye.')
    )
  })

  it('ends a run that finished while the socket was down', async () => {
    latestSocket().chunk(1, 'Partial')
    await waitFor(() => expect(streamedText('s1')).toBe('Partial'))
    queryClient.setQueryData(['chat', 'session', 's1'], { id: 's1' })
    FakeServerSocket.replies.get_run_states = () => []

    latestSocket().close()
    await waitFor(() => expect(overlay).toBe(false), { timeout: 3_000 })

    const state = useChatStore.getState()
    expect(state.sendingSessionIds.s1).toBeUndefined()
    expect(state.streamingContentBlocks.s1).toBeUndefined()
    // The finished reply is loaded from the server in place of the stream.
    expect(queryClient.getQueryState(['chat', 'session', 's1'])).toMatchObject({
      isInvalidated: true,
    })
  })

  it('loads the chat state before refetching anything else', async () => {
    FakeServerSocket.replies.list_github_issues = () => []
    renderHook(
      () =>
        useQuery({
          queryKey: ['github-issues'],
          queryFn: () => transport.invoke('list_github_issues'),
        }),
      { wrapper }
    )
    await waitFor(() =>
      expect(FakeServerSocket.commands).toContain('list_github_issues')
    )

    latestSocket().close()
    FakeServerSocket.commands = []
    await waitFor(() => expect(overlay).toBe(false), { timeout: 3_000 })
    await waitFor(() =>
      expect(FakeServerSocket.commands).toContain('list_github_issues')
    )

    const sent = FakeServerSocket.commands
    const firstRefetch = sent.indexOf('list_github_issues')
    expect(sent.indexOf('get_run_states')).toBeLessThan(firstRefetch)
    expect(sent.indexOf('get_session')).toBeLessThan(firstRefetch)
  })

  it('marks GitHub data stale on reconnect without loading it, but reloads attached contexts', async () => {
    FakeServerSocket.replies.list_github_issues = () => []
    FakeServerSocket.replies.list_loaded_issue_contexts = () => []
    renderHook(
      () => [
        useQuery({
          queryKey: ['github', 'issues'],
          queryFn: () => transport.invoke('list_github_issues'),
        }),
        useQuery({
          queryKey: ['github', 'loaded-contexts', 's1'],
          queryFn: () => transport.invoke('list_loaded_issue_contexts'),
        }),
      ],
      { wrapper }
    )
    await waitFor(() =>
      expect(FakeServerSocket.commands).toContain('list_github_issues')
    )

    latestSocket().close()
    FakeServerSocket.commands = []
    await waitFor(() => expect(overlay).toBe(false), { timeout: 3_000 })
    await waitFor(() =>
      expect(queryClient.getQueryState(['github', 'issues'])).toMatchObject({
        isInvalidated: true,
      })
    )

    expect(FakeServerSocket.commands).not.toContain('list_github_issues')
    expect(FakeServerSocket.commands).toContain('list_loaded_issue_contexts')
  })

  it('keeps the reconnecting overlay when the socket drops again during the resync', async () => {
    FakeServerSocket.pushOnCommand.get_run_states = socket => socket.close()

    latestSocket().close()
    await waitFor(() => expect(FakeServerSocket.sockets).toHaveLength(2))
    await waitFor(() => expect(isTransportConnected()).toBe(false))
    expect(overlay).toBe(true)

    FakeServerSocket.pushOnCommand = {}
    await waitFor(() => expect(overlay).toBe(false), { timeout: 3_000 })
    expect(FakeServerSocket.sockets).toHaveLength(3)
  })
})
