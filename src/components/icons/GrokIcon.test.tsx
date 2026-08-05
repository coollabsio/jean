import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GrokIcon } from './GrokIcon'

describe('GrokIcon', () => {
  it('renders the xAI Grok mark instead of the placeholder hexagon', () => {
    render(<GrokIcon data-testid="grok-icon" />)

    const icon = screen.getByTestId('grok-icon')
    const paths = icon.querySelectorAll('path')

    expect(icon).toHaveAttribute('viewBox', '0 0 34 32')
    expect(icon).not.toHaveAttribute('stroke')
    expect(paths).toHaveLength(2)
    expect(paths[0]).toHaveAttribute(
      'd',
      'M13.37 20.54L24.46 12.35C25 11.95 25.78 12.11 26.03 12.73C27.4 16.02 26.79 19.97 24.08 22.69C21.37 25.4 17.59 25.99 14.15 24.64L10.38 26.38C15.78 30.08 22.34 29.17 26.44 25.06C29.69 21.81 30.7 17.37 29.76 13.37L29.77 13.38C28.4 7.5 30.1 5.15 33.59 0.34C33.67 0.23 33.75 0.12 33.83 0L29.25 4.59V4.58L13.37 20.54'
    )
    paths.forEach(path => {
      expect(path).toHaveAttribute('fill', 'currentColor')
    })
  })
})
