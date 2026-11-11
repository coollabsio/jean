import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBanner } from './ErrorBanner'

const openExternal = vi.fn()
vi.mock('@/lib/platform', () => ({
  openExternal: (url: string) => openExternal(url),
}))

const TERMS_ERROR =
  "API Error: 400 We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue."

describe('ErrorBanner Claude terms error', () => {
  it('names the accounts, opens claude.ai and retries', () => {
    const onRetry = vi.fn()
    render(
      <ErrorBanner
        error={TERMS_ERROR}
        onDismiss={vi.fn()}
        termsAccountEmails={['a@example.com', 'b@example.com']}
        onRetry={onRetry}
      />
    )

    expect(screen.getByText('Accept the updated Claude terms')).toBeTruthy()
    expect(
      screen.getByText(
        /Sign in to claude\.ai as a@example\.com or b@example\.com/
      )
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open claude.ai' }))
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows "Retrying shortly" instead of Retry once armed', () => {
    render(
      <ErrorBanner
        error={TERMS_ERROR}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
        isAutoResumeArmed
      />
    )
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByText('Retrying shortly')).toBeTruthy()
  })

  it('keeps the generic card for other errors', () => {
    render(<ErrorBanner error="API Error: 500" onDismiss={vi.fn()} />)
    expect(screen.getByText('Request failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open claude.ai' })).toBeNull()
  })
})
