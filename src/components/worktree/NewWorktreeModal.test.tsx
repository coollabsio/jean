import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { NewWorktreeModal } from './NewWorktreeModal'
import type * as EnvironmentModule from '@/lib/environment'
import type * as PreferencesModule from '@/services/preferences'

const mocks = vi.hoisted(() => ({
  isMobile: false,
  isNativeApp: false,
  preferences: {
    default_backend: 'codex',
    selected_model: 'sonnet',
    magic_prompt_models: {
      investigate_issue_model: 'gpt-5.6-sol-fast',
      investigate_pr_model: 'sonnet',
    },
    magic_prompt_backends: { investigate_pr_backend: 'claude' },
    custom_cli_profiles: [{ name: 'Team', settings_json: '{}' }],
  },
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => mocks.isNativeApp,
}))

vi.mock('@/services/preferences', async importOriginal => ({
  ...(await importOriginal<typeof PreferencesModule>()),
  usePreferences: () => ({ data: mocks.preferences }),
}))
vi.mock('@/hooks/useGhLogin', () => ({ useGhLogin: () => ({}) }))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: ['claude', 'codex'] }),
}))
vi.mock('./hooks/useNewWorktreeData', () => ({
  useNewWorktreeData: () => ({
    selectedProject: { name: 'Test' },
    createWorktree: {},
    createBaseSession: {},
  }),
}))
vi.mock('./hooks/useNewWorktreeHandlers', () => ({
  useNewWorktreeHandlers: () => ({}),
}))
vi.mock('./hooks/useNewWorktreeKeyboard', () => ({
  useNewWorktreeKeyboard: () => ({}),
}))
vi.mock('./GitHubIssuesTab', () => ({ GitHubIssuesTab: () => null }))
vi.mock('./GitHubPRsTab', () => ({ GitHubPRsTab: () => null }))
vi.mock('./QuickActionsTab', () => ({ QuickActionsTab: () => null }))

beforeEach(() => {
  mocks.isMobile = false
  mocks.isNativeApp = false
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
  useUIStore.setState({
    newWorktreeModalOpen: true,
    newWorktreeModalDefaultTab: 'issues',
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        return undefined
      }
      unobserve() {
        return undefined
      }
      disconnect() {
        return undefined
      }
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

describe('NewWorktreeModal investigation selector', () => {
  it.each([
    { mode: 'native desktop', native: true, mobile: false },
    { mode: 'web', native: false, mobile: false },
    { mode: 'mobile', native: false, mobile: true },
  ])(
    'scopes models and providers to the backend on $mode',
    async ({ native, mobile }) => {
      mocks.isNativeApp = native
      mocks.isMobile = mobile
      const user = userEvent.setup()
      render(<NewWorktreeModal />)

      expect(
        screen.queryByRole('combobox', { name: 'Investigation provider' })
      ).toBeNull()
      await user.click(
        screen.getByRole('button', { name: 'Choose backend and model' })
      )
      expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      const list = screen.getByRole('listbox')
      expect(within(list).queryByText(/Sonnet/)).toBeNull()
      await user.click(screen.getByRole('tab', { name: 'Claude' }))
      expect(within(list).queryByText(/GPT/)).toBeNull()
      await user.click(within(list).getByText('Sonnet 4.6'))
      expect(
        screen.getByRole('combobox', { name: 'Investigation provider' })
      ).toHaveTextContent('Anthropic')
      await user.click(
        screen.getByRole('combobox', { name: 'Investigation provider' })
      )
      await user.click(screen.getByRole('option', { name: 'Team' }))
      await user.click(
        screen.getByRole('button', { name: 'Choose backend and model' })
      )
      expect(
        within(screen.getByRole('listbox')).getByText('Sonnet')
      ).toBeInTheDocument()
      expect(within(screen.getByRole('listbox')).queryByText(/GPT/)).toBeNull()
    }
  )

  it('keeps the selected backend when unrelated preferences refresh', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<NewWorktreeModal />)
    await user.click(
      screen.getByRole('button', { name: 'Choose backend and model' })
    )
    await user.click(screen.getByRole('tab', { name: 'Claude' }))
    await user.click(
      within(screen.getByRole('listbox')).getByText('Sonnet 4.6')
    )
    mocks.preferences = { ...mocks.preferences }
    rerender(<NewWorktreeModal />)
    expect(
      screen.getByRole('combobox', { name: 'Investigation provider' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Choose backend and model' })
    ).toHaveTextContent('Claude')
  })

  it('loads the PR investigation defaults when switching tabs', async () => {
    const user = userEvent.setup()
    render(<NewWorktreeModal />)
    await user.click(screen.getByRole('button', { name: /PRs/ }))
    expect(
      screen.getByRole('combobox', { name: 'Investigation provider' })
    ).toHaveTextContent('Anthropic')
    await user.click(
      screen.getByRole('button', { name: 'Choose backend and model' })
    )
    expect(screen.getByRole('tab', { name: 'Claude' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })
})
