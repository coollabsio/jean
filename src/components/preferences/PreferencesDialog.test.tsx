import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import type * as KeybindingsPaneModule from './panes/KeybindingsPane'
import type * as MagicPromptsPaneModule from './panes/MagicPromptsPane'
import { PreferencesDialog } from './PreferencesDialog'

vi.mock('./panes/GeneralPane', () => ({
  GeneralPane: () => <div>General pane</div>,
}))

vi.mock('./panes/ClaudePane', () => ({
  ClaudePane: () => <div>Claude pane</div>,
}))

vi.mock('./panes/CodexPane', () => ({
  CodexPane: () => <div>Codex pane</div>,
}))

vi.mock('./panes/OpenCodePane', () => ({
  OpenCodePane: () => <div>OpenCode pane</div>,
}))

vi.mock('./panes/CursorPane', () => ({
  CursorPane: () => <div>Cursor pane</div>,
}))

vi.mock('./panes/GitHubPane', () => ({
  GitHubPane: () => <div>GitHub CLI pane</div>,
}))

vi.mock('./panes/CodeRabbitPane', () => ({
  CodeRabbitPane: () => <div>CodeRabbit CLI pane</div>,
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

vi.mock('./panes/ProvidersPane', () => ({
  ProvidersPane: () => <div>Providers pane</div>,
}))

vi.mock('./panes/UsagePane', () => ({
  UsagePane: () => <div>Usage pane</div>,
}))

vi.mock('./panes/IntegrationsPane', () => ({
  IntegrationsPane: () => <div>Integrations pane</div>,
}))

vi.mock('./panes/ExperimentalPane', () => ({
  ExperimentalPane: () => <div>Experimental pane</div>,
}))

vi.mock('./panes/WebAccessPane', () => ({
  WebAccessPane: () => <div>Web access pane</div>,
}))

describe('PreferencesDialog', () => {
  beforeEach(() => {
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

  it('still closes from the desktop header close button while search is open', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    const desktopHeaderActions = dialog.querySelector<HTMLElement>(
      'div[class~="ml-auto"][class~="lg:flex"]'
    )

    if (!desktopHeaderActions) {
      throw new Error('Expected desktop header actions to be rendered')
    }

    const desktopSearchInput =
      within(desktopHeaderActions).getByPlaceholderText('Search settings...')
    await user.type(desktopSearchInput, 'provider')

    await user.click(
      within(desktopHeaderActions).getByRole('button', { name: 'Close' })
    )

    await waitFor(() => {
      expect(useUIStore.getState().preferencesOpen).toBe(false)
    })
  })

  it('renders desktop settings navigation in grouped order', () => {
    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    const navigationMenu = dialog.querySelector<HTMLElement>(
      '[data-sidebar="menu"]'
    )

    if (!navigationMenu) {
      throw new Error('Expected desktop navigation menu to be rendered')
    }

    expect(
      within(navigationMenu)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual([
      'General',
      'Appearance',
      'Keybindings',
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'PI',
      'Command Code',
      'Grok',
      'Kimi Code',
      'Antigravity CLIBeta',
      'GitHub CLI',
      'CodeRabbit CLI',
      'Terminal',
      'Magic Prompts',
      'Opinionated',
      'Providers',
      'Web Access',
      'MCP Servers',
      'Integrations',
      'Usage',
      'Experimental',
    ])
    // Separators appear between sections (not before the first "App" section)
    expect(
      navigationMenu.querySelectorAll('[data-sidebar="separator"]')
    ).toHaveLength(5)
    expect(
      Array.from(
        navigationMenu.querySelectorAll('[data-sidebar="group-label"]')
      ).map(label => label.textContent)
    ).toEqual([
      'App',
      'Backends',
      'Tools',
      'Connectivity',
      'Account',
      'Advanced',
    ])

    for (const label of ['PI', 'Command Code', 'Grok']) {
      const button = within(navigationMenu).getByText(label).closest('button')
      if (!button) {
        throw new Error(`Expected ${label} navigation button to be rendered`)
      }

      expect(within(button).queryByText('Beta')).toBeNull()
    }

    const antigravityButton = within(navigationMenu)
      .getByText('Antigravity CLI')
      .closest('button')
    if (!antigravityButton) {
      throw new Error(
        'Expected Antigravity CLI navigation button to be rendered'
      )
    }

    expect(within(antigravityButton).getByText('Beta')).toHaveClass(
      'bg-yellow-500/10'
    )

    const kimiButton = within(navigationMenu)
      .getByText('Kimi Code')
      .closest('button')
    if (!kimiButton) {
      throw new Error('Expected Kimi Code navigation button to be rendered')
    }

    expect(within(kimiButton).getByLabelText('Kimi Code')).toHaveClass(
      'translate-x-0.5'
    )
  })

  it('keeps the dialog open when Escape clears the desktop search', async () => {
    const user = userEvent.setup()

    render(<PreferencesDialog />)

    const dialog = screen.getByRole('dialog')
    const desktopHeaderActions = dialog.querySelector<HTMLElement>(
      'div[class~="ml-auto"][class~="lg:flex"]'
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
      'div[class~="ml-auto"][class~="lg:flex"]'
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
