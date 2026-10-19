import { useSyncExternalStore } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backendOptions } from '@/types/preferences'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import type * as PlatformModule from '@/lib/platform'
import type * as EnvironmentModule from '@/lib/environment'
import type * as CliSetupComponentsModule from './CliSetupComponents'
import { AI_BACKENDS, OnboardingDialog } from './OnboardingDialog'

type CliKey =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'pi'
  | 'commandcode'
  | 'grok'
  | 'kimi'
  | 'devin'
  | 'antigravity'
  | 'muse'
  | 'gh'
  | 'glab'

interface CliMock {
  installed: boolean
  authenticated: boolean
  pathFound: boolean
  install: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const keys = [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'pi',
    'commandcode',
    'grok',
    'kimi',
    'devin',
    'antigravity',
    'muse',
    'gh',
    'glab',
  ] as const
  const cli = Object.fromEntries(
    keys.map(key => [
      key,
      {
        installed: false,
        authenticated: false,
        pathFound: false,
        install: vi.fn(),
      },
    ])
  )
  return {
    keys,
    cli: cli as Record<(typeof keys)[number], CliMock>,
    nativeApp: true,
    serverWindows: false,
    wslChosen: true,
    patchPreferencesAsync: vi.fn(),
    // Mock hook state lives outside React; bump to re-render subscribers the
    // way a React Query update would.
    version: 0,
    listeners: new Set<() => void>(),
    checkSystemPrerequisites: vi.fn(),
  }
})

function useMockVersion() {
  return useSyncExternalStore(
    listener => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    },
    () => mocks.version
  )
}

function useSetupResult(key: CliKey) {
  useMockVersion()
  const state = mocks.cli[key]
  return {
    status: {
      installed: state.installed,
      version: state.installed ? '1.0.0' : null,
      path: state.installed ? `/usr/bin/${key}` : null,
      supports_auth_command: true,
    },
    isStatusLoading: false,
    versions: [
      { version: '3.0.0-beta.1', prerelease: true },
      { version: '2.0.0', prerelease: false },
    ],
    isVersionsLoading: false,
    isVersionsError: false,
    refetchVersions: vi.fn(),
    isInstalling: false,
    installError: null,
    progress: null,
    install: state.install,
    refetchStatus: vi.fn(async () => ({
      data: { installed: mocks.cli[key].installed },
    })),
  }
}

function authResult(key: CliKey) {
  const state = mocks.cli[key]
  return {
    data: { authenticated: state.authenticated },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(async () => ({
      data: { authenticated: mocks.cli[key].authenticated },
    })),
  }
}

