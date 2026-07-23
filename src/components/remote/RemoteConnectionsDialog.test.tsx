import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConnectionsDialog } from './RemoteConnectionsDialog'

const {
  addRemoteConnection,
  selectConnection,
  invoke,
  isNativeApp,
  listenLocal,
} = vi.hoisted(() => ({
  addRemoteConnection: vi.fn(() => ({ id: 'remote-1' })),
  selectConnection: vi.fn(),
  invoke: vi.fn(),
  isNativeApp: vi.fn(() => false),
  listenLocal: vi.fn(async () => () => {}),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  addRemoteConnection,
  getActiveConnectionId: () => 'local',
  removeRemoteConnection: vi.fn(),
  markConnectionSwitch: vi.fn(),
  selectConnection,
  updateRemoteConnection: vi.fn(),
  useRemoteConnections: () => [],
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeApp(),
}))

vi.mock('@/lib/transport', () => ({
  invoke,
  listenLocal,
}))

describe('RemoteConnectionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeApp.mockReturnValue(false)
  })

  it('adds and selects a remote from a complete Web Access URL', () => {
    render(<RemoteConnectionsDialog reloadApp={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jean connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Build server' },
    })
    fireEvent.change(screen.getByLabelText('Web Access URL'), {
      target: { value: 'https://jean.example.com/?token=secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }))

    expect(addRemoteConnection).toHaveBeenCalledWith({
      name: 'Build server',
      url: 'https://jean.example.com/?token=secret',
      token: '',
    })
    expect(selectConnection).toHaveBeenCalledWith('remote-1')
  })

  it('installs jean-server via SSH user and host in the native app', async () => {
    isNativeApp.mockReturnValue(true)
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

    render(<RemoteConnectionsDialog reloadApp={reloadApp} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jean connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))

    expect(
      screen.getByRole('button', { name: /Install via SSH/i })
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'build-box' },
    })
    fireEvent.change(screen.getByLabelText('SSH user'), {
      target: { value: 'ubuntu' },
    })
    fireEvent.change(screen.getByLabelText('Host / IP'), {
      target: { value: '192.168.1.50' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Install & Connect/i }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('install_remote_jean_server', {
        name: 'build-box',
        user: 'ubuntu',
        host: '192.168.1.50',
        sshPort: 22,
        jeanPort: 3456,
        userInstall: null,
      })
    })

    await waitFor(() => {
      expect(addRemoteConnection).toHaveBeenCalledWith({
        name: 'build-box',
        url: 'http://192.168.1.50:3456',
        token: 'tok-abc',
      })
      expect(selectConnection).toHaveBeenCalledWith('remote-1')
      expect(reloadApp).toHaveBeenCalled()
    })
  })

  it('can switch from install mode to existing URL mode', () => {
    isNativeApp.mockReturnValue(true)
    render(<RemoteConnectionsDialog reloadApp={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jean connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))
    fireEvent.click(screen.getByRole('button', { name: /Existing URL/i }))

    expect(screen.getByLabelText('Web Access URL')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save & Connect' })
    ).toBeInTheDocument()
  })
})
