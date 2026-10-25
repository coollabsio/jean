import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { StartOnHostPicker } from './StartOnHost'
import type * as EnvironmentModule from '@/lib/environment'

const connections = vi.hoisted(() => ({
  native: true,
  remotes: [
    {
      id: 'remote-a',
      name: 'Build box',
      url: 'http://127.0.0.1:3456',
      token: 'token',
      enabled: true,
    },
  ],
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => connections.native,
}))

vi.mock('@/lib/remote-connections', () => ({
  useRemoteConnections: () => connections.remotes,
}))

vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () =>
    new Map([
      [
        'remote-a',
        {
          serverId: 'remote-a',
          name: 'Build box',
          status: 'online',
          lastConnectedAt: null,
          error: null,
          appVersion: null,
          capabilities: {},
        },
      ],
    ]),
}))

describe('StartOnHostPicker', () => {
  beforeEach(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false)
    Element.prototype.setPointerCapture = vi.fn()
    Element.prototype.releasePointerCapture = vi.fn()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('lists Local and each connected remote', async () => {
    connections.native = true
    const user = userEvent.setup()
    render(<StartOnHostPicker value="local" onChange={() => undefined} />)
    await user.click(screen.getByLabelText('Start on'))
    expect(screen.getByRole('option', { name: 'Local' })).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Build box' })
    ).toBeInTheDocument()
  })

  it('stays hidden when this Jean has no remote connections', () => {
    connections.remotes = []
    render(<StartOnHostPicker value="local" onChange={() => undefined} />)
    expect(screen.queryByLabelText('Start on')).not.toBeInTheDocument()
    connections.remotes = [
      {
        id: 'remote-a',
        name: 'Build box',
        url: 'http://127.0.0.1:3456',
        token: 'token',
        enabled: true,
      },
    ]
  })
})