function pathResult(key: CliKey) {
  const state = mocks.cli[key]
  return {
    data: {
      found: state.pathFound,
      path: state.pathFound ? `/usr/local/bin/${key}` : null,
      version: state.pathFound ? '1.0.0' : null,
    },
    isLoading: false,
  }
}

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => mocks.nativeApp,
}))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  isServerWindows: () => mocks.serverWindows,
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliSetup: () => useSetupResult('claude'),
  useClaudeCliAuth: () => authResult('claude'),
  useClaudePathDetection: () => pathResult('claude'),
}))
vi.mock('@/services/codex-cli', () => ({
  useCodexCliSetup: () => useSetupResult('codex'),
  useCodexCliAuth: () => authResult('codex'),
  useCodexPathDetection: () => pathResult('codex'),
}))
vi.mock('@/services/opencode-cli', () => ({
  useOpenCodeCliSetup: () => useSetupResult('opencode'),
  useOpenCodeCliAuth: () => authResult('opencode'),
  useOpenCodePathDetection: () => pathResult('opencode'),
}))
vi.mock('@/services/cursor-cli', () => ({
  getCursorInstallCommand: vi.fn().mockResolvedValue({
    command: '/bin/sh',
    args: ['-c', 'install-cursor'],
  }),
  useCursorCliStatus: () => {
    const setup = useSetupResult('cursor')
    return {
      data: setup.status,
      isLoading: false,
      refetch: setup.refetchStatus,
    }
  },
  useCursorCliAuth: () => authResult('cursor'),
  useCursorPathDetection: () => pathResult('cursor'),
}))
vi.mock('@/services/pi-cli', () => ({
  usePiCliSetup: () => useSetupResult('pi'),
  usePiCliAuth: () => authResult('pi'),
  usePiPathDetection: () => pathResult('pi'),
}))
vi.mock('@/services/commandcode-cli', () => ({
  useCommandCodeCliSetup: () => useSetupResult('commandcode'),
  useCommandCodeCliAuth: () => authResult('commandcode'),
  useCommandCodePathDetection: () => pathResult('commandcode'),
}))
vi.mock('@/services/grok-cli', () => ({
  useGrokCliSetup: () => useSetupResult('grok'),
  useGrokCliAuth: () => authResult('grok'),
  useGrokPathDetection: () => pathResult('grok'),
}))
vi.mock('@/services/kimi-cli', () => ({
  useKimiCliSetup: () => useSetupResult('kimi'),
  useKimiCliAuth: () => authResult('kimi'),
  useKimiPathDetection: () => pathResult('kimi'),
}))
vi.mock('@/services/devin-cli', () => ({
  useDevinCliSetup: () => useSetupResult('devin'),
  useDevinCliAuth: () => authResult('devin'),
  useDevinPathDetection: () => pathResult('devin'),
}))
vi.mock('@/services/antigravity-cli', () => ({
  useAntigravityCliSetup: () => useSetupResult('antigravity'),
  useAntigravityCliAuth: () => authResult('antigravity'),
  useAntigravityPathDetection: () => pathResult('antigravity'),
}))
vi.mock('@/services/muse-cli', () => ({
  useMuseCliSetup: () => useSetupResult('muse'),
  useMuseCliAuth: () => authResult('muse'),
  useMusePathDetection: () => pathResult('muse'),
}))
vi.mock('@/services/gh-cli', () => ({
  useGhCliSetup: () => useSetupResult('gh'),
  useGhCliAuth: () => authResult('gh'),
  useGhPathDetection: () => pathResult('gh'),
}))
vi.mock('@/services/glab-cli', () => ({
  useGlabCliSetup: () => useSetupResult('glab'),
  useGlabCliAuth: () => authResult('glab'),
  useGlabPathDetection: () => pathResult('glab'),
}))

vi.mock('@/services/prerequisites', () => ({
  checkSystemPrerequisites: mocks.checkSystemPrerequisites,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      wsl_mode_chosen: mocks.wslChosen,
      claude_cli_source: 'jean',
      codex_cli_source: 'jean',
      opencode_cli_source: 'jean',
      pi_cli_source: 'jean',
      commandcode_cli_source: 'jean',
      grok_cli_source: 'jean',
      kimi_cli_source: 'jean',
      devin_cli_source: 'jean',
      antigravity_cli_source: 'jean',
      muse_cli_source: 'jean',
      gh_cli_source: 'jean',
      glab_cli_source: 'jean',
    },
  }),
  usePatchPreferences: () => ({
    mutate: vi.fn(),
    mutateAsync: mocks.patchPreferencesAsync,
  }),
}))

vi.mock('./RemoteSetupStep', () => ({
  RemoteSetupStep: ({
    onComplete,
  }: {
    onComplete: (serverId: string) => void
  }) => <button onClick={() => onComplete('remote-1')}>Finish remote</button>,
}))

vi.mock('./WslSetupStep', () => ({
  WslSetupStep: () => <div>WSL step</div>,
}))

vi.mock('./CliSetupComponents', async importOriginal => {
  const original = await importOriginal<typeof CliSetupComponentsModule>()
  return {
    ...original,
    AuthLoginState: ({
      cliName,
      action = 'login',
      onComplete,
    }: {
      cliName: string
      action?: 'login' | 'install'
      onComplete: () => void
    }) => (
      <button onClick={onComplete}>
        Complete {cliName} {action}
      </button>
    ),
  }
})

function setCli(key: CliKey, state: Partial<Omit<CliMock, 'install'>>) {
  Object.assign(mocks.cli[key], state)
  mocks.version += 1
  for (const listener of mocks.listeners) listener()
}

async function chooseLocal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', { name: /This computer/i })
  )
}

async function goToSetup(user: ReturnType<typeof userEvent.setup>) {
  await chooseLocal(user)
  await user.click(await screen.findByRole('button', { name: 'Continue' }))
}

