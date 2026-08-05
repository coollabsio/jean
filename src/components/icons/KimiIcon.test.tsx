import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KimiIcon } from './KimiIcon'

describe('KimiIcon', () => {
  it('renders the official Moonshot K-only mark', () => {
    render(<KimiIcon data-testid="kimi-icon" />)

    const icon = screen.getByTestId('kimi-icon')
    const paths = icon.querySelectorAll('path')

    expect(icon).toHaveAttribute('viewBox', '0 0 24 25')
    expect(paths).toHaveLength(2)
    expect(paths[0]).toHaveAttribute('fill', '#1783FF')
    expect(paths[0]).toHaveAttribute(
      'd',
      'M21.72 0.94C22.95 0.94 23.95 1.94 23.95 3.17C23.95 4.4 22.95 5.4 21.72 5.4H19.75C19.6 5.4 19.49 5.28 19.49 5.14V3.17C19.49 1.94 20.49 0.94 21.72 0.94Z'
    )
    expect(paths[1]).toHaveAttribute('fill', 'currentColor')
    expect(paths[1]).toHaveAttribute(
      'd',
      'M9.39 13.95L17.82 5.59C17.98 5.43 17.89 5.12 17.68 5.12H13.14C13.14 5.12 13.04 5.14 13 5.18L3.92 14.19C3.78 14.33 3.57 14.21 3.57 13.98V5.39C3.57 5.24 3.47 5.12 3.35 5.12H0.22C0.1 5.12 0 5.24 0 5.39V23.92C0 24.07 0.1 24.19 0.22 24.19H3.35C3.47 24.19 3.57 24.07 3.57 23.92V20.14C3.57 20.06 3.6 19.98 3.65 19.93L6.47 17.14C6.54 17.07 6.63 17.06 6.71 17.11L14.24 22.65C15.47 23.48 16.85 23.99 18.25 24.14C18.37 24.15 18.48 24.03 18.48 23.87V20.31C18.48 20.17 18.4 20.06 18.29 20.05C17.47 19.92 16.66 19.6 15.94 19.11L9.42 14.39C9.28 14.3 9.27 14.07 9.39 13.95Z'
    )
  })
})
