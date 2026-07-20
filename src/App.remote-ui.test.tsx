import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@/test/test-utils'
import type * as Environment from '@/lib/environment'
import type * as RemoteConnections from '@/lib/remote-connections'
import type * as Transport from '@/lib/transport'
import App from './App'

vi.mock('@/lib/remote-connections', async importOriginal => ({
  ...(await importOriginal<typeof RemoteConnections>()),
  getActiveRemoteConnection: () => ({
    id: 'remote-1',
    name: 'Build server',
    url: 'https://jean.example.com',
    token: 'secret',
  }),
}))

vi.mock('@/lib/build-info', () => ({
  CLIENT_BUILD_INFO: { appVersion: 'test' },
  CLIENT_WEB_BUILD_ID: 'test',
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof Environment>()),
  isNativeApp: () => true,
}))

vi.mock('@/lib/transport', async importOriginal => ({
  ...(await importOriginal<typeof Transport>()),
  connectTransport: vi.fn(),
  invoke: vi.fn(async (command: string) =>
    command === 'get_server_platform' ? 'linux' : null
  ),
  listen: vi.fn(async () => () => undefined),
  preloadInitialData: vi.fn(async () => null),
}))

vi.mock('./components/layout/MainWindow', () => ({
  default: () => <div>Local Jean UI</div>,
}))

vi.mock('./hooks/use-zoom', () => ({ useZoom: vi.fn() }))

describe('App remote UI', () => {
  it('keeps the bundled local React UI for an active native remote', async () => {
    render(<App />)

    expect(await screen.findByText('Local Jean UI')).toBeInTheDocument()
  })
})
