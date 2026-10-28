import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import type * as KeybindingsPaneModule from './panes/KeybindingsPane'
import type * as MagicPromptsPaneModule from './panes/MagicPromptsPane'
import { PreferencesDialog } from './PreferencesDialog'
import type * as EnvironmentModule from '@/lib/environment'

const settingsServerMocks = vi.hoisted(() => ({
  native: false,
  connections: [] as {
    id: string
    name: string
    url: string
    token: string
  }[],
  snapshots: new Map(),
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => settingsServerMocks.native,
}))

vi.mock('@/hooks/use-window-maximized', () => ({
  useWindowMaximized: () => false,
}))

vi.mock('@/lib/remote-connections', () => ({
  useRemoteConnections: () => settingsServerMocks.connections,
}))

vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () => settingsServerMocks.snapshots,
}))

vi.mock('./panes/GeneralPane', () => ({
  GeneralPane: ({ scope }: { scope?: string }) => (
    <div>{scope ? `${scope} settings` : 'General pane'}</div>
  ),
}))

vi.mock('./panes/MusePane', () => ({
  MusePane: () => <div>Muse pane</div>,
}))

vi.mock('./panes/AntigravityPane', () => ({
  AntigravityPane: () => <div>Antigravity pane</div>,
}))

vi.mock('./panes/BackendProviders', () => ({
  ClaudeProvidersSection: () => <div>Claude providers</div>,
  CodexProvidersSection: () => <div>Codex providers</div>,
  PiProvidersSection: () => <div>PI providers</div>,
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['codex', 'muse'],
    isLoading: false,
  }),
}))

vi.mock('./panes/AppearancePane', () => ({
  AppearancePane: () => <div>Appearance pane</div>,
}))

vi.mock('./panes/KeybindingsPane', async importOriginal => {
  const actual = await importOriginal<typeof KeybindingsPaneModule>()
  return {
    ...actual,
    KeybindingsPane: () => <div>Keybindings pane</div>,
  }
})

vi.mock('./panes/TerminalPane', () => ({
  TerminalPane: () => <div>Terminal pane</div>,
}))

vi.mock('./panes/MagicPromptsPane', async importOriginal => {
  const actual = await importOriginal<typeof MagicPromptsPaneModule>()
  return {
    ...actual,
    MagicPromptsPane: () => <div>Magic prompts pane</div>,
  }
})

vi.mock('./panes/McpServersPane', () => ({
  McpServersPane: () => <div>MCP Servers pane</div>,
}))

vi.mock('./panes/UsagePane', () => ({
  UsagePane: () => <div>Usage pane</div>,
}))

vi.mock('./panes/IntegrationsPane', () => ({
  IntegrationsPane: () => <div>Integrations pane</div>,
}))

vi.mock('./panes/WebAccessPane', () => ({
  WebAccessPane: () => <div>Web access pane</div>,
}))

