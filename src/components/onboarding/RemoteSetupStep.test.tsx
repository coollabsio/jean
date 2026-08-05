import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSetupStep } from './RemoteSetupStep'

const {
  addRemoteConnection,
  selectConnection,
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
  invoke,
  isNativeApp,
  listenLocal,
  markConnectionSwitch,
} = vi.hoisted(() => ({
  addRemoteConnection: vi.fn(() => ({ id: 'remote-1' })),
  selectConnection: vi.fn(),
  fetchRemoteServerInfo: vi.fn(async () => ({
    ok: true,
    appVersion: '0.1.69',
    webBuildId: '0.1.69-test',
  })),
  warnRemoteVersionMismatch: vi.fn(() => false),
  invoke: vi.fn(),
  isNativeApp: vi.fn(() => true),
  listenLocal: vi.fn(async () => () => {
    // no-op unsubscribe
  }),
  markConnectionSwitch: vi.fn(),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  addRemoteConnection,
  markConnectionSwitch,
  parseOptionalSshPort: (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    const port = Number(trimmed)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be an integer between 1 and 65535.')
    }
    return port
  },
  parseRemoteConnectionInput: (url: string, token: string) => {
    const parsed = new URL(url)
    const resolvedToken =
      token.trim() || parsed.searchParams.get('token')?.trim() || ''
    parsed.search = ''
    return {
      url: parsed.toString().replace(/\/$/, ''),
      token: resolvedToken,
    }
  },
  selectConnection,
}))

vi.mock('@/lib/remote-version', () => ({
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeApp(),
}))

vi.mock('@/lib/transport', () => ({
  invoke,
  listenLocal,
}))

describe('RemoteSetupStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeApp.mockReturnValue(true)
    fetchRemoteServerInfo.mockResolvedValue({
      ok: true,
      appVersion: '0.1.69',
      webBuildId: '0.1.69-test',
    })
  })

  it('installs jean-server via SSH and connects', async () => {
    invoke.mockResolvedValue({
      name: 'build-box',
      url: 'http://192.168.1.50:3456',
      token: 'tok-abc',
      alreadyInstalled: false,
      installMode: 'system',
      ready: true,
      log: 'ok',
    })
    const reloadApp = vi.fn()
    render(<RemoteSetupStep reloadApp={reloadApp} />)

    expect(
      screen.getByRole('tab', { name: /Install via SSH/i })
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('SSH user'), {
      target: { value: 'ubuntu' },
    })
    fireEvent.change(screen.getByLabelText('Host / IP'), {
      target: { value: '192.168.1.50' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Install & Connect/i }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('install_remote_jean_server', {
        name: null,
        user: 'ubuntu',
        host: '192.168.1.50',
        sshPort: 22,
        jeanPort: 3456,
        userInstall: null,
      })
      expect(addRemoteConnection).toHaveBeenCalled()
      expect(selectConnection).toHaveBeenCalledWith('remote-1')
      expect(reloadApp).toHaveBeenCalled()
    })
  })

  it('connects with an existing Web Access URL', async () => {
    const reloadApp = vi.fn()
    render(<RemoteSetupStep reloadApp={reloadApp} />)

    fireEvent.click(screen.getByRole('tab', { name: /Existing URL/i }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Build server' },
    })
    fireEvent.change(screen.getByLabelText('Web Access URL'), {
      target: { value: 'https://jean.example.com/?token=secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }))

    await waitFor(() => {
      expect(addRemoteConnection).toHaveBeenCalledWith({
        name: 'Build server',
        url: 'https://jean.example.com/?token=secret',
        token: '',
        sshUser: undefined,
        sshHost: undefined,
        sshPort: 22,
      })
      expect(selectConnection).toHaveBeenCalledWith('remote-1')
      expect(reloadApp).toHaveBeenCalled()
    })
  })
})
