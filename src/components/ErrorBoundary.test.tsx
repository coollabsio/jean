import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from './ErrorBoundary'

vi.mock('@/lib/recovery', () => ({ saveCrashState: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function BrokenChild(): never {
  throw new Error('Visible crash details')
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows error details in production builds', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <ErrorBoundary>
        <BrokenChild />
      </ErrorBoundary>
    )

    expect(screen.getByText('Error Details')).toBeInTheDocument()
    expect(screen.getAllByText(/Visible crash details/)).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
