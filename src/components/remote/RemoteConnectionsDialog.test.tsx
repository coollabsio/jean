import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConnectionsDialog } from './RemoteConnectionsDialog'

const {
  addRemoteConnection,
  selectConnection,
  fetchRemoteServerInfo,
  getLocalJeanVersion,
  warnRemoteVersionMismatch,
} = vi.hoisted(() => ({
  addRemoteConnection: vi.fn(() => ({ id: 'remote-1' })),
  selectConnection: vi.fn(),
  fetchRemoteServerInfo: vi.fn(async () => ({
    ok: true,
    appVersion: '0.1.69',
    webBuildId: '0.1.69-test',
  })),
  getLocalJeanVersion: vi.fn(() => '0.1.69'),
  warnRemoteVersionMismatch: vi.fn(() => false),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  addRemoteConnection,
  getActiveConnectionId: () => 'local',
  removeRemoteConnection: vi.fn(),
  markConnectionSwitch: vi.fn(),
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
  updateRemoteConnection: vi.fn(),
  useRemoteConnections: () => [],
}))

vi.mock('@/lib/remote-version', () => ({
  checkRemoteVersionCompatibility: (remote: string | null | undefined) => ({
    compatible: !remote || remote === '0.1.69',
    localVersion: '0.1.69',
    remoteVersion: remote ?? null,
    message: remote
      ? `This Jean app is v0.1.69, but the remote server is v${remote}.`
      : undefined,
  }),
  fetchRemoteServerInfo,
  formatJeanVersionLabel: (version: string | null | undefined) =>
    version ? `v${version.replace(/^v/, '')}` : 'version unknown',
  getLocalJeanVersion,
  warnRemoteVersionMismatch,
}))

describe('RemoteConnectionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRemoteServerInfo.mockResolvedValue({
      ok: true,
      appVersion: '0.1.69',
      webBuildId: '0.1.69-test',
    })
    warnRemoteVersionMismatch.mockReturnValue(false)
  })

  it('adds and selects a remote from a complete Web Access URL', async () => {
    const reloadApp = vi.fn()
    render(<RemoteConnectionsDialog reloadApp={reloadApp} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jean connections' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Build server' },
    })
    fireEvent.change(screen.getByLabelText('Web Access URL'), {
      target: { value: 'https://jean.example.com/?token=secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }))

    await waitFor(() => {
      expect(fetchRemoteServerInfo).toHaveBeenCalledWith(
        'https://jean.example.com',
        'secret'
      )
      expect(addRemoteConnection).toHaveBeenCalledWith({
        name: 'Build server',
        url: 'https://jean.example.com/?token=secret',
        token: '',
      })
      expect(selectConnection).toHaveBeenCalledWith('remote-1')
      expect(reloadApp).toHaveBeenCalled()
    })
  })

  it('shows local version and still connects when remote mismatches', async () => {
    fetchRemoteServerInfo.mockResolvedValueOnce({
      ok: true,
      appVersion: '0.2.0',
      webBuildId: '0.2.0-test',
    })
    warnRemoteVersionMismatch.mockReturnValueOnce(true)

    const reloadApp = vi.fn()
    render(<RemoteConnectionsDialog reloadApp={reloadApp} />)

    fireEvent.click(screen.getByRole('button', { name: 'Jean connections' }))
    expect(
      screen.getByText(/This app is v0\.1\.69; a warning is shown/)
    ).toBeInTheDocument()
    expect(screen.getByText('v0.1.69')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))
    fireEvent.change(screen.getByLabelText('Web Access URL'), {
      target: { value: 'https://jean.example.com/?token=secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }))

    await waitFor(() => {
      expect(warnRemoteVersionMismatch).toHaveBeenCalledWith('0.2.0')
      expect(addRemoteConnection).toHaveBeenCalled()
      expect(selectConnection).toHaveBeenCalledWith('remote-1')
      expect(reloadApp).toHaveBeenCalled()
    })
  })
})
