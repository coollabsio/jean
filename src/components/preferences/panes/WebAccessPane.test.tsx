import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { WebAccessPane } from './WebAccessPane'
import { copyToClipboard } from '@/lib/clipboard'
import { defaultPreferences } from '@/types/preferences'

const invokeMock = vi.fn()
const isNativeAppMock = vi.fn(() => false)

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeAppMock(),
  hasBackend: () => true,
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('@/lib/platform', () => ({
  isMacOS: false,
  isWindows: false,
  isLinux: true,
  getServerPlatform: vi.fn(() => 'linux'),
  isServerWindows: vi.fn(() => false),
  openExternal: vi.fn(),
}))

describe('WebAccessPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeAppMock.mockReturnValue(false)
    invokeMock.mockImplementation((command: string) => {
      if (command === 'load_preferences')
        return Promise.resolve(defaultPreferences)
      if (command === 'get_http_server_status') {
        return Promise.resolve({
          running: true,
          port: 3456,
          url: 'http://0.0.0.0:3456',
          token: 'secret-token',
          bind_host: '0.0.0.0',
          localhost_only: false,
        })
      }
      if (command === 'list_http_bind_host_options') return Promise.resolve([])
      return Promise.resolve(null)
    })
  })

  it('shows web access settings read-only in browser/headless mode', async () => {
    render(<WebAccessPane />)

    await waitFor(() => {
      expect(screen.getByText('Running')).toBeInTheDocument()
    })
    expect(screen.getByText(/read-only in web access/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('secret-token')).toBeInTheDocument()
    for (const control of screen.getAllByRole('switch')) {
      expect(control).toBeDisabled()
    }
    expect(screen.getByDisplayValue('3456')).toBeDisabled()
    expect(screen.getByDisplayValue('127.0.0.1')).toBeDisabled()
    // Token show + copy, plus open + copy for the localhost URL — no regenerate
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  it('keeps web access settings editable in the desktop app', async () => {
    isNativeAppMock.mockReturnValue(true)
    render(<WebAccessPane />)

    await waitFor(() => {
      expect(screen.getByText('Running')).toBeInTheDocument()
    })
    expect(
      screen.queryByText(/read-only in web access/i)
    ).not.toBeInTheDocument()
    for (const control of screen.getAllByRole('switch')) {
      expect(control).toBeEnabled()
    }
    expect(screen.getByDisplayValue('127.0.0.1')).toBeEnabled()
  })

  it('URL-encodes legacy padded tokens in copied URLs', async () => {
    const token = 'ab+c/d=='
    invokeMock.mockImplementation((command: string) => {
      if (command === 'load_preferences')
        return Promise.resolve(defaultPreferences)
      if (command === 'get_http_server_status') {
        return Promise.resolve({
          running: true,
          port: 3456,
          url: 'http://0.0.0.0:3456',
          token,
          bind_host: '0.0.0.0',
          localhost_only: false,
        })
      }
      if (command === 'list_http_bind_host_options') return Promise.resolve([])
      return Promise.resolve(null)
    })
    render(<WebAccessPane />)

    await waitFor(() => {
      expect(screen.getByText('Running')).toBeInTheDocument()
    })
    // Buttons: token show, token copy, localhost open, localhost copy
    fireEvent.click(screen.getAllByRole('button')[3] as HTMLElement)

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled())
    const copied = vi.mocked(copyToClipboard).mock.calls[0]?.[0] as string
    expect(new URL(copied).searchParams.get('token')).toBe(token)
  })
})
