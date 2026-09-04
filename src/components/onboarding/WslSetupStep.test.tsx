import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { WslSetupStep } from './WslSetupStep'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
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
    expect(
      screen.getByText(/Cursor runs without OS sandboxing/)
    ).toBeInTheDocument()
  })
})
