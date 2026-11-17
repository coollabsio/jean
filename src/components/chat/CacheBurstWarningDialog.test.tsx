import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { CacheBurstWarningDialog } from './CacheBurstWarningDialog'

describe('CacheBurstWarningDialog', () => {
  it('does not render when closed', () => {
    render(
      <CacheBurstWarningDialog
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(
      screen.queryByText(/changing effort may reset your prompt cache/i)
    ).toBeNull()
  })

  it('cancels without changing the effort level', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn()
    render(
      <CacheBurstWarningDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('reports the don’t-warn-again choice on confirm', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <CacheBurstWarningDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    await user.click(
      screen.getByRole('checkbox', { name: /don.t warn me again/i })
    )
    await user.click(screen.getByRole('button', { name: 'Change effort' }))

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('defaults to keeping the warning enabled', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <CacheBurstWarningDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Change effort' }))

    expect(onConfirm).toHaveBeenCalledWith(false)
  })
})
