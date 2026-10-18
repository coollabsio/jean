import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthLoginState,
  normalizeManualCliVersionInput,
  SetupState,
} from './CliSetupComponents'

vi.mock('@/components/chat/StandaloneTerminalSurface', () => ({
  StandaloneTerminalSurface: ({ terminalId }: { terminalId: string }) => (
    <div
      data-testid="standalone-terminal-surface"
      data-terminal-id={terminalId}
    />
  ),
}))

type OutputHandler = (event: {
  payload: { terminal_id: string; data: string }
}) => void

const transportMocks = vi.hoisted(() => ({
  handlers: new Set<OutputHandler>(),
}))
const stoppedMocks = vi.hoisted(() => ({
  callbacks: new Map<
    string,
    (exitCode: number | null, signal: string | null) => void
  >(),
}))
const openExternalMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const copyToClipboardMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
)
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async (event: string, handler: OutputHandler) => {
    if (event !== 'terminal:output') return () => undefined
    transportMocks.handlers.add(handler)
    return () => transportMocks.handlers.delete(handler)
  }),
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: vi.fn(),
  setOnStopped: (
    terminalId: string,
    callback?: (exitCode: number | null, signal: string | null) => void
  ) => {
    if (callback) stoppedMocks.callbacks.set(terminalId, callback)
    else stoppedMocks.callbacks.delete(terminalId)
  },
}))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openExternal: openExternalMock,
}))

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copyToClipboardMock }))

vi.mock('sonner', () => ({ toast: toastMock }))

function emitOutput(terminalId: string, data: string) {
  act(() => {
    for (const handler of transportMocks.handlers) {
      handler({ payload: { terminal_id: terminalId, data } })
    }
  })
}

beforeEach(() => {
  transportMocks.handlers.clear()
  stoppedMocks.callbacks.clear()
  vi.clearAllMocks()
})

describe('manual CLI version helpers', () => {
  it('normalizes whitespace and optional v prefix', () => {
    expect(normalizeManualCliVersionInput(' v2.1.98 ')).toBe('2.1.98')
    expect(normalizeManualCliVersionInput('2.1.98')).toBe('2.1.98')
  })
})

