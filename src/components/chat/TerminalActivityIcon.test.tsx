import { render, screen } from '@/test/test-utils'
import { describe, expect, it } from 'vitest'
import { TerminalActivityIcon } from './TerminalActivityIcon'

describe('TerminalActivityIcon', () => {
  it('does not render a badge for an inactive terminal', () => {
    render(<TerminalActivityIcon active={false} className="h-4 w-4" />)

    expect(screen.queryByTestId('terminal-active-badge')).toBeNull()
  })

  it('renders a live-PTY badge for an active terminal', () => {
    render(<TerminalActivityIcon active className="h-4 w-4" />)

    expect(screen.getByTestId('terminal-active-badge')).toHaveClass(
      'bg-emerald-500'
    )
  })
})
