import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setWsConnectedMock = vi.fn()

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event('close'))
  })

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

async function flushAsync() {
  await Promise.resolve()
  await Promise.resolve()
}

function getWs(index: number): MockWebSocket {
  const ws = MockWebSocket.instances[index]
  if (!ws) throw new Error(`Expected websocket instance ${index}`)
  return ws
}

async function loadTransportModule() {
  vi.resetModules()
  vi.doMock('./environment', () => ({
    isNativeApp: () => false,
    setWsConnected: setWsConnectedMock,
    setWebAccessEnabled: vi.fn(),
  }))
  return import('./transport')
}

async function loadNativeTransportModule(tauriInvoke: ReturnType<typeof vi.fn>) {
  vi.resetModules()
  vi.doMock('./environment', () => ({
    isNativeApp: () => true,
    setWsConnected: setWsConnectedMock,
    setWebAccessEnabled: vi.fn(),
  }))
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }))
  return import('./transport')
}

describe('transport bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./environment')
    vi.doUnmock('@tauri-apps/api/core')
  })

  it('routes shared native commands through the jean-core dispatcher', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue([{ id: 'project-1' }])
    const transport = await loadNativeTransportModule(tauriInvoke)

    await transport.invoke('list_projects')

    expect(tauriInvoke).toHaveBeenCalledWith('dispatch_core_command', {
      command: 'list_projects',
      args: {},
    })
  })

  it('keeps desktop-only commands on their native Tauri handlers', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const transport = await loadNativeTransportModule(tauriInvoke)

    await transport.invoke('set_window_vibrancy', { enabled: true })

    expect(tauriInvoke).toHaveBeenCalledWith('set_window_vibrancy', {
      enabled: true,
    })
  })
  it('does not open websocket until bootstrap explicitly connects it', async () => {
    const transport = await loadTransportModule()

    await transport.listen('chat:chunk', vi.fn())
    expect(MockWebSocket.instances).toHaveLength(0)

    transport.connectTransport()
    await flushAsync()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(setWsConnectedMock).toHaveBeenCalledWith(true)
  })

  it('retries while establishing the initial connection', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockRejectedValueOnce(new Error('server starting'))
      .mockResolvedValueOnce({ ok: true } as Response)
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()
    expect(MockWebSocket.instances).toHaveLength(0)

    await new Promise(resolve => setTimeout(resolve, 150))
    await flushAsync()

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(setWsConnectedMock).toHaveBeenCalledWith(true)
  })

  it('buffers bootstrap replay events before listeners connect and replays them in seq order', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()

    transport.ingestBootstrapEvents([
      {
        type: 'event',
        event: 'chat:chunk',
        payload: { session_id: 'session-1', content: 'second' },
        seq: 2,
      },
      {
        type: 'event',
        event: 'chat:chunk',
        payload: { session_id: 'session-1', content: 'first' },
        seq: 1,
      },
    ])

    await transport.listen('chat:chunk', handler)

    expect(handler.mock.calls).toEqual([
      [{ payload: { session_id: 'session-1', content: 'first' } }],
      [{ payload: { session_id: 'session-1', content: 'second' } }],
    ])
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('dedupes terminal replay events by terminal sequence number', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()

    await transport.listen('terminal:output', handler)
    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'first' },
      seq: 10,
    })
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'duplicate' },
      seq: 10,
    })
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'second' },
      seq: 11,
    })

    expect(handler.mock.calls).toEqual([
      [{ payload: { terminal_id: 'term-1', data: 'first' } }],
      [{ payload: { terminal_id: 'term-1', data: 'second' } }],
    ])
  })

  it('ignores app-level heartbeat messages without dispatching events', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()

    await transport.listen('heartbeat', handler)
    transport.connectTransport()
    await flushAsync()

    getWs(0).receive({ type: 'heartbeat' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps idle websocket alive when app-level heartbeats arrive', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    vi.advanceTimersByTime(49_000)
    expect(ws.close).not.toHaveBeenCalled()

    ws.receive({ type: 'heartbeat' })
    vi.advanceTimersByTime(40_000)
    expect(ws.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(11_000)
    expect(ws.close).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('replaces a stale websocket immediately when the page returns', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    })
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()
    const ws = getWs(0)

    vi.advanceTimersByTime(51_000)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('uses extended timeout for terminal lifecycle commands', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()

    let rejected = false
    const request = transport
      .invoke('terminal_write', { terminalId: 'term-1', data: 'echo hi\r' })
      .catch(() => {
        rejected = true
      })

    vi.advanceTimersByTime(60_001)
    await flushAsync()

    expect(rejected).toBe(false)

    vi.advanceTimersByTime(30 * 60_000)
    await request

    expect(rejected).toBe(true)

    vi.useRealTimers()
  })

  it('can explicitly request terminal replay from seq zero after full page reload', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    transport.requestTerminalReplay('term-restored', 0)

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'terminal_replay',
        terminal_id: 'term-restored',
        last_seq: 0,
      })
    )
  })

  it('uses highest known sequence for explicit terminal replay requests', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'running' },
      seq: 21,
    })

    transport.requestTerminalReplay('term-1', 0)

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'terminal_replay',
        terminal_id: 'term-1',
        last_seq: 21,
      })
    )
  })

  it('does not open a second socket after an established connection closes', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const firstWs = getWs(0)
    firstWs.close()
    await new Promise(resolve => setTimeout(resolve, 150))
    await flushAsync()

    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('notifies established disconnect listeners synchronously', async () => {
    const transport = await loadTransportModule()
    const onDisconnect = vi.fn()

    transport.onEstablishedWsDisconnect(onDisconnect)
    transport.connectTransport()
    await flushAsync()

    getWs(0).close()

    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})
