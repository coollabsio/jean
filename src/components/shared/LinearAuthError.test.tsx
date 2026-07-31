import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LinearAuthError } from './LinearAuthError'

vi.mock('@/store/ui-store', () => ({
  useUIStore: (
    selector: (state: { openPreferencesPane: () => void }) => unknown
  ) => selector({ openPreferencesPane: vi.fn() }),
}))

describe('LinearAuthError', () => {
  it('renders the unconfigured state matching the Sentry empty-state pattern', () => {
    render(<LinearAuthError />)

    expect(
      screen.getByText('Linear access is not configured')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Add and test a personal API key/i)
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Integrations' })
    ).toBeInTheDocument()
  })
})
