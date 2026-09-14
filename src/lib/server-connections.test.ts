import { describe, expect, it, vi } from 'vitest'
import type { RemoteConnection } from './remote-connections'
import { ServerConnectionManager } from './server-connections'

function remote(id: string): RemoteConnection {
  return {
    id,
    name: `Server ${id}`,
    url: `https://${id}.test`,
    token: `${id}-token`,
    enabled: true,
  }
}

function adapter() {
  return {
    connected: true,
    authError: null,
    enableConnect: vi.fn(),
    invoke: vi.fn(async (): Promise<unknown> => 'ok'),
    listen: vi.fn(
      (_event: string, _handler: (event: { payload: unknown }) => void) => () =>
        undefined
    ),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  }
}

describe('ServerConnectionManager', () => {
  it('routes by server and isolates removal', async () => {
    const adapters = { r1: adapter(), r2: adapter() }
    const invokeLocal = vi.fn(async () => 'local')
    const manager = new ServerConnectionManager({
      isNative: () => true,
      invokeLocal,
      createRemote: connection => adapters[connection.id as 'r1' | 'r2'],
    })

    manager.sync([remote('r1'), remote('r2')])
    await expect(manager.invoke('r2', 'list_projects')).resolves.toBe('ok')
    await expect(manager.invoke('local', 'list_projects')).resolves.toBe(
      'local'
    )
    manager.sync([remote('r2')])

    expect(adapters.r2.invoke).toHaveBeenCalledWith('list_projects', undefined)
    expect(adapters.r1.invoke).not.toHaveBeenCalledWith(
      'list_projects',
      undefined
    )
    expect(adapters.r1.dispose).toHaveBeenCalledOnce()
    expect(manager.getSnapshot().get('r2')?.status).toBe('online')
    expect([...manager.getSnapshot().values()]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ token: 'r2-token' })])
    )
  })

  it('does not create remote adapters in Web Access', () => {
    const createRemote = vi.fn(() => adapter())
    const manager = new ServerConnectionManager({
      isNative: () => false,
      invokeLocal: vi.fn(),
      createRemote,
    })

    manager.sync([remote('r1')])

    expect(createRemote).not.toHaveBeenCalled()
    expect(manager.getSnapshot().size).toBe(0)
  })

  it('reuses the selected legacy transport without creating a duplicate', () => {
    const selected = adapter()
    const createRemote = vi.fn(() => adapter())
    const manager = new ServerConnectionManager({
      isNative: () => true,
      invokeLocal: vi.fn(),
      createRemote,
    })

    manager.sync([remote('r1')], { serverId: 'r1', adapter: selected })

    expect(createRemote).not.toHaveBeenCalled()
    expect(selected.enableConnect).not.toHaveBeenCalled()
    expect(manager.getSnapshot().get('r1')?.status).toBe('online')
  })

  it('isolates an incompatible server after capability negotiation', async () => {
    const incompatible = adapter()
    incompatible.invoke.mockResolvedValue({
      schemaVersion: 1,
      appVersion: 'future',
      apiProtocol: 3,
      apiProtocolMin: 2,
      capabilities: {},
      featureSurfaces: [],
      magicPrompts: [],
    })
    const manager = new ServerConnectionManager({
      isNative: () => true,
      invokeLocal: vi.fn(),
      createRemote: () => incompatible,
    })

    manager.sync([remote('future')])
    await vi.waitFor(() => {
      expect(manager.getSnapshot().get('future')?.status).toBe('incompatible')
    })
    expect(incompatible.invoke).toHaveBeenCalledWith('get_server_capabilities')
  })

  it('scopes equal event ids and follows adapter changes', () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    const adapters = { r1: adapter(), r2: adapter() }
    adapters.r1.listen.mockImplementation((_event, handler) => {
      handlers.set('r1', handler)
      return () => {
        handlers.delete('r1')
      }
    })
    adapters.r2.listen.mockImplementation((_event, handler) => {
      handlers.set('r2', handler)
      return () => {
        handlers.delete('r2')
      }
    })
    const manager = new ServerConnectionManager({
      isNative: () => true,
      invokeLocal: vi.fn(),
      createRemote: connection => adapters[connection.id as 'r1' | 'r2'],
    })
    const received: unknown[] = []
    const unlisten = manager.listenAllRemotes('chat:done', event =>
      received.push(event)
    )

    manager.sync([remote('r1'), remote('r2')])
    handlers.get('r1')?.({ payload: { session_id: 'same' } })
    handlers.get('r2')?.({ payload: { session_id: 'same' } })
    manager.sync([remote('r2')])

    expect(received).toEqual([
      { serverId: 'r1', payload: { session_id: 'r1:same' } },
      { serverId: 'r2', payload: { session_id: 'r2:same' } },
    ])
    expect(handlers.has('r1')).toBe(false)
    unlisten()
    expect(handlers.size).toBe(0)
  })
})
