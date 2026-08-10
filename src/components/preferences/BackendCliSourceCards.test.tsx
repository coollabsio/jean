import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BackendCliSourceCards } from './BackendCliSourceCards'

describe('BackendCliSourceCards', () => {
  it('shows managed and detected PATH choices', () => {
    render(
      <BackendCliSourceCards
        value="jean"
        onValueChange={vi.fn()}
        backendName="Codex CLI"
        path="/usr/local/bin/codex"
        pathVersion="1.2.3"
        pathFound
      />
    )

    expect(screen.getByText('Jean managed')).toBeInTheDocument()
    expect(screen.getByText('System PATH')).toBeInTheDocument()
    expect(
      screen.getByText(/\/usr\/local\/bin\/codex · 1.2.3/)
    ).toBeInTheDocument()
  })

  it('selects PATH and disables it when it is not detected', () => {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <BackendCliSourceCards
        value="jean"
        onValueChange={onValueChange}
        backendName="Claude CLI"
        path="/usr/bin/claude"
        pathFound
      />
    )
    const pathLabel = screen.getByText('System PATH').closest('label')
    expect(pathLabel).not.toBeNull()
    if (pathLabel) fireEvent.click(pathLabel)
    expect(onValueChange).toHaveBeenCalledWith('path')

    rerender(
      <BackendCliSourceCards
        value="jean"
        onValueChange={onValueChange}
        backendName="Claude CLI"
        path={null}
        pathFound={false}
      />
    )
    expect(screen.getAllByRole('radio')[1]).toBeDisabled()
    expect(
      screen.getByText('No Claude CLI was found on PATH.')
    ).toBeInTheDocument()
  })
})
