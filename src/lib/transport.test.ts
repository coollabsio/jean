import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { FALLBACK_APP_VERSION } from './app-version'
import type * as TransportNamespace from './transport'

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

/** Sign-in resolves over several promise hops before the socket opens. */
async function flushAsync() {
  for (let hop = 0; hop < 12; hop++) await Promise.resolve()
}

function getWs(index: number): MockWebSocket {
  const ws = MockWebSocket.instances[index]
  if (!ws) throw new Error(`Expected websocket instance ${index}`)
  return ws
}

type TransportModule = typeof TransportNamespace
const loadedTransports: TransportModule[] = []

/** A transport left over from one test reconnects during the next one. */
function trackTransport(transport: TransportModule): TransportModule {
  loadedTransports.push(transport)
  return transport
}

async function loadTransportModule() {
  vi.resetModules()
  vi.doMock('./environment', () => ({
    isNativeApp: () => false,
    isNativeOpenAllowed: () => false,
    setWsConnected: setWsConnectedMock,
    setWebAccessEnabled: vi.fn(),
  }))
  vi.doMock('./remote-connections', () => ({
    getActiveRemoteConnection: () => null,
    getRemoteConnections: () => [],
  }))
  return trackTransport(await import('./transport'))
}

async function loadNativeTransportModule(
  tauriInvoke: ReturnType<typeof vi.fn>
) {
  vi.resetModules()
  vi.doMock('./environment', () => ({
    isNativeApp: () => true,
    isNativeOpenAllowed: () => false,
    setWsConnected: setWsConnectedMock,
    setWebAccessEnabled: vi.fn(),
  }))
  vi.doMock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }))
  return trackTransport(await import('./transport'))
}

async function loadRemoteNativeTransportModule(
  remote?: {
    id: string
    name: string
    url: string
    token: string
    sshUser?: string
    sshHost?: string
    sshPort?: number
  },
  tauriInvoke?: ReturnType<typeof vi.fn>,
  options?: { nativeOpenAllowed?: boolean }
) {
  vi.resetModules()
  const nativeOpenAllowed = options?.nativeOpenAllowed ?? false
  vi.doMock('./environment', () => ({
    isNativeApp: () => true,
    isNativeOpenAllowed: () => nativeOpenAllowed,
    setWsConnected: setWsConnectedMock,
    setWebAccessEnabled: vi.fn(),
  }))
  vi.doMock('./remote-connections', () => ({
    getActiveRemoteConnection: () =>
      remote ?? {
        id: 'remote-1',
        name: 'Server',
        url: 'https://jean.example.com',
        token: 'secret',
      },
    getRemoteConnections: () => (remote ? [remote] : []),
  }))
  if (tauriInvoke) {
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }))
  }
  return trackTransport(await import('./transport'))
}

