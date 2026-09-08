import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { WslSetupStep } from './WslSetupStep'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/services/preferences', () => ({
  usePatchPreferences: () => ({
    mutateAsync: vi.fn(),
  }),
}))

describe('WslSetupStep', () => {
  it('labels the WSL onboarding option as beta', () => {
    render(<WslSetupStep onComplete={vi.fn()} />)

    expect(screen.getByText('WSL')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('explains that native Windows Cursor uses allowlist mode', () => {
    render(<WslSetupStep onComplete={vi.fn()} />)

    expect(
      screen.getByText(/Native Windows uses Cursor's allowlist mode/)
    ).toBeInTheDocument()
  })

  it('hides the native Cursor sandbox note when WSL is selected', async () => {
    const user = userEvent.setup()
    render(<WslSetupStep onComplete={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /WSL/ }))

    expect(
      screen.queryByText(/Native Windows uses Cursor's allowlist mode/)
    ).not.toBeInTheDocument()
  })
})
