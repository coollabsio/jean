import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteConnection } from './remote-connections'

const invokeMock = vi.hoisted(() => vi.fn())
const connectionMock = vi.hoisted(() =>
  vi.fn<() => RemoteConnection | null>(() => null)
)
const tunnelMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invoke: invokeMock,
}))

vi.mock('@/lib/remote-connections', () => ({
  getActiveRemoteConnection: connectionMock,
  subscribeRemoteConnections: () => () => undefined,
}))

vi.mock('@/lib/ssh-tunnel', () => ({
  getSshTunnelRuntime: tunnelMock,
}))

import {
  isLoopbackHost,
  planRemotePreview,
  previewUrlForLocalForward,
  resolveEmbeddedPreviewUrl,
  sshPreviewNote,
} from './remote-preview'

function sshConnection(): RemoteConnection {
  return {
    id: 'profile-1',
    name: 'Build box',
    url: 'http://127.0.0.1',
    token: 'secret',
    transport: 'ssh',
    sshTunnel: {
      user: 'ubuntu',
      host: 'build.example',
      hostKeyFingerprint: 'SHA256:abc',
    },
  }
}

function directConnection(url = 'http://devbox.local:3456'): RemoteConnection {
  return {
    id: 'direct-1',
    name: 'Dev box',
    url,
    token: 'secret',
  }
}

describe('remote preview planning', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    connectionMock.mockReset()
    connectionMock.mockReturnValue(null)
    tunnelMock.mockReset()
    tunnelMock.mockReturnValue(undefined)
  })

  it('leaves local and public URLs unchanged', () => {
    expect(planRemotePreview('http://localhost:5173', null, null)).toEqual({
      kind: 'unchanged',
    })
    expect(
      planRemotePreview('https://example.com', sshConnection(), 'ready')
    ).toEqual({ kind: 'unchanged' })
    expect(planRemotePreview('about:blank', sshConnection(), 'ready')).toEqual({
      kind: 'unchanged',
    })
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(true)
    expect(isLoopbackHost('devbox.local')).toBe(false)
  })

  it('rewrites a direct remote loopback URL onto that host', () => {
    expect(
      planRemotePreview(
        'http://localhost:5173/app?x=1#top',
        directConnection(),
        null
      )
    ).toEqual({
      kind: 'direct',
      url: 'http://devbox.local:5173/app?x=1#top',
      note: 'Remote preview of Dev box at devbox.local:5173.',
    })
  })

  it('keeps a loopback direct connection on this computer', () => {
    expect(
      planRemotePreview(
        'http://localhost:3000',
        directConnection('http://127.0.0.1:3456'),
        null
      )
    ).toEqual({ kind: 'unchanged' })
  })

  it('uses an explicit jean.json host as written', () => {
    expect(
      planRemotePreview('http://192.168.1.42:8000', directConnection(), null)
    ).toEqual({ kind: 'unchanged' })
  })

  it('asks for an SSH forward only while the tunnel is ready', () => {
    expect(
      planRemotePreview('http://[::1]:3000/docs', sshConnection(), 'ready')
    ).toEqual({
      kind: 'ssh',
      profileId: 'profile-1',
      sshHost: 'build.example',
      remotePort: 3000,
    })
    const blocked = planRemotePreview(
      'http://localhost:3000',
      sshConnection(),
      'reconnecting'
    )
    expect(blocked.kind).toBe('error')
    if (blocked.kind === 'error') {
      expect(blocked.message).toContain('reconnecting')
      expect(blocked.message).toContain('build.example')
    }
  })

  it('builds the forwarded URL on the same port', () => {
    expect(previewUrlForLocalForward('http://localhost:5173/app', 5173)).toBe(
      'http://127.0.0.1:5173/app'
    )
    expect(sshPreviewNote('build.example', 5173, 5173)).toContain(
      '127.0.0.1:5173'
    )
  })

  it('does not open this computer when the SSH forward fails', async () => {
    connectionMock.mockReturnValue(sshConnection())
    tunnelMock.mockReturnValue({ status: 'ready' })
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'release_ssh_preview_forwards') return undefined
      throw 'Port 3000 is already in use on this computer'
    })

    await expect(
      resolveEmbeddedPreviewUrl('http://localhost:3000')
    ).rejects.toThrow(/already in use/)
    expect(invokeMock).toHaveBeenCalledWith('ensure_ssh_preview_forward', {
      profileId: 'profile-1',
      remotePort: 3000,
    })
  })

  it('navigates SSH previews through the local forward', async () => {
    connectionMock.mockReturnValue(sshConnection())
    tunnelMock.mockReturnValue({ status: 'ready', localPort: 41000 })
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'ensure_ssh_preview_forward') {
        return { profileId: 'profile-1', remotePort: 5173, localPort: 5173 }
      }
      return undefined
    })

    await expect(
      resolveEmbeddedPreviewUrl('http://0.0.0.0:5173/app')
    ).resolves.toEqual({
      url: 'http://127.0.0.1:5173/app',
      note: sshPreviewNote('build.example', 5173, 5173),
    })
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'release_ssh_preview_forwards',
      {
        keepProfileId: 'profile-1',
      }
    )
  })

  it('releases forwards before a local loopback preview', async () => {
    connectionMock.mockReturnValue(null)
    invokeMock.mockResolvedValue(undefined)

    await expect(
      resolveEmbeddedPreviewUrl('http://localhost:3000')
    ).resolves.toEqual({ url: 'http://localhost:3000', note: null })
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('release_ssh_preview_forwards', {
      keepProfileId: null,
    })
  })

  it('leaves a local public URL alone', async () => {
    connectionMock.mockReturnValue(null)
    await expect(
      resolveEmbeddedPreviewUrl('https://example.com')
    ).resolves.toEqual({
      url: 'https://example.com',
      note: null,
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
