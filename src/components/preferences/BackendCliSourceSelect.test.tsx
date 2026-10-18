import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BackendCliSourceSelect } from './BackendCliSourceSelect'

beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

describe('BackendCliSourceSelect', () => {
  it('shows managed and detected PATH choices', async () => {
    const user = userEvent.setup()
    render(
      <BackendCliSourceSelect
        value="jean"
        onValueChange={vi.fn()}
        backendName="Codex CLI"
        path="/usr/local/bin/codex"
        pathVersion="1.2.3"
        pathFound
      />
    )

    expect(screen.getByRole('combobox')).toHaveTextContent('Jean managed')
    await user.click(screen.getByRole('combobox'))
    expect(
      screen.getByRole('option', { name: 'System PATH (1.2.3)' })
    ).toHaveAttribute('title', '/usr/local/bin/codex')
  })

  it('selects PATH and disables it when it is not detected', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { rerender } = render(
      <BackendCliSourceSelect
        value="jean"
        onValueChange={onValueChange}
        backendName="Claude CLI"
        path="/usr/bin/claude"
        pathFound
      />
    )
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'System PATH' }))
    expect(onValueChange).toHaveBeenCalledWith('path')

    rerender(
      <BackendCliSourceSelect
        value="jean"
        onValueChange={onValueChange}
        backendName="Claude CLI"
        path={null}
        pathFound={false}
      />
    )
    await user.click(screen.getByRole('combobox'))
    expect(
      screen.getByRole('option', { name: 'System PATH (not found)' })
    ).toHaveAttribute('aria-disabled', 'true')
  })
})
