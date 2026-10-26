import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('./environment', () => ({
  isNativeApp: () => true,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}))

describe('ssh tunnel transport', () => {
  beforeEach(async () => {
    invoke.mockReset()
    const connections = await import('./remote-connections')
    for (const connection of connections.getRemoteConnections()) {
      connections.removeRemoteConnection(connection.id)
    }
    localStorage.clear()
    const endpoint = await import('./ssh-tunnel-endpoint')
    endpoint.clearSshTransportEndpoints()
  })

  it('exposes a loopback URL only after the tunnel is ready and the token is in memory', async () => {
    const { addSshRemoteConnection } = await import('./remote-connections')
    const tunnels = await import('./ssh-tunnel')
    const profile = addSshRemoteConnection({
      id: 'ssh-profile-1',
      name: 'Loopback',
      token: 'secret-token',
      user: 'ubuntu',
      host: '10.0.0.8',
      hostKeyFingerprint: 'SHA256:abc',
    })

    expect(tunnels.getTransportConnections()).toEqual([])

    invoke.mockImplementation(async (command: string) => {
      if (command === 'list_ssh_tunnel_status') {
        return [
          {
            profileId: profile.id,
            status: 'ready',
            localUrl: 'http://127.0.0.1:4567',
            localPort: 4567,
            error: null,
            attempt: 0,
          },
        ]
      }
      if (command === 'load_ssh_profile_secrets') {
        return [{ profileId: profile.id, token: 'secret-token' }]
      }
      if (command === 'start_ssh_tunnel') {
        return {
          profileId: profile.id,
          status: 'ready',
          localUrl: 'http://127.0.0.1:4567',
          localPort: 4567,
          error: null,
          attempt: 0,
        }
      }
      return null
    })

    await tunnels.hydrateSshSecrets()
    await tunnels.refreshSshTunnelStatus()

    expect(tunnels.getTransportConnections()).toEqual([
      expect.objectContaining({
        id: profile.id,
        url: 'http://127.0.0.1:4567',
        token: 'secret-token',
      }),
    ])
  })

  it('does not restart a tunnel that already failed for the same settings', async () => {
    const { addSshRemoteConnection } = await import('./remote-connections')
    const tunnels = await import('./ssh-tunnel')
    addSshRemoteConnection({
      id: 'ssh-profile-2',
      name: 'Loopback',
      token: 'secret-token',
      user: 'ubuntu',
      host: '10.0.0.8',
      hostKeyFingerprint: 'SHA256:abc',
    })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'list_ssh_tunnel_status') {
        return [
          {
            profileId: 'ssh-profile-2',
            status: 'failed',
            localUrl: 'http://127.0.0.1:4567',
            localPort: 4567,
            error: 'SSH key authentication failed.',
            attempt: 1,
          },
        ]
      }
      return null
    })

    await tunnels.reconcileSshTunnels()

    expect(invoke).not.toHaveBeenCalledWith(
      'start_ssh_tunnel',
      expect.anything()
    )
  })
})
