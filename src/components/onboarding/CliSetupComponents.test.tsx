import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  AuthLoginState,
  normalizeManualCliVersionInput,
  SetupState,
} from './CliSetupComponents'

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
