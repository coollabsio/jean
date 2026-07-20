import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteConnectionsDialog } from './RemoteConnectionsDialog'

const { addRemoteConnection, selectConnection } = vi.hoisted(() => ({
  addRemoteConnection: vi.fn(() => ({ id: 'remote-1' })),
  selectConnection: vi.fn(),
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

describe('RemoteConnectionsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
