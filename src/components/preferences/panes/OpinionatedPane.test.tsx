import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test/test-utils'
import { invoke } from '@/lib/transport'
import { openExternal } from '@/lib/platform'
import { useUIStore } from '@/store/ui-store'
import { OpinionatedPane } from './OpinionatedPane'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  openExternal: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('OpinionatedPane', () => {
  beforeEach(() => {
    useUIStore.getState().closeCliLoginModal()
    vi.clearAllMocks()
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'check_opinionated_plugin_status') {
        return {
          installed: true,
          version: 'codex',
          backends: [
            { id: 'claude', label: 'Claude', installed: false },
            { id: 'codex', label: 'Codex', installed: true },
            { id: 'opencode', label: 'OpenCode', installed: false },
            { id: 'cursor', label: 'Cursor', installed: true },
            { id: 'pi', label: 'Pi', installed: false },
            { id: 'commandcode', label: 'Command Code', installed: false },
            { id: 'grok', label: 'Grok', installed: false },
          ],
        }
      }
      if (command === 'uninstall_opinionated_plugin') {
        return 'Uninstalled'
      }
      throw new Error(`Unexpected command ${command}`)
    })
  })

  it('shows uninstall for installed skill packs and invokes uninstall command', async () => {
    const user = userEvent.setup()

    render(<OpinionatedPane />)

    await screen.findByRole('button', { name: /Superpowers/i })

    const superpowersLabel = screen.getByText('Superpowers')
    const superpowersRow = superpowersLabel.closest('.rounded-md')
    if (!superpowersRow) throw new Error('Expected Superpowers row')
    const superpowersUninstall = within(
      superpowersRow as HTMLElement
    ).getByRole('button', { name: /Uninstall/i })
    await user.click(superpowersUninstall)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('uninstall_opinionated_plugin', {
        pluginName: 'superpowers',
      })
    })
  })

  it('offers pstack for every Jean AI backend', async () => {
    render(<OpinionatedPane />)

    const pstackLabel = await screen.findByText('pstack')
    const pstackCard = pstackLabel.closest('.rounded-md')?.parentElement
    if (!pstackCard) throw new Error('Expected pstack card')

    await userEvent.click(pstackLabel)

    expect(
      within(pstackCard as HTMLElement).getByText('Codex')
    ).toBeInTheDocument()
    expect(
      within(pstackCard as HTMLElement).getByText('Claude')
    ).toBeInTheDocument()
    expect(
      within(pstackCard as HTMLElement).getByText('Command Code')
    ).toBeInTheDocument()
    expect(
      within(pstackCard as HTMLElement).getByText('/poteto-mode')
    ).toBeInTheDocument()
    expect(
      within(pstackCard as HTMLElement).queryByText('/setup-pstack')
    ).not.toBeInTheDocument()
  })

  it('offers tstack for every Jean AI backend', async () => {
    render(<OpinionatedPane />)

    const tstackLabel = await screen.findByText('tstack')
    const tstackCard = tstackLabel.closest('.rounded-md')?.parentElement
    if (!tstackCard) throw new Error('Expected tstack card')

    await userEvent.click(tstackLabel)

    expect(
      within(tstackCard as HTMLElement).getByText('Codex')
    ).toBeInTheDocument()
    expect(
      within(tstackCard as HTMLElement).getByText('Claude')
    ).toBeInTheDocument()
    expect(
      within(tstackCard as HTMLElement).getByText('Command Code')
    ).toBeInTheDocument()
    expect(
      within(tstackCard as HTMLElement).getByText('council')
    ).toBeInTheDocument()
    expect(
      within(tstackCard as HTMLElement).getByText('full send')
    ).toBeInTheDocument()
  })

  it('shows opinionated skill installation status for each backend', async () => {
    render(<OpinionatedPane />)

    await screen.findByRole('button', { name: /Superpowers/i })

    const superpowersLabel = screen.getByText('Superpowers')
    const superpowersRow = superpowersLabel.closest('.rounded-md')
    if (!superpowersRow) throw new Error('Expected Superpowers row')

    await userEvent.click(
      within(superpowersRow as HTMLElement).getByText('Superpowers')
    )

    expect(screen.getByText('Backend status')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('Pi')).toBeInTheDocument()
    expect(screen.getByText('Command Code')).toBeInTheDocument()
    expect(screen.getByText('Grok')).toBeInTheDocument()
    expect(screen.getAllByText('Not installed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Installed').length).toBeGreaterThan(0)
  })

  it('shows partial status when an installed skill pack is missing backends', async () => {
    render(<OpinionatedPane />)

    await screen.findByRole('button', { name: /Caveman/i })

    const cavemanLabel = screen.getByText('Caveman')
    const cavemanHeader = cavemanLabel.closest('.rounded-md')
    if (!cavemanHeader) throw new Error('Expected Caveman card header')

    expect(
      within(cavemanHeader as HTMLElement).getByText('Partial')
    ).toBeInTheDocument()
    expect(
      within(cavemanHeader as HTMLElement).getByText('Reinstall')
    ).toBeInTheDocument()
  })

  it('uses a stacked, wrapping card header for narrow screens', async () => {
    render(<OpinionatedPane />)

    await screen.findByRole('button', { name: /Superpowers/i })

    const superpowersLabel = screen.getByText('Superpowers')
    const header = superpowersLabel.closest('.rounded-md')
    if (!header) throw new Error('Expected Superpowers card header')

    expect(header).toHaveClass('flex-col')
    expect(header).toHaveClass('sm:flex-row')
    expect(
      within(header as HTMLElement)
        .getByText('Reinstall')
        .closest('span')
    ).toHaveClass('flex-wrap')
  })

  it('disables unsupported RTK installation and explains why', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (
        command === 'check_opinionated_plugin_status' &&
        (args as { pluginName?: string })?.pluginName === 'rtk'
      ) {
        return {
          installed: false,
          version: null,
          install_supported: false,
          unsupported_reason:
            "RTK's Linux ARM64 binary requires glibc 2.39 or newer; this system has glibc 2.35",
        }
      }
      if (command === 'check_opinionated_plugin_status') {
        return { installed: false, version: null, install_supported: true }
      }
      throw new Error(`Unexpected command ${command}`)
    })

    render(<OpinionatedPane />)

    const rtkLabel = await screen.findByText('RTK')
    const rtkCard = rtkLabel.closest('.rounded-md')
    if (!rtkCard) throw new Error('Expected RTK card')

    expect(
      within(rtkCard as HTMLElement).getByRole('button', {
        name: 'Unsupported',
      })
    ).toBeDisabled()

    await userEvent.click(rtkLabel)
    expect(
      screen.getByText(/requires glibc 2\.39 or newer/)
    ).toBeInTheDocument()
  })

  it('describes CLIProxyAPI as an external localhost proxy and can start it', async () => {
    const user = userEvent.setup()
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const pluginName = (args as { pluginName?: string })?.pluginName
      if (command === 'check_opinionated_plugin_status') {
        if (pluginName === 'cliproxyapi') {
          return {
            installed: true,
            version: 'v8.0.43',
            install_supported: true,
            running: false,
            endpoint: 'http://127.0.0.1:8317',
            management_url: 'http://127.0.0.1:8317/management.html',
            lan_exposed: false,
            auth_file_count: 0,
          }
        }
        return { installed: false, version: null, install_supported: true }
      }
      if (command === 'start_opinionated_plugin') {
        return 'CLIProxyAPI is running at http://127.0.0.1:8317'
      }
      if (command === 'prepare_cliproxyapi_account_login') {
        const provider = (args as { provider?: string })?.provider
        return {
          provider,
          binary: '/home/ada/.jean/opinionated/cliproxyapi/cli-proxy-api',
          args: [
            '--config',
            '/home/ada/.jean/opinionated/cliproxyapi/config.yaml',
            provider === 'codex' ? '-codex-login' : '-claude-login',
          ],
          started_proxy: true,
          message:
            'CLIProxyAPI was stopped, so Jean started it. Jean does not keep a copy.',
        }
      }
      throw new Error(`Unexpected command ${command}`)
    })

    render(<OpinionatedPane />)

    const label = await screen.findByText('CLIProxyAPI')
    const card = label.closest('.rounded-md')?.parentElement
    if (!card) throw new Error('Expected CLIProxyAPI card')

    expect(within(card as HTMLElement).getByText('Stopped')).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText('Local proxy (localhost)')
    ).toBeInTheDocument()

    await user.click(label)

    expect(
      within(card as HTMLElement).getByText(
        /pooling and round-robin outside Jean/i
      )
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText(
        /does not store extra Claude or Codex/i
      )
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText(/127\.0\.0\.1:8317\/v1/)
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText(/-claude-login/)
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText(/not in Jean/i)
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText(/0 OAuth files in CLIProxyAPI/)
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByText(
        /Jean does not read or copy those files/
      )
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).getByRole('button', { name: 'MIT license' })
    ).toBeInTheDocument()
    expect(
      within(card as HTMLElement).queryByRole('button', {
        name: 'EasyCLIProxyAPI',
      })
    ).not.toBeInTheDocument()

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Add Claude account',
      })
    )

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('prepare_cliproxyapi_account_login', {
        provider: 'claude',
      })
    })
    expect(useUIStore.getState().cliLoginModalOpen).toBe(true)
    expect(useUIStore.getState().cliLoginModalType).toBe('cliproxyapi')
    expect(useUIStore.getState().cliLoginModalCommand).toBe(
      '/home/ada/.jean/opinionated/cliproxyapi/cli-proxy-api'
    )
    expect(useUIStore.getState().cliLoginModalCommandArgs).toEqual([
      '--config',
      '/home/ada/.jean/opinionated/cliproxyapi/config.yaml',
      '-claude-login',
    ])
    useUIStore.getState().closeCliLoginModal()

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Add Codex account',
      })
    )
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('prepare_cliproxyapi_account_login', {
        provider: 'codex',
      })
    })
    expect(useUIStore.getState().cliLoginModalCommandArgs).toEqual([
      '--config',
      '/home/ada/.jean/opinionated/cliproxyapi/config.yaml',
      '-codex-login',
    ])
    useUIStore.getState().closeCliLoginModal()

    await user.click(
      within(card as HTMLElement).getByRole('button', {
        name: 'Open management',
      })
    )
    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        'http://127.0.0.1:8317/management.html'
      )
    })
    expect(invoke).toHaveBeenCalledWith('start_opinionated_plugin', {
      pluginName: 'cliproxyapi',
    })

    await user.click(
      within(card as HTMLElement).getByRole('button', { name: 'Start' })
    )

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('start_opinionated_plugin', {
        pluginName: 'cliproxyapi',
      })
    })
  })
})
