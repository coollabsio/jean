import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPreferences } from '@/types/preferences'
import { defaultPreferences } from '@/types/preferences'

const mutateMock = vi.fn()
const invokeMock = vi.fn()
const openLoginMock = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()

let preferences: AppPreferences = defaultPreferences
let claudePath: string | null = '/usr/bin/claude'
let codexPath: string | null = '/usr/bin/codex'

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: preferences }),
  usePatchPreferences: () => ({ mutate: mutateMock }),
  preferencesQueryKeys: {
    all: ['preferences'] as const,
    preferences: (serverId = 'local') =>
      serverId === 'local'
        ? (['preferences'] as const)
        : (['preferences', 'server', serverId] as const),
  },
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  invokeForServer: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => ({
    data: {
      installed: Boolean(claudePath),
      path: claudePath,
      version: '1',
      supports_auth_command: true,
    },
  }),
}))

vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => ({
    data: { installed: Boolean(codexPath), path: codexPath, version: '1' },
  }),
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: (
    selector: (state: { openCliLoginModal: typeof openLoginMock }) => unknown
  ) => selector({ openCliLoginModal: openLoginMock }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

import { ProviderAccountsSection } from './ProviderAccountsSection'

beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProviderAccountsSection)
    )
  )
}

describe('ProviderAccountsSection', () => {
  beforeEach(() => {
    mutateMock.mockReset()
    invokeMock.mockReset()
    openLoginMock.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
    claudePath = '/usr/bin/claude'
    codexPath = '/usr/bin/codex'
    preferences = {
      ...defaultPreferences,
      provider_accounts: [
        { id: 'work-acct', backend: 'codex', label: 'Work' },
        { id: 'personal1', backend: 'claude', label: 'Personal' },
      ],
      default_provider_accounts: {},
    }
  })

  it('creates a named account for the selected backend', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue({
      id: 'new-acct1',
      backend: 'claude',
      label: 'Work',
    })
    renderSection()

    await user.type(screen.getByLabelText('Account name'), 'Work')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(invokeMock).toHaveBeenCalledWith('create_provider_account', {
      backend: 'claude',
      label: 'Work',
    })
  })

  it('saves the current CLI login into an account and can delete it', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(['auth.json'])
    renderSection()

    await user.click(
      screen.getByRole('button', { name: 'Save current login for Work' })
    )
    expect(invokeMock).toHaveBeenCalledWith('capture_provider_account_auth', {
      id: 'work-acct',
    })

    await user.click(screen.getByRole('button', { name: 'Delete Personal' }))
    expect(invokeMock).toHaveBeenCalledWith('delete_provider_account', {
      id: 'personal1',
    })
  })

  it('opens the CLI login for an account and explains a missing CLI', async () => {
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole('button', { name: 'Sign in Work' }))
    expect(openLoginMock).toHaveBeenCalledWith('codex', '/usr/bin/codex', [
      'login',
      '--device-auth',
    ])

    cleanup()
    codexPath = null
    renderSection()
    await user.click(screen.getByRole('button', { name: 'Sign in Work' }))
    expect(toastError).toHaveBeenCalledWith(
      'Install the Codex CLI in Settings → General before signing in'
    )
  })

  it('sets the default account used by new sessions', async () => {
    const user = userEvent.setup()
    renderSection()

    await user.click(
      screen.getByRole('combobox', { name: 'Default Codex account' })
    )
    await user.click(screen.getByRole('option', { name: 'Work' }))

    expect(mutateMock).toHaveBeenCalledWith({
      default_provider_accounts: { codex: 'work-acct' },
    })
  })
})
