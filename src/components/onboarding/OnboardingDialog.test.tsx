import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backendOptions } from '@/types/preferences'
import { useUIStore } from '@/store/ui-store'
import type * as PlatformModule from '@/lib/platform'
import type * as CliSetupComponentsModule from './CliSetupComponents'
import { AI_BACKENDS, CursorSetupState } from './OnboardingDialog'

const mocks = vi.hoisted(() => ({
  cursorInstalled: false,
  cursorAuthenticated: false,
  cursorAuthRefetchCount: 0,
  cursorInstallSucceeds: true,
  glabInstalled: false,
  glabPath: null as string | null,
  patchPreferences: vi.fn(
    (_patch: unknown, options?: { onSuccess?: () => void }) =>
      options?.onSuccess?.()
  ),
  patchPreferencesAsync: vi.fn().mockResolvedValue(undefined),
}))

function setupResult(installed = false, path: string | null = null) {
  return {
    status: { installed, version: installed ? '1.0.0' : null, path },
    isStatusLoading: false,
    versions: [],
    isVersionsLoading: false,
    isVersionsError: false,
    refetchVersions: vi.fn(),
    isInstalling: false,
    installError: null,
    progress: null,
    install: vi.fn(),
    refetchStatus: vi.fn(),
  }
}

function authResult(authenticated = false) {
  return {
    data: { authenticated },
    isLoading: false,
    isFetching: false,
    status: 'success',
    fetchStatus: 'idle',
    error: null,
    refetch: vi.fn().mockResolvedValue({ data: { authenticated } }),
  }
}

function pathResult(found = false, path: string | null = null) {
  return {
    data: { found, path, version: found ? '1.0.0' : null },
  }
}

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliSetup: () => setupResult(),
  useClaudeCliAuth: () => authResult(),
  useClaudePathDetection: () => pathResult(),
}))

vi.mock('@/services/codex-cli', () => ({
  useCodexCliSetup: () => setupResult(),
  useCodexCliAuth: () => authResult(),
  useCodexPathDetection: () => pathResult(),
}))

vi.mock('@/services/opencode-cli', () => ({
  useOpenCodeCliSetup: () => setupResult(),
  useOpenCodeCliAuth: () => authResult(),
  useOpenCodePathDetection: () => pathResult(),
}))

vi.mock('@/services/cursor-cli', () => ({
  getCursorInstallCommand: vi.fn().mockResolvedValue({
    command: '/bin/sh',
    args: ['-c', 'install-cursor'],
  }),
  useCursorPathDetection: () => pathResult(),
  useCursorCliStatus: () => ({
    data: {
      installed: mocks.cursorInstalled,
      version: null,
      path: mocks.cursorInstalled ? '/home/test/.local/bin/agent' : null,
    },
    isLoading: false,
    refetch: vi.fn().mockImplementation(async () => {
      mocks.cursorInstalled = mocks.cursorInstallSucceeds
      return {
        data: {
          installed: mocks.cursorInstalled,
          version: null,
          path: mocks.cursorInstalled ? '/home/test/.local/bin/agent' : null,
        },
      }
    }),
  }),
  useCursorCliAuth: () => ({
    ...authResult(mocks.cursorAuthenticated),
    refetch: vi.fn().mockImplementation(async () => {
      mocks.cursorAuthRefetchCount += 1
      mocks.cursorAuthenticated =
        mocks.cursorInstalled && mocks.cursorAuthRefetchCount >= 2
      return { data: { authenticated: mocks.cursorAuthenticated } }
    }),
  }),
}))

vi.mock('@/services/pi-cli', () => ({
  usePiCliSetup: () => setupResult(),
  usePiCliAuth: () => authResult(),
  usePiPathDetection: () => pathResult(),
}))

vi.mock('@/services/commandcode-cli', () => ({
  useCommandCodeCliSetup: () => setupResult(),
  useCommandCodeCliAuth: () => authResult(),
  useCommandCodePathDetection: () => pathResult(),
}))

vi.mock('@/services/grok-cli', () => ({
  useGrokCliSetup: () => setupResult(),
  useGrokCliAuth: () => authResult(),
  useGrokPathDetection: () => pathResult(),
}))

vi.mock('@/services/kimi-cli', () => ({
  useKimiCliSetup: () => setupResult(),
  useKimiCliAuth: () => authResult(),
  useKimiPathDetection: () => pathResult(),
}))