describe('SetupState manual version check', () => {
  it('requires checking a manual version against the source before installing it', async () => {
    const onVersionChange = vi.fn()
    const onInstall = vi.fn()
    const onCheckManualVersion = vi.fn().mockResolvedValue(true)

    render(
      <SetupState
        cliName="Claude CLI"
        versions={[{ version: '2.1.98', prerelease: false }]}
        selectedVersion="2.1.98"
        isLoading={false}
        onVersionChange={onVersionChange}
        onInstall={onInstall}
        onCheckManualVersion={onCheckManualVersion}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('2.1.98'), {
      target: { value: 'v1.2.3' },
    })

    const installButton = screen.getByRole('button', { name: /install/i })
    expect(installButton).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Check' }))

    await waitFor(() => {
      expect(onCheckManualVersion).toHaveBeenCalledWith('1.2.3')
      expect(onVersionChange).toHaveBeenCalledWith('1.2.3')
      expect(installButton).toBeEnabled()
    })
  })

  it('keeps install disabled when the source does not have the manual version', async () => {
    const onVersionChange = vi.fn()
    const onCheckManualVersion = vi.fn().mockResolvedValue(false)

    render(
      <SetupState
        cliName="Claude CLI"
        versions={[{ version: '2.1.98', prerelease: false }]}
        selectedVersion="2.1.98"
        isLoading={false}
        onVersionChange={onVersionChange}
        onInstall={vi.fn()}
        onCheckManualVersion={onCheckManualVersion}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('2.1.98'), {
      target: { value: '9.9.9' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check' }))

    await screen.findByText(/Version not found/i)
    expect(onVersionChange).not.toHaveBeenCalledWith('9.9.9')
    expect(screen.getByRole('button', { name: /install/i })).toBeDisabled()
  })
})

describe('AuthLoginState completion', () => {
  it('renders the shared terminal surface for login', () => {
    render(
      <AuthLoginState
        cliName="Cursor CLI"
        terminalId="cursor-login-test"
        command="agent"
        commandArgs={['login']}
        onComplete={vi.fn()}
      />
    )

    expect(screen.getByTestId('standalone-terminal-surface')).toHaveAttribute(
      'data-terminal-id',
      'cursor-login-test'
    )
    expect(screen.getByText('Sign in to Cursor CLI')).toBeTruthy()
    expect(screen.getByText(/Use ↑\/↓ and Enter/)).toBeTruthy()
  })

  it('only advances once when completion is clicked repeatedly', () => {
    const onComplete = vi.fn()

    render(
      <AuthLoginState
        cliName="Cursor CLI"
        terminalId="cursor-login-test"
        command="agent"
        commandArgs={['login']}
        onComplete={onComplete}
      />
    )

    const completeButton = screen.getByRole('button', {
      name: "I've Completed Login",
    })
    fireEvent.click(completeButton)
    fireEvent.click(completeButton)

    expect(onComplete).toHaveBeenCalledOnce()
  })
})

describe('AuthLoginState sign-in detection', () => {
  function renderGhLogin() {
    return render(
      <AuthLoginState
        cliName="GitHub CLI"
        terminalId="gh-login-test"
        command="gh"
        commandArgs={['auth', 'login']}
        onComplete={vi.fn()}
      />
    )
  }

  it('shows the open button and code chip once output contains them', async () => {
    renderGhLogin()
    await waitFor(() => expect(transportMocks.handlers.size).toBe(1))

    expect(screen.queryByText('Open sign-in page')).toBeNull()

    emitOutput(
      'gh-login-test',
      '\x1b[0;33m!\x1b[0m First copy your one-time code: 1A2B-3C4D\r\n'
    )
    emitOutput(
      'gh-login-test',
      'Open this URL to continue in your web browser: https://github.com/login/device\r\n'
    )

    fireEvent.click(
      await screen.findByRole('button', { name: /Open sign-in page/ })
    )
    expect(openExternalMock).toHaveBeenCalledWith(
      'https://github.com/login/device'
    )

    expect(screen.getByTestId('sign-in-code')).toHaveTextContent('1A2B-3C4D')
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(copyToClipboardMock).toHaveBeenCalledWith('1A2B-3C4D')
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Code copied')
    )
  })

  it('ignores output from other terminals', async () => {
    renderGhLogin()
    await waitFor(() => expect(transportMocks.handlers.size).toBe(1))

    emitOutput('other-terminal', 'https://github.com/login/device')
    expect(screen.queryByText('Open sign-in page')).toBeNull()
  })

  it('shows helper text when only a URL is found', async () => {
    renderGhLogin()
    await waitFor(() => expect(transportMocks.handlers.size).toBe(1))

    emitOutput('gh-login-test', 'Visit https://claude.ai/oauth/authorize?x=1')
    expect(
      await screen.findByText(/Approve in your browser/)
    ).toBeInTheDocument()
    expect(screen.queryByTestId('sign-in-code')).toBeNull()
  })

  it('hides the terminal without unmounting it', () => {
    renderGhLogin()

    const surface = screen.getByTestId('standalone-terminal-surface')
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' }))

    expect(screen.getByTestId('standalone-terminal-surface')).toBe(surface)
    expect(surface.parentElement).toHaveClass('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }))
    expect(surface.parentElement).not.toHaveClass('hidden')
  })

  it('shows an inline error with retry on non-zero exit', () => {
    const onRetry = vi.fn()
    render(
      <AuthLoginState
        cliName="GitHub CLI"
        terminalId="gh-login-test"
        command="gh"
        onComplete={vi.fn()}
        onRetry={onRetry}
      />
    )

    act(() => stoppedMocks.callbacks.get('gh-login-test')?.(1, null))

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sign-in did not finish (exit 1).'
    )
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
