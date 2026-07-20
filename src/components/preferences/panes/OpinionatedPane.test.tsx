import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test/test-utils'
import { invoke } from '@/lib/transport'
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
    const superpowersRow = superpowersLabel.closest('.rounded-lg')
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

  it('shows opinionated skill installation status for each backend', async () => {
    render(<OpinionatedPane />)

    await screen.findByRole('button', { name: /Superpowers/i })

    const superpowersLabel = screen.getByText('Superpowers')
    const superpowersRow = superpowersLabel.closest('.rounded-lg')
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
    const cavemanHeader = cavemanLabel.closest('.rounded-lg')
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
    const header = superpowersLabel.closest('.rounded-lg')
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
    const rtkCard = rtkLabel.closest('.rounded-lg')
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
})