vi.mock('@/services/antigravity-cli', () => ({
  useAntigravityCliSetup: () => setupResult(),
  useAntigravityCliAuth: () => authResult(),
  useAntigravityPathDetection: () => pathResult(),
}))

vi.mock('@/services/gh-cli', () => ({
  useGhCliSetup: () => setupResult(true, '/usr/bin/gh'),
  useGhCliAuth: () => authResult(true),
  useGhPathDetection: () => pathResult(true, '/usr/bin/gh'),
}))

vi.mock('@/services/glab-cli', () => ({
  useGlabCliSetup: () => setupResult(mocks.glabInstalled, mocks.glabPath),
  useGlabCliAuth: () => authResult(false),
  useGlabPathDetection: () => pathResult(false),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      wsl_mode_chosen: true,
      claude_cli_source: 'path',
      codex_cli_source: 'path',
      opencode_cli_source: 'path',
      pi_cli_source: 'path',
      commandcode_cli_source: 'path',
      grok_cli_source: 'path',
      kimi_cli_source: 'path',
      antigravity_cli_source: 'path',
      gh_cli_source: 'path',
      glab_cli_source: 'path',
    },
  }),
  usePatchPreferences: () => ({
    mutate: mocks.patchPreferences,
    mutateAsync: mocks.patchPreferencesAsync,
  }),
}))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  isServerWindows: () => false,
}))

vi.mock('./CliSetupComponents', async importOriginal => {
  const original = await importOriginal<typeof CliSetupComponentsModule>()
  return {
    ...original,
    AuthLoginState: ({
      action = 'login',
      command,
      commandArgs,
      onComplete,
      onSkip,
    }: {
      action?: 'login' | 'install'
      command?: string
      commandArgs?: string[]
      onComplete: () => void
      onSkip?: () => void
    }) => (
      <div>
        {command && (
          <div data-testid="auth-login-command">
            {[command, ...(commandArgs ?? [])].join(' ')}
          </div>
        )}
        <button onClick={onComplete}>Complete Cursor {action}</button>
        {onSkip && <button onClick={onSkip}>Skip for Now</button>}
      </div>
    ),
    AuthCheckingState: ({ cliName }: { cliName: string }) => (
      <div>Checking {cliName}</div>
    ),
    CliPathSelector: ({
      cliName,
      onSelectPath,
      onSelectJean,
      onSkip,
    }: {
      cliName: string
      onSelectPath: () => void
      onSelectJean?: () => void
      onSkip?: () => void
    }) => (
      <div>
        <button onClick={onSelectPath}>Use {cliName} from PATH</button>
        {onSelectJean && (
          <button onClick={onSelectJean}>Use Jean-managed {cliName}</button>
        )}
        {onSkip && <button onClick={onSkip}>Skip for Now</button>}
      </div>
    ),
  }
})

