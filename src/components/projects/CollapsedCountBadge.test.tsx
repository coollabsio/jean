import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { CollapsedCountBadge } from './CollapsedCountBadge'

describe('CollapsedCountBadge', () => {
  it('shows a singular accessible label for one child', () => {
    render(
      <CollapsedCountBadge count={1} label="sessions" isExpanded={false} />
    )

    expect(screen.getByRole('status', { name: '1 session' })).toHaveTextContent(
      '1'
    )
  })

  it('hides zero counts and expanded counts', () => {
    const { rerender } = render(
      <CollapsedCountBadge count={0} label="items" isExpanded={false} />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    rerender(<CollapsedCountBadge count={4} label="items" isExpanded />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
