import { beforeEach, describe, expect, it, vi } from 'vitest'

const { isNativeApp, sync, dispose, subscribeRemoteConnections } = vi.hoisted(
  () => ({
    isNativeApp: vi.fn(() => false),
    sync: vi.fn(),
    dispose: vi.fn(),
    subscribeRemoteConnections: vi.fn(() => vi.fn()),
  })
)

vi.mock('./environment', () => ({ isNativeApp }))
vi.mock('./server-connections', () => ({
  serverConnectionManager: { sync, dispose },
}))
vi.mock('./remote-connections', () => ({
  getRemoteConnections: vi.fn(() => []),
  subscribeRemoteConnections,
}))
vi.mock('./transport', () => ({ getLegacyWsTransport: vi.fn() }))

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
    expect(dispose).toHaveBeenCalledOnce()
  })
})