describe('OnboardingDialog', () => {
  beforeEach(() => {
    mocks.nativeApp = true
    mocks.serverWindows = false
    mocks.wslChosen = true
    for (const key of mocks.keys) {
      setCli(key, { installed: false, authenticated: false, pathFound: false })
      mocks.cli[key].install.mockReset()
    }
    // GitHub CLI ready by default.
    setCli('gh', { installed: true, authenticated: true, pathFound: true })
    mocks.patchPreferencesAsync.mockReset()
    mocks.patchPreferencesAsync.mockResolvedValue(undefined)
    mocks.checkSystemPrerequisites.mockReset()
    mocks.checkSystemPrerequisites.mockResolvedValue({
      gitInstalled: true,
      gitVersion: '2.50.0',
      nodeInstalled: true,
      nodeVersion: '24.0.0',
      npmInstalled: true,
      npmVersion: '11.0.0',
      platform: 'linux',
      automaticInstallSupported: false,
      automaticInstallCommand: null,
      manualInstallUrl: 'https://nodejs.org/en/download',
    })
    useUIStore.setState({
      onboardingOpen: true,
      onboardingStartStep: null,
      onboardingManuallyTriggered: true,
      onboardingDismissed: false,
      featureTourOpen: false,
    })
    useProjectsStore.setState({ addProjectDialogOpen: false })
  })

  it('offers every supported chat backend', () => {
    expect(AI_BACKENDS).toEqual(backendOptions.map(option => option.value))
  })

  describe('start', () => {
    it('starts with local vs remote cards in the native app', async () => {
      render(<OnboardingDialog />)
      expect(
        await screen.findByRole('button', { name: /This computer/i })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /Remote server/i })
      ).toBeInTheDocument()
    })

    it('starts at backends in Web Access', async () => {
      mocks.nativeApp = false
      render(<OnboardingDialog />)
      expect(
        await screen.findByText('Pick your AI backends')
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /This computer/i })
      ).not.toBeInTheDocument()
    })

    it('shows the WSL step on local Windows when not chosen yet', async () => {
      mocks.serverWindows = true
      mocks.wslChosen = false
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)
      expect(await screen.findByText('WSL step')).toBeInTheDocument()
    })
  })

  describe('backend detection', () => {
    it('preselects a CLI found on PATH and marks it Found', async () => {
      setCli('codex', { pathFound: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)

      const codex = await screen.findByRole('checkbox', { name: /Codex/ })
      expect(codex).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Claude/ })).not.toBeChecked()
      expect(
        within(codex.closest('label') as HTMLElement).getByText('Found')
      ).toBeInTheDocument()
    })

    it('preselects Claude when nothing is found', async () => {
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)
      expect(
        await screen.findByRole('checkbox', { name: /Claude/ })
      ).toBeChecked()
      expect(screen.queryByText('Found')).not.toBeInTheDocument()
    })
  })

  describe('setup checklist', () => {
    it('starts every missing install in parallel without user action', async () => {
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)
      await user.click(await screen.findByRole('checkbox', { name: /Codex/ }))
      await user.click(screen.getByRole('button', { name: 'Continue' }))

      await waitFor(() => {
        expect(mocks.cli.claude.install).toHaveBeenCalledWith(
          '2.0.0',
          expect.anything()
        )
        expect(mocks.cli.codex.install).toHaveBeenCalledWith(
          '2.0.0',
          expect.anything()
        )
      })
      expect(mocks.patchPreferencesAsync).toHaveBeenCalledWith({
        claude_cli_source: 'jean',
      })
      expect(mocks.patchPreferencesAsync).toHaveBeenCalledWith({
        codex_cli_source: 'jean',
      })
    })

    it('uses a CLI found on PATH instead of installing it', async () => {
      setCli('claude', { pathFound: true })
      mocks.patchPreferencesAsync.mockImplementation(async patch => {
        if (patch.claude_cli_source === 'path')
          setCli('claude', { installed: true })
      })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)

      await waitFor(() =>
        expect(mocks.patchPreferencesAsync).toHaveBeenCalledWith({
          claude_cli_source: 'path',
        })
      )
      expect(
        await screen.findByRole('button', { name: 'Complete Claude login' })
      ).toBeInTheDocument()
      expect(mocks.cli.claude.install).not.toHaveBeenCalled()
    })

    it('shows only one sign-in at a time', async () => {
      setCli('claude', { installed: true })
      setCli('codex', { installed: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)

      expect(
        await screen.findByRole('button', { name: 'Complete Claude login' })
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Complete Codex login' })
      ).not.toBeInTheDocument()

      const codexRow = screen.getByTestId('setup-row-codex')
      expect(within(codexRow).getByText('Waiting')).toBeInTheDocument()
      await user.click(
        within(codexRow).getByRole('button', { name: 'Sign in' })
      )

      expect(
        screen.getByRole('button', { name: 'Complete Codex login' })
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Complete Claude login' })
      ).not.toBeInTheDocument()
    })

    it('shows "Not signed in yet." when sign-in did not finish', async () => {
      setCli('claude', { installed: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)

      await user.click(
        await screen.findByRole('button', { name: 'Complete Claude login' })
      )
      expect(await screen.findByText('Not signed in yet.')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Retry' }))
      expect(
        await screen.findByRole('button', { name: 'Complete Claude login' })
      ).toBeInTheDocument()
    })

    it('shows an inline error when install fails and retries it', async () => {
      mocks.cli.claude.install.mockImplementation(
        (_version: string, options?: { onError?: (error: Error) => void }) =>
          options?.onError?.(new Error('npm failed\nfull install log'))
      )
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)

      const alert = await screen.findByRole('alert')
      expect(within(alert).getByText('npm failed')).toBeInTheDocument()
      expect(mocks.cli.claude.install).toHaveBeenCalledTimes(1)

      await user.click(within(alert).getByRole('button', { name: 'Retry' }))
      await waitFor(() =>
        expect(mocks.cli.claude.install).toHaveBeenCalledTimes(2)
      )
    })

    it('enables Finish when an AI backend is ready even if GitHub CLI is not', async () => {
      setCli('claude', { installed: true, authenticated: true })
      setCli('gh', { installed: true, authenticated: false })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)

      expect(
        await screen.findByText(/GitHub CLI is optional/)
      ).toBeInTheDocument()
      const finish = await screen.findByRole('button', { name: 'Finish' })
      expect(finish).toBeEnabled()

      const ghRow = screen.getByTestId('setup-row-gh')
      await user.click(within(ghRow).getByRole('button', { name: 'Skip' }))
      expect(screen.queryByTestId('setup-row-gh')).not.toBeInTheDocument()

      await user.click(finish)
      expect(await screen.findByText("You're ready")).toBeInTheDocument()
    })

    it('shows optional GitLab CLI and still finishes with only an AI backend', async () => {
      setCli('claude', { installed: true, authenticated: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)

      expect(
        await screen.findByText(/GitLab CLI is optional/)
      ).toBeInTheDocument()
      const finish = await screen.findByRole('button', { name: 'Finish' })
      expect(finish).toBeEnabled()

      const glabRow = screen.getByTestId('setup-row-glab')
      expect(within(glabRow).getByText('optional')).toBeInTheDocument()
      expect(within(glabRow).getByText('Beta')).toHaveClass('bg-warning/10')
      expect(
        within(screen.getByTestId('setup-row-gh')).queryByText('Beta')
      ).toBeNull()
      await user.click(within(glabRow).getByRole('button', { name: 'Skip' }))
      expect(screen.queryByTestId('setup-row-glab')).not.toBeInTheDocument()

      await user.click(finish)
      expect(await screen.findByText("You're ready")).toBeInTheDocument()
    })
  })

  describe('Devin', () => {
    it('marks Devin as beta in the picker, setup row, and ready list', async () => {
      setCli('devin', { installed: true, authenticated: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)

      const devin = await screen.findByRole('checkbox', { name: /Devin/ })
      expect(
        within(devin.closest('label') as HTMLElement).getByText('Beta')
      ).toHaveClass('bg-warning/10')

      await user.click(screen.getByRole('button', { name: 'Continue' }))

      const row = await screen.findByTestId('setup-row-devin')
      expect(within(row).getByText('Devin')).toBeInTheDocument()
      expect(within(row).getByText('Beta')).toHaveClass('bg-warning/10')
      expect(row).toHaveAttribute('aria-label', 'Devin (Beta)')

      await user.click(screen.getByRole('button', { name: 'Finish' }))
      expect(await screen.findByText("You're ready")).toBeInTheDocument()
      expect(screen.getByText('Beta')).toHaveClass('bg-warning/10')
    })
  })

  describe('Muse', () => {
    it('keeps Muse not ready while installed but signed out', async () => {
      setCli('muse', { installed: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)

      const muse = await screen.findByRole('checkbox', { name: /Muse/ })
      expect(muse).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /Claude/ })).not.toBeChecked()
      await user.click(screen.getByRole('button', { name: 'Continue' }))

      expect(
        await screen.findByRole('button', { name: 'Complete Muse login' })
      ).toBeInTheDocument()
      const finish = screen.getByRole('button', { name: 'Finish' })
      expect(finish).toBeDisabled()
      expect(mocks.cli.muse.install).not.toHaveBeenCalled()

      act(() => setCli('muse', { authenticated: true }))
      await waitFor(() => expect(finish).toBeEnabled())
    })

    it('saves Muse as default backend and magic prompt backend when ready', async () => {
      setCli('muse', { installed: true, authenticated: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await goToSetup(user)
      await user.click(await screen.findByRole('button', { name: 'Finish' }))
      await screen.findByText("You're ready")
      await user.click(screen.getByRole('button', { name: /Add a project/ }))

      await waitFor(() =>
        expect(mocks.patchPreferencesAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            default_backend: 'muse',
            magic_models_auto_initialized: true,
            magic_prompt_backends: expect.objectContaining({
              investigate_issue_backend: 'muse',
              commit_message_backend: 'muse',
              code_review_backend: 'muse',
            }),
            magic_prompt_models: expect.objectContaining({
              investigate_issue_model: 'muse/default',
              commit_message_model: 'muse/default',
              code_review_model: 'muse/default',
            }),
          })
        )
      )
    })

    it('installs a picked Muse as a Jean-managed CLI', async () => {
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await chooseLocal(user)
      await user.click(await screen.findByRole('checkbox', { name: /Claude/ }))
      await user.click(screen.getByRole('checkbox', { name: /Muse/ }))
      await user.click(screen.getByRole('button', { name: 'Continue' }))

      await waitFor(() =>
        expect(mocks.cli.muse.install).toHaveBeenCalledWith(
          '2.0.0',
          expect.anything()
        )
      )
      expect(mocks.patchPreferencesAsync).toHaveBeenCalledWith({
        muse_cli_source: 'jean',
      })
      expect(mocks.cli.claude.install).not.toHaveBeenCalled()
    })
  })

  describe('success', () => {
    async function reachSuccess(user: ReturnType<typeof userEvent.setup>) {
      setCli('codex', { installed: true, authenticated: true })
      render(<OnboardingDialog />)
      await goToSetup(user)
      await user.click(await screen.findByRole('button', { name: 'Finish' }))
      await screen.findByText("You're ready")
    }

    it('"Add a project" saves the default backend, then opens add project', async () => {
      const user = userEvent.setup()
      await reachSuccess(user)
      await user.click(screen.getByRole('button', { name: /Add a project/ }))

      await waitFor(() =>
        expect(useProjectsStore.getState().addProjectDialogOpen).toBe(true)
      )
      expect(mocks.patchPreferencesAsync).toHaveBeenCalledWith(
        expect.objectContaining({ default_backend: 'codex' })
      )
      const ui = useUIStore.getState()
      expect(ui.onboardingOpen).toBe(false)
      expect(ui.onboardingDismissed).toBe(true)
      expect(ui.featureTourOpen).toBe(false)
    })

    it('"Take the tour" opens the feature tour', async () => {
      const user = userEvent.setup()
      await reachSuccess(user)
      await user.click(screen.getByRole('button', { name: /Take the tour/ }))

      await waitFor(() =>
        expect(useUIStore.getState().featureTourOpen).toBe(true)
      )
      expect(useUIStore.getState().onboardingOpen).toBe(false)
    })
  })

  describe('remote', () => {
    it('continues to backends on the new remote server', async () => {
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await user.click(
        await screen.findByRole('button', { name: /Remote server/i })
      )
      expect(
        await screen.findByText(/Jean installs itself over SSH/i)
      ).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Finish remote' }))

      expect(
        await screen.findByText(/Installs on the remote server/i)
      ).toBeInTheDocument()
      expect(
        screen.getByRole('checkbox', { name: /Claude/ })
      ).toBeInTheDocument()
      await waitFor(() =>
        expect(mocks.checkSystemPrerequisites).toHaveBeenLastCalledWith(
          'remote-1'
        )
      )
    })

    it('skips to done when the remote is already ready', async () => {
      setCli('claude', { installed: true, authenticated: true })
      const user = userEvent.setup()
      render(<OnboardingDialog />)
      await user.click(
        await screen.findByRole('button', { name: /Remote server/i })
      )
      await user.click(
        await screen.findByRole('button', { name: 'Finish remote' })
      )

      expect(await screen.findByText("You're ready")).toBeInTheDocument()
      expect(
        screen.getByText('Jean is set up on the remote server.')
      ).toBeInTheDocument()
    })
  })
})
