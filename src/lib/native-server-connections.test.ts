import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isNativeApp,
  sync,
  dispose,
  subscribeRemoteConnections,
  getTransportConnections,
  subscribeSshTunnels,
  reconcileSshTunnels,
  stopSshTunnelEvents,
  hydrateSshSecrets,
  startSshTunnelEvents,
  refreshSshTunnelStatus,
} = vi.hoisted(() => ({
  isNativeApp: vi.fn(() => false),
  sync: vi.fn(),
  dispose: vi.fn(),
  subscribeRemoteConnections: vi.fn(() => vi.fn()),
  getTransportConnections: vi.fn(() => []),
  subscribeSshTunnels: vi.fn(() => vi.fn()),
  reconcileSshTunnels: vi.fn(async () => undefined),
  stopSshTunnelEvents: vi.fn(),
  hydrateSshSecrets: vi.fn(async () => undefined),
  startSshTunnelEvents: vi.fn(async () => undefined),
  refreshSshTunnelStatus: vi.fn(async () => undefined),
}))

vi.mock('./environment', () => ({ isNativeApp }))
vi.mock('./server-connections', () => ({
  serverConnectionManager: { sync, dispose },
}))
vi.mock('./remote-connections', () => ({
  getRemoteConnections: vi.fn(() => []),
  subscribeRemoteConnections,
}))
vi.mock('./transport', () => ({ getLegacyWsTransport: vi.fn() }))
vi.mock('./ssh-tunnel', () => ({
  getTransportConnections,
  subscribeSshTunnels,
  reconcileSshTunnels,
  stopSshTunnelEvents,
  hydrateSshSecrets,
  startSshTunnelEvents,
  refreshSshTunnelStatus,
}))

describe('native server connection bootstrap', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not start the connection manager in Web Access', async () => {
    const { startNativeServerConnections } =
      await import('./native-server-connections')

    const cleanup = await startNativeServerConnections()
    cleanup()

    expect(sync).not.toHaveBeenCalled()
    expect(subscribeRemoteConnections).not.toHaveBeenCalled()
  })

  it('starts and disposes the connection manager in native mode', async () => {
    isNativeApp.mockReturnValue(true)
    const { startNativeServerConnections } =
      await import('./native-server-connections')

    const cleanup = await startNativeServerConnections()
    cleanup()

    expect(sync).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledWith([], undefined)
    expect(subscribeRemoteConnections).toHaveBeenCalledOnce()
    expect(subscribeSshTunnels).toHaveBeenCalledOnce()
    expect(reconcileSshTunnels).toHaveBeenCalledOnce()
    expect(stopSshTunnelEvents).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
