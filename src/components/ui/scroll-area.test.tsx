import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { ScrollArea } from './scroll-area'

describe('ScrollArea', () => {
  it('applies viewportClassName to the viewport element', () => {
    render(
      <ScrollArea viewportClassName="overflow-x-auto touch-pan-x">
        <div>content</div>
      </ScrollArea>
    )

    const viewport = screen.getByText('content').parentElement
    expect(viewport).toHaveAttribute('data-slot', 'scroll-area-viewport')
    expect(viewport).toHaveClass('overflow-x-auto')
    expect(viewport).toHaveClass('touch-pan-x')
  })
})
