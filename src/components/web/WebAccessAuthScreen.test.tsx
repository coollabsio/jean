import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { WebAccessAuthScreen } from './WebAccessAuthScreen'

describe('WebAccessAuthScreen', () => {
  it('lets the user submit an access token from the browser UI', async () => {
    const onTokenSubmit = vi.fn()

    render(
      <WebAccessAuthScreen
        authError="Enter the access token."
        onTokenSubmit={onTokenSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText(/access token/i), {
      target: { value: 'secret-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(onTokenSubmit).toHaveBeenCalledWith('secret-token')

    // Submitting reloads the page; the button stays locked until then so the
    // user gets feedback and cannot double-submit.
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled()
  })

  it('does not submit blank tokens', async () => {
    const onTokenSubmit = vi.fn()

    render(
      <WebAccessAuthScreen
        authError="Enter the access token."
        onTokenSubmit={onTokenSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText(/access token/i), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(onTokenSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/enter the access token/i)).toBeInTheDocument()
  })

  it('greets a first visit instead of reporting a failure', () => {
    render(
      <WebAccessAuthScreen
        authError="Enter the access token from Jean's Web Access settings."
        reason="signed-out"
        onTokenSubmit={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: /sign in to jean/i })
    ).toBeInTheDocument()
    // A first visit has failed at nothing — no alert should be raised.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('flags the field when the server refused the token', () => {
    render(
      <WebAccessAuthScreen
        authError="That access token was refused."
        reason="rejected"
        onTokenSubmit={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/refused/i)
    expect(screen.getByLabelText(/access token/i)).toHaveAttribute(
      'aria-invalid',
      'true'
    )
  })

  it('clears the refused-token alert once the user edits the field', () => {
    render(
      <WebAccessAuthScreen
        authError="That access token was refused."
        reason="rejected"
        onTokenSubmit={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText(/access token/i), {
      target: { value: 'fresh-token' },
    })

    // The alert described the previous submission — a fresh entry has not
    // failed at anything yet.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/access token/i)).toHaveAttribute(
      'aria-invalid',
      'false'
    )
  })

  it('always offers the token form — submitting reloads, which is how a lost connection recovers', () => {
    render(
      <WebAccessAuthScreen
        authError="Connection to the server was lost."
        onTokenSubmit={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled()
  })
})
