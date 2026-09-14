import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static instances: MockWebSocket[] = []
  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CONNECTING
  }
}

describe('configured WebSocket transports', () => {
  beforeEach(() => {
    vi.resetModules()
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    )
  })

  it('uses independent server URLs and tokens', async () => {
    const { WsTransport } = await import('./transport')
    const one = new WsTransport({
      serverId: 'r1',
      baseUrl: 'https://one.test',
      getToken: () => 'one-token',
      syncGlobalState: false,
    })
    const two = new WsTransport({
      serverId: 'r2',
      baseUrl: 'https://two.test',
      getToken: () => 'two-token',
      syncGlobalState: false,
    })

    one.enableConnect()
    two.enableConnect()

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2))
    expect(MockWebSocket.instances.map(socket => socket.url)).toEqual([
      'wss://one.test/ws?token=one-token',
      'wss://two.test/ws?token=two-token',
    ])
    expect(fetch).toHaveBeenCalledWith(
      'https://one.test/api/auth?token=one-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://two.test/api/auth?token=two-token',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    one.dispose()
    two.dispose()
  })
})