describe('PreferencesDialog', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
    settingsServerMocks.native = false
    settingsServerMocks.connections = []
    settingsServerMocks.snapshots = new Map()
    window.localStorage.clear()
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }

    useUIStore.setState({
      preferencesOpen: true,
      preferencesPane: null,
    })
  })

  it('opens as a near-fullscreen modal with a backdrop', () => {
    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.className).toContain('w-[96vw]')
    expect(dialog.className).toContain('h-[94dvh]')
    expect(dialog.className).toContain('max-w-[96vw]')
    expect(dialog.className).not.toContain('inset-0')
    expect(dialog.className).not.toContain('max-w-lg')

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).toBeTruthy()
    expect(overlay?.className).toContain('inset-0')
  })

  it('hides the rest of the page and keeps focus inside the modal', async () => {
    render(
      <>
        <button type="button">Outside preferences</button>
        <PreferencesDialog />
      </>
    )

    const outside = screen.getByRole('button', {
      name: 'Outside preferences',
      hidden: true,
    })
    expect(
      outside.closest('[aria-hidden="true"], [data-aria-hidden="true"]')
    ).not.toBeNull()

    outside.focus()
    await waitFor(() => {
      const dialog = screen.getByRole('dialog')
      expect(outside).not.toHaveFocus()
      expect(dialog.contains(document.activeElement)).toBe(true)
    })
  })

  it('closes when the backdrop is clicked', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    if (!overlay) {
      throw new Error('Expected preferences backdrop to be rendered')
    }

    await user.click(overlay)

    await waitFor(() => {
      expect(useUIStore.getState().preferencesOpen).toBe(false)
    })
  })

  it('closes on Escape when search and nested menus are closed', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(useUIStore.getState().preferencesOpen).toBe(false)
    })
  })

  it('keeps the dialog open when Escape dismisses an open pane select', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
    expect(useUIStore.getState().preferencesOpen).toBe(true)
  })

  it('selects the server whose settings are shown in native mode', async () => {
    const user = userEvent.setup()
    settingsServerMocks.native = true
    settingsServerMocks.connections = [
      {
        id: 'dev-server',
        name: 'Dev Server',
        url: 'http://dev.test',
        token: 'token',
      },
    ]
    settingsServerMocks.snapshots = new Map([
      ['dev-server', { status: 'online' }],
    ])

    render(<PreferencesDialog />)

    const selector = screen.getByRole('combobox', { name: 'Settings server' })
    expect(selector).toHaveTextContent('Local')
    await user.click(selector)
    await user.click(screen.getByRole('option', { name: 'Dev Server' }))

    expect(selector).toHaveTextContent('Dev Server')
  })

  it('still closes from the desktop header close button while search is open', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    const desktopHeaderActions = dialog.querySelector<HTMLElement>(
      '[data-slot="sidebar"]'
    )

    if (!desktopHeaderActions) {
      throw new Error('Expected desktop header actions to be rendered')
    }

    const desktopSearchInput =
      within(desktopHeaderActions).getByPlaceholderText('Search settings...')
    await user.type(desktopSearchInput, 'provider')

    const headerActions = dialog.querySelector<HTMLElement>('header .ml-auto')
    if (!headerActions) {
      throw new Error('Expected header actions to be rendered')
    }
    await user.click(
      within(headerActions).getByRole('button', { name: 'Close' })
    )

    await waitFor(() => {
      expect(useUIStore.getState().preferencesOpen).toBe(false)
    })
  })

  it('renders desktop settings navigation as one flat list', () => {
    render(<PreferencesDialog />)

    const navigationMenu = screen
      .getByRole('dialog')
      .querySelector<HTMLElement>('[data-sidebar="menu"]')
    if (!navigationMenu) {
      throw new Error('Expected desktop navigation menu to be rendered')
    }

    expect(
      within(navigationMenu)
        .getAllByRole('button')
        .map(button => button.textContent?.trim())
    ).toEqual([
      'General',
      'Appearance',
      'Keybindings',
      'Backends',
      'Terminal',
      'Magic Prompts',
      'Opinionated',
      'MCP Servers',
      'Integrations',
      'Web Access',
      'Usage',
    ])
    expect(
      navigationMenu.querySelectorAll(
        '[data-sidebar="separator"], [data-sidebar="group-label"]'
      )
    ).toHaveLength(0)
  })

  it('opens Backends on Claude and lists installed backends first', async () => {
    const user = userEvent.setup()
    render(<PreferencesDialog />)

    await user.click(screen.getByRole('button', { name: 'Backends' }))

    const tabs = within(screen.getByRole('tablist', { name: 'Backends' }))
      .getAllByRole('tab')
      .map(tab => tab.textContent)
    expect(tabs.slice(0, 3)).toEqual(['Codex', 'MuseBeta', 'Claude'])
    expect(tabs.slice(-2)).toEqual(['Git Provider', 'CodeRabbit CLI'])
    expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByText('claude settings')).toBeInTheDocument()
    expect(screen.getByText('Claude providers')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Muse/ }))
    expect(screen.getByText('Muse pane')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'General' }))
    await user.click(screen.getByRole('button', { name: 'Backends' }))
    expect(screen.getByText('Muse pane')).toBeInTheDocument()
  })

  it('maps an old backend deep link to Backends with that backend selected', () => {
    useUIStore.setState({ preferencesPane: 'devin' })
    render(<PreferencesDialog />)

    expect(screen.getByRole('tab', { name: /Devin/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByText('devin settings')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Backends' })).toHaveAttribute(
      'data-active',
      'true'
    )
    const breadcrumb = screen.getByRole('navigation', { name: 'breadcrumb' })
    expect(breadcrumb).toHaveTextContent('SettingsBackends')
    expect(within(breadcrumb).queryByRole('button')).toBeNull()
  })

  it('shows Web Access but hides Keybindings in the mobile pane selector', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    await user.click(screen.getByRole('combobox'))

    const options = screen
      .getAllByRole('option')
      .map(option => option.textContent?.trim())
    expect(options).toContain('Web Access')
    expect(options).not.toContain('Keybindings')
  })

  it('keeps the dialog open when Escape clears the desktop search', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    const desktopHeaderActions = dialog.querySelector<HTMLElement>(
      '[data-slot="sidebar"]'
    )

    if (!desktopHeaderActions) {
      throw new Error('Expected desktop header actions to be rendered')
    }

    const desktopSearchInput =
      within(desktopHeaderActions).getByPlaceholderText('Search settings...')
    await user.type(desktopSearchInput, 'provider')

    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(desktopSearchInput).toHaveValue('')
      expect(useUIStore.getState().preferencesOpen).toBe(true)
    })
  })

  it('keeps the dialog open when Escape clears the mobile search', async () => {
    const user = userEvent.setup()
    const previousWidth = window.innerWidth
    window.innerWidth = 500
    window.dispatchEvent(new Event('resize'))

    try {
      render(<PreferencesDialog />)

      const dialog = screen.getByRole('dialog')
      const mobileSearchInput = dialog.querySelector<HTMLInputElement>(
        'div.md\\:hidden input[placeholder="Search settings..."]'
      )

      if (!mobileSearchInput) {
        throw new Error('Expected mobile search input to be rendered')
      }

      await user.type(mobileSearchInput, 'claude')
      await user.keyboard('{Escape}')

      await waitFor(() => {
        expect(mobileSearchInput).toHaveValue('')
        expect(useUIStore.getState().preferencesOpen).toBe(true)
      })
    } finally {
      window.innerWidth = previousWidth
      window.dispatchEvent(new Event('resize'))
    }
  })

  it('highlights the first desktop search result after typing', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    const desktopHeaderActions = dialog.querySelector<HTMLElement>(
      '[data-slot="sidebar"]'
    )

    if (!desktopHeaderActions) {
      throw new Error('Expected desktop header actions to be rendered')
    }

    const desktopSearchInput =
      within(desktopHeaderActions).getByPlaceholderText('Search settings...')
    await user.type(desktopSearchInput, 'provider')

    await waitFor(() => {
      const searchItems =
        desktopHeaderActions.querySelectorAll<HTMLElement>('[cmdk-item]')
      expect(searchItems.length).toBeGreaterThan(0)
      expect(searchItems[0]).toHaveAttribute('aria-selected', 'true')
    })
  })
})