describe('transport bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWebSocket)
    // Auth responses include the local package version so native remote
    // version checks pass unless a test intentionally mismatches.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          appVersion: FALLBACK_APP_VERSION,
        }),
      })
    )
  })

  afterEach(() => {
    for (const transport of loadedTransports.splice(0)) {
      transport.getLegacyWsTransport().dispose()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./environment')
    vi.doUnmock('@tauri-apps/api/core')
    vi.doUnmock('@tauri-apps/api/event')
    vi.doUnmock('./remote-connections')
    vi.doUnmock('./server-connections')
  })

  it('routes composite resource commands to their owning server', async () => {
    const invokeOnServer = vi.fn(async () => [{ id: 'w1', project_id: 'p1' }])
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadNativeTransportModule(vi.fn())

    const result = await transport.invoke('list_worktrees', {
      projectId: 'remote%3Aone:project%2F1',
    })

    expect(invokeOnServer).toHaveBeenCalledWith(
      'remote:one',
      'list_worktrees',
      { projectId: 'project/1' }
    )
    expect(result).toEqual([
      {
        id: 'remote%3Aone:w1',
        project_id: 'remote%3Aone:p1',
        serverId: 'remote:one',
        resourceId: 'w1',
      },
    ])
  })

  it('strips scoped ids from commands sent straight to a server', async () => {
    const invokeOnServer = vi.fn(async () => ({ id: 'p9' }))
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadNativeTransportModule(vi.fn())

    await transport.invokeForServer('remote-1', 'add_project', {
      path: '/srv/qrcode',
      parentId: 'remote-1:folder-7',
    })

    expect(invokeOnServer).toHaveBeenCalledWith('remote-1', 'add_project', {
      path: '/srv/qrcode',
      parentId: 'folder-7',
    })
  })

  it('sends a pasted-text read to the server of the session that owns it', async () => {
    const invokeOnServer = vi.fn(async () => ({ content: 'notes', size: 5 }))
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadNativeTransportModule(vi.fn())

    await transport.invoke('read_pasted_text', {
      path: '/srv/jean/pasted-texts/a.txt',
      sessionId: 'remote-1:session-7',
    })

    expect(invokeOnServer).toHaveBeenCalledWith(
      'remote-1',
      'read_pasted_text',
      { path: '/srv/jean/pasted-texts/a.txt', sessionId: 'session-7' }
    )
  })

  it('rejects a path command that does not say which server owns the path', async () => {
    const invokeOnServer = vi.fn()
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadNativeTransportModule(vi.fn())

    await expect(
      transport.invoke('read_pasted_text', { path: '/tmp/a.txt' })
    ).rejects.toThrow(
      'read_pasted_text cannot tell which Jean server owns its arguments. Send sessionId with it, or call invokeForServer.'
    )
    expect(invokeOnServer).not.toHaveBeenCalled()
  })

  it('routes path-only Git and GitHub commands to a remote owner', async () => {
    const invokeOnServer = vi.fn(async () => ({ issues: [], totalCount: 0 }))
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadNativeTransportModule(vi.fn())
    const { registerServerResourcePath } =
      await import('./server-command-routing')
    registerServerResourcePath('remote-1', '/srv/project')

    await transport.invoke('list_github_issues', {
      projectPath: '/srv/project',
      state: 'open',
    })

    expect(invokeOnServer).toHaveBeenCalledWith(
      'remote-1',
      'list_github_issues',
      { projectPath: '/srv/project', state: 'open' }
    )
  })

  it('routes native shared commands to the selected remote Jean', async () => {
    const transport = await loadRemoteNativeTransportModule()

    transport.connectTransport()
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    await flushAsync()
    const ws = getWs(0)
    expect(ws.url).toBe('wss://jean.example.com/ws?token=secret')

    const request = transport.invoke('list_projects')
    await waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"command":"list_projects"')
      )
    )

    expect(fetch).toHaveBeenCalledWith(
      'https://jean.example.com/api/auth?token=secret',
      expect.objectContaining({ signal: expect.anything() })
    )
    const sent = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0]))
    ws.receive({ type: 'response', id: sent.id, data: [] })
    await request
  })

  it('keeps native menu listeners on the local shell for remote connections', async () => {
    const tauriListen = vi.fn().mockResolvedValue(() => {
      /* noop cleanup */
    })
    vi.doMock('@tauri-apps/api/event', () => ({ listen: tauriListen }))
    const transport = await loadRemoteNativeTransportModule()
    const handler = vi.fn()

    await transport.listenLocal('menu-quick-menu', handler)

    expect(tauriListen).toHaveBeenCalledWith('menu-quick-menu', handler)
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('makes native listener cleanup idempotent and contains teardown errors', async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValue(new Error('listener already gone'))
    const tauriListen = vi.fn().mockResolvedValue(cleanup)
    vi.doMock('@tauri-apps/api/event', () => ({ listen: tauriListen }))
    const transport = await loadNativeTransportModule(vi.fn())

    const unlisten = await transport.listen('chat:chunk', vi.fn())

    expect(unlisten()).toBeUndefined()
    expect(unlisten()).toBeUndefined()
    await flushAsync()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('explains how to troubleshoot a reachable remote rejected by the desktop client', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Load failed'))
    const transport = await loadRemoteNativeTransportModule()
    const { result } = renderHook(() => transport.useWsAuthError())

    transport.connectTransport()

    await waitFor(() =>
      expect(result.current).toBe(
        "Jean could not reach the server's authentication endpoint. Check that the server is running and the URL and port are correct. If the address opens in a browser, update and restart the remote Jean server so it allows desktop connections (CORS)."
      )
    )
    expect(result.current).not.toContain('secret')
  })

  it('exchanges a token link for a session without storing the token', async () => {
    const transport = await loadTransportModule()
    window.history.replaceState({}, '', '/?token=link-token&tab=1')

    transport.connectTransport()

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('api/auth?token=link-token'),
      expect.anything()
    )
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?tab=1')
    window.history.replaceState({}, '', '/')
  })

  it('migrates a token saved by an older version and deletes it', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(key =>
      key === 'jean-http-token' ? 'legacy-token' : null
    )
    const transport = await loadTransportModule()

    transport.connectTransport()

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('token=legacy-token'),
      expect.anything()
    )
    expect(localStorage.removeItem).toHaveBeenCalledWith('jean-http-token')
    vi.mocked(localStorage.getItem).mockImplementation(() => null)
  })

  it('reconnects with the session cookie when no token is present', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    expect(fetch).toHaveBeenCalledWith(
      expect.not.stringContaining('token='),
      expect.anything()
    )
  })

  it('signs out by revoking the server session', async () => {
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    const transport = await loadTransportModule()

    await transport.signOutOfWebAccess()

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('api/logout'), {
      method: 'POST',
    })
    expect(localStorage.removeItem).toHaveBeenCalledWith('jean-http-token')
    expect(replace).toHaveBeenCalled()
  })

  it('classifies a missing web access token as signed out', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response)
    const transport = await loadTransportModule()
    const signedOut = renderHook(() => transport.useWsAuthReason())

    transport.connectTransport()

    await waitFor(() => expect(signedOut.result.current).toBe('signed-out'))
    await flushAsync()
  })

  it('classifies and clears a refused web access token', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response)
    const transport = await loadTransportModule()
    const rejected = renderHook(() => transport.useWsAuthReason())
    window.history.replaceState({}, '', '/?token=refused-token')

    transport.connectTransport()

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('token=refused-token'),
        expect.anything()
      )
    )
    await waitFor(() => expect(rejected.result.current).toBe('rejected'))
    expect(localStorage.getItem('jean-http-token')).toBeNull()
  })

  it('still connects native remotes when appVersion mismatches', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, appVersion: '9.9.9' }),
    } as Response)

    const transport = await loadRemoteNativeTransportModule()
    const { result } = renderHook(() => transport.useWsAuthError())

    transport.connectTransport()

    // Mismatch only warns; auth error stays null and the socket still opens.
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    expect(result.current).toBeNull()
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

  it.each([
    ['open_file_in_default_app', { path: '/Users/jean/a.ts', editor: 'zed' }],
    ['open_worktree_in_finder', { worktreePath: '/Users/jean/project' }],
    [
      'open_worktree_in_editor',
      { worktreePath: '/Users/jean/project', editor: 'zed' },
    ],
    [
      'open_worktree_in_terminal',
      { worktreePath: '/Users/jean/project', terminal: 'ghostty' },
    ],
  ])(
    'keeps explicitly local %s on its native Tauri handler',
    async (command, args) => {
      const tauriInvoke = vi.fn().mockResolvedValue(undefined)
      const invokeOnServer = vi.fn()
      vi.doMock('./server-connections', () => ({ invokeOnServer }))
      const transport = await loadNativeTransportModule(tauriInvoke)

      await transport.invokeForOptionalServer('local', command, args)

      expect(tauriInvoke).toHaveBeenCalledWith(command, args)
      expect(invokeOnServer).not.toHaveBeenCalled()
    }
  )

  it('keeps path-routed local Open In commands on native Tauri handlers', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const transport = await loadNativeTransportModule(tauriInvoke)
    const { registerServerResourcePath } =
      await import('./server-command-routing')
    registerServerResourcePath('local', '/Users/jean/project')

    await transport.invoke('open_worktree_in_finder', {
      worktreePath: '/Users/jean/project',
    })

    expect(tauriInvoke).toHaveBeenCalledWith('open_worktree_in_finder', {
      worktreePath: '/Users/jean/project',
    })
  })

  it('keeps local IDs raw for commands routed by a base-session path', async () => {
    const sessions = {
      worktree_id: 'worktree-1',
      active_session_id: 'session-1',
      sessions: [{ id: 'session-1', worktree_id: 'worktree-1' }],
    }
    const tauriInvoke = vi.fn().mockResolvedValue(sessions)
    const transport = await loadNativeTransportModule(tauriInvoke)
    const { registerServerResourcePath } =
      await import('./server-command-routing')
    registerServerResourcePath('local', '/Users/jean/project')

    const result = await transport.invoke('get_sessions', {
      worktreeId: 'worktree-1',
      worktreePath: '/Users/jean/project',
    })

    expect(result).toEqual(sessions)
  })

  it('opens remote worktrees in local Zed via ssh:// targets', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const transport = await loadRemoteNativeTransportModule(
      {
        id: 'remote-1',
        name: 'Server',
        url: 'https://jean.example.com',
        token: 'secret',
        sshUser: 'ubuntu',
        sshHost: '192.168.1.50',
      },
      tauriInvoke
    )

    await transport.invoke('open_worktree_in_editor', {
      worktreePath: '/home/ubuntu/jean/app/feature',
      editor: 'zed',
    })

    expect(tauriInvoke).toHaveBeenCalledWith('open_worktree_in_editor', {
      worktreePath: 'ssh://ubuntu@192.168.1.50/home/ubuntu/jean/app/feature',
      editor: 'zed',
    })
  })

  it('opens an explicitly owned remote file in local Zed via ssh', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const invokeOnServer = vi.fn()
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadRemoteNativeTransportModule(
      {
        id: 'remote-1',
        name: 'Server',
        url: 'https://jean.example.com',
        token: 'secret',
        sshUser: 'ubuntu',
        sshHost: '192.168.1.50',
      },
      tauriInvoke
    )

    await transport.invokeForServer('remote-1', 'open_file_in_default_app', {
      path: '/home/ubuntu/jean/app/src/main.ts',
      editor: 'zed',
    })

    expect(tauriInvoke).toHaveBeenCalledWith('open_file_in_default_app', {
      path: 'ssh://ubuntu@192.168.1.50/home/ubuntu/jean/app/src/main.ts',
      editor: 'zed',
      line: undefined,
      column: undefined,
    })
    expect(invokeOnServer).not.toHaveBeenCalled()
  })

  it('opens remote worktrees in a local terminal through SSH', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const transport = await loadRemoteNativeTransportModule(
      {
        id: 'remote-1',
        name: 'Server',
        url: 'https://jean.example.com',
        token: 'secret',
        sshUser: 'ubuntu',
        sshHost: '192.168.1.50',
        sshPort: 2222,
      },
      tauriInvoke
    )

    await transport.invoke('open_worktree_in_terminal', {
      worktreePath: '/home/ubuntu/jean/app/feature',
      terminal: 'ghostty',
    })

    expect(tauriInvoke).toHaveBeenCalledWith('open_worktree_in_terminal', {
      worktreePath: '/home/ubuntu/jean/app/feature',
      terminal: 'ghostty',
      sshUser: 'ubuntu',
      sshHost: '192.168.1.50',
      sshPort: 2222,
    })
  })

  it('opens an owned remote worktree in local Zed instead of its headless server', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const invokeOnServer = vi.fn()
    vi.doMock('./server-connections', () => ({ invokeOnServer }))
    const transport = await loadRemoteNativeTransportModule(
      {
        id: 'remote-1',
        name: 'Server',
        url: 'https://jean.example.com',
        token: 'secret',
        sshUser: 'ubuntu',
        sshHost: '192.168.1.50',
      },
      tauriInvoke
    )
    const { registerServerResourcePath } =
      await import('./server-command-routing')
    registerServerResourcePath('remote-1', '/home/ubuntu/jean/app/feature')

    await transport.invoke('open_worktree_in_editor', {
      worktreePath: '/home/ubuntu/jean/app/feature',
      editor: 'zed',
    })

    expect(tauriInvoke).toHaveBeenCalledWith('open_worktree_in_editor', {
      worktreePath: 'ssh://ubuntu@192.168.1.50/home/ubuntu/jean/app/feature',
      editor: 'zed',
    })
    expect(invokeOnServer).not.toHaveBeenCalled()
  })

  it('prefers backend native-open over ssh:// remap when the remote allows it', async () => {
    // WSL/--allow-native-open headless: editor must go through WebSocket
    // dispatch (same as Finder/Terminal), not local Windows-side ssh://.
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const transport = await loadRemoteNativeTransportModule(
      {
        id: 'remote-1',
        name: 'WSL Jean',
        url: 'http://127.0.0.1:3456',
        token: 'secret',
      },
      tauriInvoke,
      { nativeOpenAllowed: true }
    )

    transport.connectTransport()
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    await flushAsync()
    const ws = getWs(0)

    const request = transport.invoke('open_worktree_in_editor', {
      worktreePath: '/home/ubuntu/jean/app/feature',
      editor: 'zed',
    })
    await waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"command":"open_worktree_in_editor"')
      )
    )
    // Resolve the pending WS invoke so it does not leak.
    const sent = JSON.parse(String(ws.send.mock.calls.at(-1)?.[0]))
    ws.receive({ type: 'response', id: sent.id, data: null })
    await request

    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('rejects non-Zed remote editor opens with a clear error', async () => {
    const tauriInvoke = vi.fn().mockResolvedValue(undefined)
    const transport = await loadRemoteNativeTransportModule(
      {
        id: 'remote-1',
        name: 'Server',
        url: 'https://jean.example.com',
        token: 'secret',
        sshUser: 'ubuntu',
        sshHost: '192.168.1.50',
      },
      tauriInvoke
    )

    await expect(
      transport.invoke('open_worktree_in_editor', {
        worktreePath: '/tmp',
        editor: 'vscode',
      })
    ).rejects.toThrow(/Zed/)
    expect(tauriInvoke).not.toHaveBeenCalled()
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

  it('gives an older server 25s for its first heartbeat, then its 50s window', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    vi.advanceTimersByTime(24_000)
    expect(ws.close).not.toHaveBeenCalled()

    ws.receive({ type: 'heartbeat' })
    vi.advanceTimersByTime(49_000)
    expect(ws.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_000)
    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('drops a socket that never sends a first heartbeat after 25s', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const ws = getWs(0)

    vi.advanceTimersByTime(25_000)
    expect(ws.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(ws.close).toHaveBeenCalledTimes(1)
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
    ws.receive({ type: 'heartbeat', interval_ms: 5_000 })

    // A suspended page: the clock moves on but no timer runs.
    vi.setSystemTime(Date.now() + 11_000)
    expect(ws.close).not.toHaveBeenCalled()
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('blocks the web view on wake until the socket answers a connection check', async () => {
    const transport = await loadTransportModule()
    const { result } = renderHook(() => transport.useWsConnectionChecking())

    await act(async () => {
      transport.connectTransport()
      await flushAsync()
    })
    const ws = getWs(0)

    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(result.current).toBe(true))
    expect(ws.send).toHaveBeenCalledTimes(1)
    const request = JSON.parse(ws.send.mock.calls[0]?.[0] ?? '')
    expect(request.command).toBe('get_server_platform')

    await act(async () => {
      ws.receive({ type: 'response', id: request.id, data: 'linux' })
    })
    await waitFor(() => expect(result.current).toBe(false))
    expect(ws.close).not.toHaveBeenCalled()
  })

  it('closes a zombie socket if the wake connection check does not answer', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const ws = getWs(0)
    // Server unreachable over HTTP too, so only the check timeout applies.
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))

    window.dispatchEvent(new Event('pageshow'))
    expect(
      transport.getLegacyWsTransport().getCheckingConnectionSnapshot()
    ).toBe(true)
    vi.advanceTimersByTime(3_000)
    await flushAsync()

    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('drops a silent socket after two announced heartbeat intervals', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const ws = getWs(0)

    ws.receive({ type: 'heartbeat', interval_ms: 5_000 })
    vi.advanceTimersByTime(9_000)
    expect(ws.close).not.toHaveBeenCalled()

    ws.receive({ type: 'heartbeat', interval_ms: 5_000 })
    vi.advanceTimersByTime(10_000)
    expect(ws.close).not.toHaveBeenCalled()

    // Checked every second: dead at most 11s after the last frame.
    vi.advanceTimersByTime(1_000)
    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('checks the socket when the network type changes', async () => {
    const connection = Object.assign(new EventTarget(), { type: 'wifi' })
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: connection,
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    })
    try {
      const transport = await loadTransportModule()
      transport.connectTransport()
      await flushAsync()
      const ws = getWs(0)

      // Bandwidth estimate change on the same network: no check.
      connection.dispatchEvent(new Event('change'))
      expect(ws.send).not.toHaveBeenCalled()

      connection.type = 'cellular'
      connection.dispatchEvent(new Event('change'))
      expect(ws.send).toHaveBeenCalledTimes(1)
      const request = JSON.parse(ws.send.mock.calls[0]?.[0] ?? '')
      expect(request.command).toBe('get_server_platform')
    } finally {
      Reflect.deleteProperty(navigator, 'connection')
    }
  })

  it('replaces a silent socket on wake once the server answers over HTTP', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const ws = getWs(0)

    window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch).toHaveBeenLastCalledWith(expect.stringMatching(/\/healthz$/))
    expect(ws.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('keeps a socket that delivers a frame during the wake check', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const ws = getWs(0)

    window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(1_000)
    ws.receive({ type: 'heartbeat', interval_ms: 5_000 })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(ws.close).not.toHaveBeenCalled()
  })

  it('retries at once on wake instead of waiting out the backoff', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    })
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()

    vi.mocked(fetch).mockRejectedValue(new TypeError('network changed'))
    getWs(0).close()
    // 250ms + 500ms + 1s + 2s of failed attempts: the next wait is 4s.
    await vi.advanceTimersByTimeAsync(3_750)
    expect(MockWebSocket.instances).toHaveLength(1)

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    window.dispatchEvent(new Event('online'))
    await flushAsync()

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(transport.isTransportConnected()).toBe(true)
  })

  it('aborts a sign-in probe that hangs on the old network when the page wakes', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    })
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()

    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    getWs(0).close()
    await vi.advanceTimersByTimeAsync(250)
    expect(MockWebSocket.instances).toHaveLength(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(250)

    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('keeps the first sign-in probe when pageshow fires during page load', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()
    window.dispatchEvent(new Event('pageshow'))
    await flushAsync()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(transport.isTransportConnected()).toBe(true)
  })

  it('reports a drop that is still in progress to a late recovery listener', async () => {
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()

    getWs(0).close()
    const disconnected = vi.fn()
    transport.onWsRecovery({ disconnected })

    expect(disconnected).toHaveBeenCalledTimes(1)
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

  it('reopens the socket in memory after an established connection closes', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()
    await transport.listen('chat:chunk', handler)

    transport.connectTransport()
    await flushAsync()

    getWs(0).close()
    expect(transport.isTransportConnected()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushAsync()

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(transport.isTransportConnected()).toBe(true)
    // Listeners registered before the drop receive the new socket's events.
    getWs(1).receive({
      type: 'event',
      event: 'chat:chunk',
      payload: { session_id: 's1', content: 'after' },
      seq: 9,
    })
    expect(handler).toHaveBeenCalledWith({
      payload: { session_id: 's1', content: 'after' },
    })
  })

  it('backs off from 250ms to 5s while the server stays unreachable', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    fetchMock.mockRejectedValue(new TypeError('offline'))

    getWs(0).close()
    const attemptsAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      return fetchMock.mock.calls.length
    }

    expect(await attemptsAt(249)).toBe(0)
    expect(await attemptsAt(1)).toBe(1) // 250ms
    expect(await attemptsAt(500)).toBe(2)
    expect(await attemptsAt(1_000)).toBe(3)
    expect(await attemptsAt(2_000)).toBe(4)
    expect(await attemptsAt(4_000)).toBe(5)
    expect(await attemptsAt(4_999)).toBe(5)
    expect(await attemptsAt(1)).toBe(6) // capped at 5s
    expect(await attemptsAt(5_000)).toBe(7)
  })

  it('retries at once when a socket that was up for a while drops', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    fetchMock.mockRejectedValue(new TypeError('offline'))

    await vi.advanceTimersByTimeAsync(5_000)
    getWs(0).close()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The retry failed: back to the normal backoff.
    await vi.advanceTimersByTimeAsync(499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects commands pending at the drop and runs commands sent during the gap', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()
    const fetchMock = vi.mocked(fetch)

    const pending = transport.invoke('send_chat_message', { message: 'hi' })
    const pendingResult = pending.catch((error: Error) => error.message)
    fetchMock.mockClear()
    getWs(0).close()
    expect(await pendingResult).toBe('WebSocket disconnected')

    // Sent while disconnected: waits for the backoff, does not start a
    // connection attempt of its own.
    const queued = transport.invoke<string>('get_server_platform')
    await flushAsync()
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(250)
    const sent = getWs(1).send.mock.calls.map(call => JSON.parse(call[0]))
    expect(sent.map(message => message.command)).toEqual([
      'get_server_platform',
    ])
    getWs(1).receive({ type: 'response', id: sent[0].id, data: 'linux' })
    await expect(queued).resolves.toBe('linux')
  })

  it('does not send a queued command whose caller already timed out', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    transport.connectTransport()
    await flushAsync()

    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'))
    getWs(0).close()
    const queued = transport
      .invoke('create_session', { name: 'x' })
      .catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await queued).toBe("Command 'create_session' timed out after 60s")

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(getWs(1).send).not.toHaveBeenCalled()
  })

  it('holds events after a reconnect until the app has resynced', async () => {
    const transport = await loadTransportModule()
    const received: string[] = []
    await transport.listen<{ content: string }>('chat:chunk', event => {
      received.push(event.payload.content)
    })
    let finishResync: () => void = () => undefined
    const disconnected = vi.fn()
    transport.onWsRecovery({
      disconnected,
      reconnected: () =>
        new Promise<void>(resolve => {
          finishResync = resolve
        }),
    })
    transport.connectTransport()
    await flushAsync()
    const chunk = (seq: number, content: string) => ({
      type: 'event',
      event: 'chat:chunk',
      payload: { session_id: 's1', content },
      seq,
    })
    getWs(0).receive(chunk(1, 'before'))

    getWs(0).close()
    expect(disconnected).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushAsync()

    getWs(1).receive(chunk(7, 'live-1'))
    getWs(1).receive(chunk(8, 'live-2'))
    expect(received).toEqual(['before'])

    finishResync()
    await flushAsync()
    expect(received).toEqual(['before', 'live-1', 'live-2'])

    getWs(1).receive(chunk(9, 'live-3'))
    expect(received).toEqual(['before', 'live-1', 'live-2', 'live-3'])
  })

  it('replays terminal output missed during the gap, in order', async () => {
    const transport = await loadTransportModule()
    const output: string[] = []
    await transport.listen<{ data: string }>('terminal:output', event => {
      output.push(event.payload.data)
    })
    let finishResync: () => void = () => undefined
    transport.onWsRecovery({
      disconnected: () => undefined,
      reconnected: () =>
        new Promise<void>(resolve => {
          finishResync = resolve
        }),
    })
    transport.connectTransport()
    await flushAsync()
    const term = (seq: number, data: string) => ({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 't1', data },
      seq,
    })
    getWs(0).receive(term(10, 'a'))

    getWs(0).close()
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushAsync()

    expect(JSON.parse(getWs(1).send.mock.calls[0]?.[0] ?? '')).toEqual({
      type: 'terminal_replay',
      terminal_id: 't1',
      last_seq: 10,
    })
    // Live output can overtake the replay of older output; one event of the
    // replay was already seen before the drop.
    getWs(1).receive(term(13, 'd'))
    getWs(1).receive(term(10, 'a'))
    getWs(1).receive(term(11, 'b'))
    getWs(1).receive(term(12, 'c'))
    finishResync()
    await flushAsync()

    expect(output).toEqual(['a', 'b', 'c', 'd'])
  })

  it('asks for a reload when the reconnect reaches a restarted server', async () => {
    const transport = await loadTransportModule()
    const reloadRequired = vi.fn()
    transport.onWsRecovery({ disconnected: () => undefined, reloadRequired })
    transport.connectTransport()
    await flushAsync()
    getWs(0).receive({ type: 'heartbeat', interval_ms: 5_000, boot_id: 'a' })

    getWs(0).close()
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushAsync()
    getWs(1).receive({ type: 'heartbeat', interval_ms: 5_000, boot_id: 'a' })
    expect(reloadRequired).not.toHaveBeenCalled()

    getWs(1).close()
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushAsync()
    getWs(2).receive({ type: 'heartbeat', interval_ms: 5_000, boot_id: 'b' })
    expect(reloadRequired).toHaveBeenCalledTimes(1)
  })

  it('asks for a reload instead of reconnecting when the server serves a new web build', async () => {
    const authBody = (webBuildId: string) =>
      ({ ok: true, json: async () => ({ ok: true, webBuildId }) }) as Response
    vi.mocked(fetch).mockResolvedValue(authBody('build-1'))
    const transport = await loadTransportModule()
    const reloadRequired = vi.fn()
    transport.onWsRecovery({ disconnected: () => undefined, reloadRequired })
    transport.connectTransport()
    await flushAsync()
    expect(MockWebSocket.instances).toHaveLength(1)

    vi.mocked(fetch).mockResolvedValue(authBody('build-2'))
    getWs(0).close()
    await new Promise(resolve => setTimeout(resolve, 300))
    await flushAsync()

    expect(reloadRequired).toHaveBeenCalledTimes(1)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnects a parallel remote adapter five seconds after disconnect', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()
    const adapter = new transport.WsTransport({
      serverId: 'remote-1',
      baseUrl: 'https://jean.example.com',
      getToken: () => 'secret',
      syncGlobalState: false,
    })

    adapter.enableConnect()
    await flushAsync()
    getWs(0).close()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(MockWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    await flushAsync()
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('builds authenticated project-file URLs for a remote server avatar', async () => {
    const transport = await loadRemoteNativeTransportModule({
      id: 'remote-1',
      name: 'Build server',
      url: 'https://jean.example.com/',
      token: 'secret token',
    })

    expect(
      transport.convertProjectFileSrc('remote-1', '/home/jean/project/icon.png')
    ).toBe(
      'https://jean.example.com/api/project-files/%2Fhome%2Fjean%2Fproject%2Ficon.png?token=secret%20token'
    )
    expect(
      transport.convertServerFileSrc('remote-1', 'project-avatars/icon.png')
    ).toBe(
      'https://jean.example.com/api/files/project-avatars/icon.png?token=secret%20token'
    )
    expect(
      transport.convertServerFileSrc(
        'remote-1',
        '/home/jean/.local/share/com.jean.desktop/pasted-images/image.png'
      )
    ).toBe(
      'https://jean.example.com/api/files/%2Fhome%2Fjean%2F.local%2Fshare%2Fcom.jean.desktop%2Fpasted-images%2Fimage.png?token=secret%20token'
    )
  })

  it('notifies recovery listeners of a disconnect synchronously', async () => {
    const transport = await loadTransportModule()
    const disconnected = vi.fn()

    transport.onWsRecovery({ disconnected })
    transport.connectTransport()
    await flushAsync()

    getWs(0).close()

    expect(disconnected).toHaveBeenCalledOnce()
  })

  it('uploads attachments to the remote server over HTTP, not the WebSocket', async () => {
    const transport = await loadRemoteNativeTransportModule()
    const saved = { id: 'f1', filename: 'clip.mp4', path: '/p/clip', size: 3 }
    vi.mocked(fetch).mockImplementation(async input =>
      String(input).includes('/api/pasted-files')
        ? ({ ok: true, status: 200, json: async () => saved } as Response)
        : ({
            ok: true,
            json: async () => ({ ok: true, appVersion: FALLBACK_APP_VERSION }),
          } as Response)
    )
    const file = new File(['abc'], 'clip.mp4', { type: 'video/mp4' })

    await expect(transport.savePastedFile(file, 'session-1')).resolves.toEqual(
      saved
    )

    const call = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes('/api/pasted-files'))
    expect(String(call?.[0])).toBe(
      'https://jean.example.com/api/pasted-files?filename=clip.mp4&token=secret'
    )
    expect(call?.[1]).toEqual({ method: 'POST', body: file })
  })
})