describe('OnboardingDialog backends', () => {
  beforeEach(() => {
    mocks.cursorInstalled = false
    mocks.cursorAuthenticated = false
    mocks.cursorAuthRefetchCount = 0
    mocks.cursorInstallSucceeds = true
    mocks.glabInstalled = false
    mocks.glabPath = null
    mocks.patchPreferences.mockClear()
    mocks.patchPreferencesAsync.mockClear()
    useUIStore.setState({
      onboardingOpen: true,
      onboardingStartStep: null,
      onboardingManuallyTriggered: true,
      onboardingDismissed: false,
    })
  })

  it('offers every supported chat backend', () => {
    expect(AI_BACKENDS).toEqual(backendOptions.map(option => option.value))
  })

  it('lets users choose an installed Cursor Agent or run its installer', () => {
    const onUsePath = vi.fn()
    const onInstall = vi.fn()

    render(
      <CursorSetupState
        pathFound
        pathVersion="1.2.3"
        pathPath="/usr/local/bin/agent"
        onUsePath={onUsePath}
        onInstall={onInstall}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /use system cursor/i }))
    fireEvent.click(screen.getByRole('button', { name: /official installer/i }))

    expect(onUsePath).toHaveBeenCalledOnce()
    expect(onInstall).toHaveBeenCalledOnce()
  })

  async function chooseLocalAndContinue(
    user: ReturnType<typeof userEvent.setup>
  ) {
    expect(
      await screen.findByText('How will you use Jean?')
    ).toBeInTheDocument()
    // Local is the default selection
    await user.click(screen.getByRole('button', { name: 'Continue' }))
  }

  it('starts with local vs remote selection', async () => {
    const { OnboardingDialog } = await import('./OnboardingDialog')
    render(<OnboardingDialog />)

    expect(
      await screen.findByText('How will you use Jean?')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Local/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remote/i })).toBeInTheDocument()
  })

  it('shows remote setup after choosing remote', async () => {
    const user = userEvent.setup()
    const { OnboardingDialog } = await import('./OnboardingDialog')
    render(<OnboardingDialog />)

    await user.click(await screen.findByRole('button', { name: /Remote/i }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByText(/Install jean-server over SSH/i)
    ).toBeInTheDocument()
  })

  it('installs and authenticates Cursor before continuing to GitHub setup', async () => {
    const user = userEvent.setup()
    const { OnboardingDialog } = await import('./OnboardingDialog')
    render(<OnboardingDialog />)

    await chooseLocalAndContinue(user)
    await user.click(
      await screen.findByRole('checkbox', { name: /cursor cli/i })
    )
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(
      await screen.findByRole('button', { name: /^Install Cursor Agent/ })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor install' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor login' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Use GitHub CLI from PATH' })
    )
    // Optional GitLab CLI step after GitHub
    await user.click(
      await screen.findByRole('button', { name: 'Skip for Now' })
    )

    expect(await screen.findByText("You're Ready")).toBeInTheDocument()
    expect(screen.getByText('Cursor CLI: Installed')).toBeInTheDocument()
  })

  it('allows skipping optional GitHub CLI setup after an AI backend is ready', async () => {
    const user = userEvent.setup()
    const { OnboardingDialog } = await import('./OnboardingDialog')
    render(<OnboardingDialog />)

    await chooseLocalAndContinue(user)
    await user.click(
      await screen.findByRole('checkbox', { name: /cursor cli/i })
    )
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(
      await screen.findByRole('button', { name: /^Install Cursor Agent/ })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor install' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor login' })
    )

    expect(
      await screen.findByRole('button', { name: 'Skip for Now' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Use GitHub CLI from PATH' })
    ).toBeInTheDocument()

    // Skip GitHub CLI → optional GitLab CLI
    await user.click(screen.getByRole('button', { name: 'Skip for Now' }))
    expect(
      await screen.findByRole('button', { name: 'Skip for Now' })
    ).toBeInTheDocument()
    // Skip GitLab CLI → complete
    await user.click(screen.getByRole('button', { name: 'Skip for Now' }))

    expect(await screen.findByText("You're Ready")).toBeInTheDocument()
    expect(screen.getByText('Cursor CLI: Installed')).toBeInTheDocument()
  })

  it('uses the resolved Jean-managed glab binary for authentication', async () => {
    mocks.glabInstalled = true
    mocks.glabPath = '/app-data/cli/glab'
    const user = userEvent.setup()
    const { OnboardingDialog } = await import('./OnboardingDialog')
    render(<OnboardingDialog />)

    await chooseLocalAndContinue(user)
    await user.click(
      await screen.findByRole('checkbox', { name: /cursor cli/i })
    )
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(
      await screen.findByRole('button', { name: /^Install Cursor Agent/ })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor install' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor login' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Use GitHub CLI from PATH' })
    )
    await user.click(
      await screen.findByRole('button', {
        name: 'Use Jean-managed GitLab CLI',
      })
    )

    expect(await screen.findByTestId('auth-login-command')).toHaveTextContent(
      '/app-data/cli/glab auth login'
    )
  })

  it('returns to backend selection after a failed Cursor install check and Back', async () => {
    const user = userEvent.setup()
    mocks.cursorInstallSucceeds = false
    const { OnboardingDialog } = await import('./OnboardingDialog')
    render(<OnboardingDialog />)

    await chooseLocalAndContinue(user)
    await user.click(
      await screen.findByRole('checkbox', { name: /cursor cli/i })
    )
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(
      await screen.findByRole('button', { name: /^Install Cursor Agent/ })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Complete Cursor install' })
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Install Cursor Agent/ })
      ).toBeInTheDocument()
    )
    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(
      await screen.findByText(/Select additional AI backends to install/i)
    ).toBeInTheDocument()
  })
})
