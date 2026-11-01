import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitStatusBadges } from './git-status-badges'

function renderBadges(
  behindCount: number,
  unpushedCount: number,
  isSyncing = false
) {
  render(
    <TooltipProvider>
      <GitStatusBadges
        behindCount={behindCount}
        unpushedCount={unpushedCount}
        diffAdded={0}
        diffRemoved={0}
        isSyncing={isSyncing}
      />
    </TooltipProvider>
  )
}

describe('GitStatusBadges sync button', () => {
  it.each([
    [3, 0, 'Pull'],
    [0, 5, 'Push'],
    [64, 1383, 'Sync'],
  ])('behind %i, unpushed %i shows %s', (behind, unpushed, label) => {
    renderBadges(behind, unpushed)
    const button = screen.getByRole('button', { name: label })
    expect(button.textContent).toBe('')
    expect(button).toBeEnabled()
  })

  it('shows a spinner and blocks clicks while syncing', () => {
    renderBadges(3, 5, true)
    const button = screen.getByRole('button', { name: 'Sync' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders nothing when in sync and clean', () => {
    const { container } = render(
      <GitStatusBadges
        behindCount={0}
        unpushedCount={0}
        diffAdded={0}
        diffRemoved={0}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
