import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteServerRefreshButton } from './RemoteServerRefreshButton'

const reconnect = vi.fn()

vi.mock('@/lib/server-connections', () => ({
  reconnectRemoteServer: (serverId: string) => reconnect(serverId),
}))

describe('RemoteServerRefreshButton', () => {
  beforeEach(() => reconnect.mockClear())

  it('reconnects the named remote server', async () => {
    render(
      <RemoteServerRefreshButton serverId="dev" serverName="Dev Server" />
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Reconnect Dev Server' })
    )

    expect(reconnect).toHaveBeenCalledWith('dev')
  })
})
